"""Local multi-language translation using Meta NLLB.

Loads facebook/nllb-200-distilled-600M once on first use and keeps it in memory.
Translations are cached via services.sentence_cache just like the cloud path.
"""
from __future__ import annotations

import logging
import os
import re
import threading
from typing import Optional

import torch

logger = logging.getLogger(__name__)

# Lazy-loaded model singletons
_model_lock = threading.Lock()
_tokenizer = None
_model = None
_model_name: Optional[str] = None
_device: str = "cpu"

# NLLB language codes for the supported target languages
_NLLB_LANG_CODES = {
    "zh": "zho_Hans",      # Simplified Chinese
    "zh-TW": "zho_Hant",   # Traditional Chinese
    "ja": "jpn_Jpan",
    "ko": "kor_Hang",
    "fr": "fra_Latn",
    "de": "deu_Latn",
    "es": "spa_Latn",
    "pt": "por_Latn",
    "ru": "rus_Cyrl",
    "it": "ita_Latn",
}


def _get_config():
    from services.config import get_setting
    return {
        "model": get_setting("LOCAL_TRANSLATE_MODEL", "facebook/nllb-200-distilled-600M"),
    }


def _load_model():
    """Lazy-load NLLB tokenizer and model (thread-safe)."""
    global _tokenizer, _model, _model_name, _device
    if _model is not None:
        return True

    with _model_lock:
        if _model is not None:
            return True

        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        cfg = _get_config()
        model_name = cfg["model"]
        logger.info("Loading local translation model: %s", model_name)

        try:
            os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
            tokenizer = AutoTokenizer.from_pretrained(model_name)
            model = AutoModelForSeq2SeqLM.from_pretrained(model_name)
            device = "cuda" if torch.cuda.is_available() else "cpu"
            model.to(device)
            model.eval()

            _tokenizer = tokenizer
            _model = model
            _model_name = model_name
            _device = device
            logger.info("Local translation model loaded on %s", device)
            return True
        except Exception as e:
            logger.exception("Failed to load local translation model: %s", e)
            raise


def is_available() -> bool:
    """Check if the required libraries are installed."""
    try:
        import torch  # noqa: F401
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer  # noqa: F401
        return True
    except ImportError:
        return False


def _normalize_text(text: str) -> str:
    """Light normalization for subtitle sentences."""
    text = text.strip()
    # Replace multiple spaces
    text = re.sub(r"\s+", " ", text)
    return text


def _nllb_target_code(field: str) -> str:
    """Map our subtitle field code to NLLB language code."""
    return _NLLB_LANG_CODES.get(field, "zho_Hans")


def _target_bos_token_id(target_code: str) -> int:
    """Resolve the forced BOS token id for a target language.

    transformers >= 4.57 dropped NllbTokenizer.lang_code_to_id; the language
    tag is now a normal special token resolved via convert_tokens_to_ids.
    """
    legacy = getattr(_tokenizer, "lang_code_to_id", None)
    if isinstance(legacy, dict) and target_code in legacy:
        return legacy[target_code]
    return _tokenizer.convert_tokens_to_ids(target_code)


def _translate_batch(sentences: list[str], target_field: str, source_lang: str = "en") -> list[str]:
    """Translate a batch of sentences using NLLB."""
    _load_model()
    assert _tokenizer is not None and _model is not None

    target_code = _nllb_target_code(target_field)
    source_code = "eng_Latn" if source_lang.lower() == "en" else source_lang

    results = []
    for src in sentences:
        src = _normalize_text(src)
        if not src:
            results.append("")
            continue

        try:
            inputs = _tokenizer(
                f"{source_code} {src}",
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=512,
            )
            inputs = {k: v.to(_device) for k, v in inputs.items()}

            with torch.no_grad():
                translated_tokens = _model.generate(
                    **inputs,
                    forced_bos_token_id=_target_bos_token_id(target_code),
                    max_length=512,
                    num_beams=4,
                    early_stopping=True,
                )

            translated = _tokenizer.batch_decode(
                translated_tokens, skip_special_tokens=True
            )[0]
            results.append(translated.strip())
        except Exception as e:
            logger.warning("NLLB translation failed for sentence: %s", e)
            results.append("")

    return results


def translate_batch(
    sentences: list[str],
    target_lang: str,
    source_lang: str = "en",
) -> list[str]:
    """Public synchronous translation entry."""
    from services.translate import _TARGET_LANG_MAP
    target = _TARGET_LANG_MAP.get(target_lang)
    if not target:
        raise ValueError(f"Unsupported target language: {target_lang}")
    return _translate_batch(sentences, target["field"], source_lang)


async def translate_sentences(
    sentences: list[str],
    target_lang: str = "Chinese",
    source_lang: str = "English",
) -> dict:
    """Async-compatible wrapper used by services.translate.

    Returns the same shape as the cloud translation service so callers don't
    need to branch.
    """
    import asyncio
    from services.translate import _TARGET_LANG_MAP

    target = _TARGET_LANG_MAP.get(target_lang)
    if not target:
        raise ValueError(f"Unsupported target language: {target_lang}")
    expected_field = target["field"]

    loop = asyncio.get_running_loop()
    results = await loop.run_in_executor(None, translate_batch, sentences, target_lang, source_lang)

    return {
        "translations": [{"en": en, expected_field: tr} for en, tr in zip(sentences, results)],
        "cache_hits": 0,
        "llm_calls": 0,
        "elapsed_s": 0.0,
        "model": _model_name or _get_config()["model"],
        "field": expected_field,
    }
