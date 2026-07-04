"""Translation service using DashScope chat completions.

Default model: qwen-turbo (fast + cheap, good enough for sentence translation).
Configurable via TRANSLATE_MODEL env / settings.

Per-sentence results are cached in data/trans_cache/ so repeated sentences
across videos (or within the same video) cost nothing.
"""
import json
import logging
import re
import time
from typing import Optional

import httpx

from services import sentence_cache

logger = logging.getLogger(__name__)

SUPPORTED_TARGET_LANGS = [
    {"id": "Chinese",             "name": "Chinese (Simplified)",  "field": "zh",    "native": "简体中文"},
    {"id": "Chinese-Traditional", "name": "Chinese (Traditional)", "field": "zh-TW", "native": "繁體中文"},
    {"id": "Japanese",            "name": "Japanese",              "field": "ja",    "native": "日本語"},
    {"id": "Korean",              "name": "Korean",                "field": "ko",    "native": "한국어"},
    {"id": "French",              "name": "French",                "field": "fr",    "native": "Français"},
    {"id": "German",              "name": "German",                "field": "de",    "native": "Deutsch"},
    {"id": "Spanish",             "name": "Spanish",               "field": "es",    "native": "Español"},
    {"id": "Portuguese",          "name": "Portuguese",            "field": "pt",    "native": "Português"},
    {"id": "Russian",             "name": "Russian",               "field": "ru",    "native": "Русский"},
    {"id": "Italian",             "name": "Italian",               "field": "it",    "native": "Italiano"},
]

_TARGET_LANG_MAP = {x["id"]: x for x in SUPPORTED_TARGET_LANGS}

_TARGET_LANG_NAMES = {
    "Chinese": "Chinese (Simplified)",
    "Chinese-Traditional": "Traditional Chinese (Taiwan/Hong Kong)",
    "Japanese": "Japanese",
    "Korean": "Korean",
    "French": "French",
    "German": "German",
    "Spanish": "Spanish",
    "Portuguese": "Portuguese",
    "Russian": "Russian",
    "Italian": "Italian",
}


def _build_system_prompt(target_lang: str, source_lang: str = "English") -> str:
    target_name = _TARGET_LANG_NAMES.get(target_lang, target_lang)
    source_name = {
        "en": "English", "zh": "Chinese", "ja": "Japanese", "ko": "Korean",
        "es": "Spanish", "fr": "French", "de": "German", "pt": "Portuguese",
        "ru": "Russian", "it": "Italian",
    }.get(source_lang.lower(), source_lang)
    target_field = _TARGET_LANG_MAP[target_lang]["field"]
    return (
        f"You are a professional {source_name}-to-{target_name} translator for a language learning shadowing app.\n"
        f"The user provides a JSON array of {source_name} sentences. You must return a JSON array with the SAME length and order.\n"
        f'Each item: {{"en": "<original sentence>", "{target_field}": "<natural {target_name} translation>"}}.\n\n'
        "Rules:\n"
        "- Keep sentence order and count EXACTLY matching the input.\n"
        f"- Translations must be natural, fluent {target_name}.\n"
        "- Keep proper nouns, brand names, and untranslatable terms when appropriate.\n"
        "- Output ONLY valid JSON. No explanations, no markdown fences."
    )


def _get_config():
    from services.config import get_setting
    return {
        "api_key": get_setting("DASHSCOPE_API_KEY", ""),
        "base_url": get_setting(
            "DASHSCOPE_COMPATIBLE_URL",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        ),
        "model": get_setting("TRANSLATE_MODEL", "qwen-turbo"),
        "backend": get_setting("TRANSLATE_BACKEND", "local").strip().lower(),
    }


def _use_local_backend() -> bool:
    cfg = _get_config()
    backend = cfg["backend"]
    if backend == "dashscope":
        return False
    if backend == "local":
        return True
    # Auto: use local when no DashScope key is configured
    return not bool(cfg["api_key"])


def _local_translate_available() -> bool:
    try:
        from . import local_translate
        return local_translate.is_available()
    except Exception:
        return False


def _get_local_model_name() -> Optional[str]:
    try:
        from . import local_translate
        return local_translate._get_config()["model"]
    except Exception:
        return None


async def _local_translate_batch(
    sentences: list[str], target_lang: str, source_lang: str
) -> list[str]:
    from . import local_translate
    resp = await local_translate.translate_sentences(
        sentences, target_lang=target_lang, source_lang=source_lang
    )
    expected_field = _TARGET_LANG_MAP[target_lang]["field"]
    return [item.get(expected_field, "") for item in resp.get("translations", [])]


async def translate_sentences(sentences: list[str], target_lang: str = "Chinese", source_lang: str = "English", use_cache: bool = True) -> dict:
    """Translate sentences from source_lang to target_lang.

    Returns:
        {
            "translations": [{en, <field>}, ...],   # same length as input, in order
            "cache_hits": int,                       # how many came from disk cache
            "llm_calls": int,                        # how many LLM roundtrips
            "elapsed_s": float,
            "model": str,                            # model used
            "field": str,                            # target field name (e.g. "zh")
        }
    """
    t0 = time.time()
    if not sentences:
        return {
            "translations": [],
            "cache_hits": 0,
            "llm_calls": 0,
            "elapsed_s": 0.0,
            "model": "",
            "field": "",
        }

    target = _TARGET_LANG_MAP.get(target_lang)
    if not target:
        raise ValueError(f"Unsupported target language: {target_lang}. Available: {list(_TARGET_LANG_MAP.keys())}")
    expected_field = target["field"]

    # Step 1: per-sentence cache lookup
    cached: list[Optional[str]] = [None] * len(sentences)
    miss_idx: list[int] = []
    cache_hits = 0
    if use_cache:
        cached = sentence_cache.bulk_get(sentences, target_lang, source_lang=source_lang)
        for i, c in enumerate(cached):
            if c:
                cache_hits += 1
            else:
                miss_idx.append(i)

    # Step 2: translate cache misses
    llm_calls = 0
    if miss_idx:
        miss_sentences = [sentences[i] for i in miss_idx]

        if _use_local_backend():
            logger.info("Using local NLLB translation for %d sentences", len(miss_sentences))
            if not _local_translate_available():
                raise RuntimeError(
                    "Local translation is selected but dependencies are missing. "
                    "Run: pip install sentencepiece sacremoses ctranslate2"
                )
            llm_results = await _local_translate_batch(miss_sentences, target_lang, source_lang)
        else:
            llm_results = await _llm_translate_batch(miss_sentences, target_lang, source_lang)
            llm_calls = 1

        for local_i, global_i in enumerate(miss_idx):
            tr = llm_results[local_i] if local_i < len(llm_results) else ""
            cached[global_i] = tr
            if tr:
                sentence_cache.put(sentences[global_i], target_lang, tr, source_lang=source_lang)

    # Step 3: assemble response
    out = []
    for i, en in enumerate(sentences):
        out.append({"en": en, expected_field: cached[i] or ""})

    elapsed = time.time() - t0
    logger.info(
        "Translate done: %d sentences, cache_hits=%d, llm_calls=%d, elapsed=%.2fs",
        len(sentences), cache_hits, llm_calls, elapsed,
    )
    return {
        "translations": out,
        "cache_hits": cache_hits,
        "llm_calls": llm_calls,
        "elapsed_s": round(elapsed, 3),
        "model": _get_config()["model"] if llm_calls else (_get_local_model_name() or "local-nllb"),
        "field": expected_field,
    }


async def _llm_translate_batch(sentences: list[str], target_lang: str, source_lang: str) -> list[str]:
    """Call the LLM once for a batch of sentences. Returns translations in order."""
    if not sentences:
        return []
    cfg = _get_config()
    if not cfg["api_key"]:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured")

    endpoint = f"{cfg['base_url']}/chat/completions"
    user_payload = json.dumps(sentences, ensure_ascii=False)
    user_prompt = f"Translate this JSON array:\n{user_payload}\nReturn JSON array only."

    system_prompt = _build_system_prompt(target_lang, source_lang=source_lang)
    expected_field = _TARGET_LANG_MAP[target_lang]["field"]

    body = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }

    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }

    logger.info(
        "Translate LLM call: %d sentences, model=%s, %s -> %s",
        len(sentences), cfg["model"], source_lang, target_lang,
    )

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(endpoint, headers=headers, json=body)

    if resp.status_code != 200:
        logger.error("Translate failed: %s %s", resp.status_code, resp.text)
        raise RuntimeError(f"Translation failed: {resp.status_code} {resp.text[:300]}")

    result = resp.json()
    content = result["choices"][0]["message"]["content"]
    logger.info("Translate ok, raw_len=%d", len(content))

    return _extract_translation_text(content, sentences, expected_field)


def _extract_translation_text(content: str, original_sentences: list[str], expected_field: str) -> list[str]:
    """Pull just the translation strings from the model's response, aligned with the input."""
    parsed = _parse_translation_response(content, original_sentences, expected_field)
    return [p.get(expected_field, "") or "" for p in parsed]


def _parse_translation_response(
    content: str,
    original_sentences: list[str],
    expected_field: str = "zh",
    target_lang: str = "Chinese",
) -> list[dict]:
    """Parse model output and gracefully handle markdown fences, dict wrappers, and missing fields."""
    text = content.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    text = text.strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if not match:
            logger.warning("Translate response is not valid JSON, falling back")
            return [{"en": s, expected_field: ""} for s in original_sentences]
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            return [{"en": s, expected_field: ""} for s in original_sentences]

    arr = None
    if isinstance(parsed, list):
        arr = parsed
    elif isinstance(parsed, dict):
        for key in ("translations", "result", "data", "sentences", "items"):
            if key in parsed and isinstance(parsed[key], list):
                arr = parsed[key]
                break
        if arr is None:
            for v in parsed.values():
                if isinstance(v, list):
                    arr = v
                    break

    if not arr:
        return [{"en": s, expected_field: ""} for s in original_sentences]

    candidate_keys = [expected_field, "translation", "text", "target", "t"]
    for v in _TARGET_LANG_MAP.values():
        candidate_keys.append(v["field"])

    out = []
    for i, en in enumerate(original_sentences):
        translated = ""
        if i < len(arr):
            item = arr[i]
            if isinstance(item, dict):
                for k in candidate_keys:
                    val = item.get(k)
                    if isinstance(val, str) and val.strip():
                        translated = val
                        break
                    if isinstance(val, (list, dict)) and val:
                        if isinstance(val, list) and len(val) > 0 and isinstance(val[0], str):
                            translated = val[0]
                            break
                        elif isinstance(val, dict):
                            for sub_v in val.values():
                                if isinstance(sub_v, str) and sub_v.strip():
                                    translated = sub_v
                                    break
                            if translated:
                                break
            elif isinstance(item, str):
                translated = item
        out.append({"en": en, expected_field: translated})

    return out
