"""English word dictionary lookup with 3-tier fallback + i18n.

Tier 0: local disk cache (data/dict_cache/<sha1(word)>.json) — schema stores
        the base English entry plus a `translations` map keyed by target lang.
Tier 1: free public API (https://api.dictionaryapi.dev/api/v2/entries/en/<word>)
        — supplies English meaning/examples only.
Tier 2: DashScope LLM (default qwen-flash) — supplies:
        - full English entry when L1 misses
        - translation of meaning/examples into the requested native lang

Only English words are looked up; explanations can be in any of the supported
native languages (en, zh, ja, ko, fr, de, es, pt, ru, it).
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from pathlib import Path
from typing import Any, Optional

import httpx

from services.config import get_dashscope_api_key, get_setting
from services.word_tokenize import is_english_word

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = BASE_DIR / "data" / "dict_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# In-process cache to avoid disk roundtrips for repeated lookups
_mem_cache: dict[str, dict] = {}
_mem_lock = threading.RLock()

FREE_DICT_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/{word}"
LLM_TIMEOUT = 8.0
HTTP_TIMEOUT = 4.0

# Languages supported for the native meaning / examples. Codes align with the
# translate service in services/translate.py for consistency.
SUPPORTED_DICT_LANGS: list[dict] = [
    {"id": "en", "name": "English",        "native": "English"},
    {"id": "zh", "name": "Chinese (Simplified)", "native": "简体中文"},
    {"id": "ja", "name": "Japanese",       "native": "日本語"},
    {"id": "ko", "name": "Korean",         "native": "한국어"},
    {"id": "fr", "name": "French",         "native": "Français"},
    {"id": "de", "name": "German",         "native": "Deutsch"},
    {"id": "es", "name": "Spanish",        "native": "Español"},
    {"id": "pt", "name": "Portuguese",     "native": "Português"},
    {"id": "ru", "name": "Russian",        "native": "Русский"},
    {"id": "it", "name": "Italian",        "native": "Italiano"},
]
_DICT_LANG_IDS = {x["id"] for x in SUPPORTED_DICT_LANGS}
_DICT_LANG_NAMES = {x["id"]: x["name"] for x in SUPPORTED_DICT_LANGS}

DEFAULT_DICT_LANG = "en"
DEFAULT_WORD_LLM_MODEL = "qwen-flash"  # small, fast, cheap — for short LLM prompts


def _word_llm_model() -> str:
    return get_setting("WORD_LLM_MODEL", DEFAULT_WORD_LLM_MODEL)


def normalize_target_lang(lang: Optional[str]) -> str:
    if not lang:
        return DEFAULT_DICT_LANG
    lang = lang.strip().lower()
    if lang in _DICT_LANG_IDS:
        return lang
    # Map common aliases
    aliases = {"zh-cn": "zh", "zh-hans": "zh", "chinese": "zh", "cn": "zh",
               "ja-jp": "ja", "japanese": "ja", "jp": "ja",
               "ko-kr": "ko", "korean": "ko", "kr": "ko"}
    return aliases.get(lang, DEFAULT_DICT_LANG)


def _cache_key(word: str) -> str:
    return hashlib.sha1(word.strip().lower().encode("utf-8")).hexdigest()


def _cache_path(word: str) -> Path:
    return CACHE_DIR / f"{_cache_key(word)}.json"


def _read_disk_cache(word: str) -> Optional[dict]:
    fp = _cache_path(word)
    if not fp.exists():
        return None
    try:
        return json.loads(fp.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("[dict] Failed to read cache for %s: %s", word, e)
        return None


def _write_disk_cache(word: str, entry: dict) -> None:
    try:
        _cache_path(word).write_text(
            json.dumps(entry, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as e:
        logger.warning("[dict] Failed to write cache for %s: %s", word, e)


def _parse_roots(raw: Any) -> dict:
    """Normalize a roots object from the LLM into {prefix, root, suffix}."""
    out = {"prefix": "", "root": "", "suffix": ""}
    if not isinstance(raw, dict):
        return out
    for k in ("prefix", "root", "suffix"):
        v = raw.get(k)
        if isinstance(v, str):
            out[k] = v.strip()
    return out


def _parse_string_list(raw: Any, max_items: int = 6) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for x in raw[:max_items]:
        if isinstance(x, str):
            s = x.strip()
            if s and s.lower() not in seen:
                out.append(s)
                seen.add(s.lower())
    return out


def _parse_related(raw: Any, max_items: int = 4) -> list[dict]:
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for x in raw[:max_items]:
        if not isinstance(x, dict):
            continue
        w = (x.get("word") or "").strip()
        if not w:
            continue
        out.append({
            "word": w,
            "pos": (x.get("pos") or "").strip(),
            "gloss_en": (x.get("gloss_en") or "").strip(),
        })
    return out


def _parse_free_dict(data: Any, original: str) -> Optional[dict]:
    """Parse dictionaryapi.dev response into the standard WordEntry shape."""
    try:
        if not isinstance(data, list) or not data:
            return None
        head = data[0]
        word = head.get("word") or original
        phonetic = head.get("phonetic") or ""
        if not phonetic:
            for p in head.get("phonetics", []) or []:
                if p.get("text"):
                    phonetic = p["text"]
                    break

        pos = ""
        meaning_en = ""
        examples: list[dict] = []

        for m in head.get("meanings", []) or []:
            pos = pos or m.get("partOfSpeech", "")
            for d in m.get("definitions", []) or []:
                definition = (d.get("definition") or "").strip()
                if not meaning_en and definition:
                    meaning_en = definition
                ex = (d.get("example") or "").strip()
                if ex and len(examples) < 2:
                    examples.append({"en": ex})
                if len(examples) >= 2 and meaning_en:
                    break
            if meaning_en and len(examples) >= 2:
                break

        if not meaning_en and not pos:
            return None

        return {
            "word": word,
            "lemma": word.lower(),
            "phonetic": phonetic or "",
            "pos": pos or "",
            "meaning_en": meaning_en,
            "examples": examples,
            "translations": {},
            "roots": {"prefix": "", "root": "", "suffix": ""},
            "etymology_en": "",
            "family": [],
            "related": [],
            "source": "api:free-dict",
        }
    except Exception as e:
        logger.warning("[dict] free-dict parse failed: %s", e)
        return None


async def _lookup_free_dict(word: str) -> Optional[dict]:
    url = FREE_DICT_URL.format(word=word.lower())
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(url)
    except Exception as e:
        logger.info("[dict] free-dict network failed for %s: %s", word, e)
        return None
    if resp.status_code != 200:
        return None
    try:
        data = resp.json()
    except Exception as e:
        logger.info("[dict] free-dict non-JSON response: %s", e)
        return None
    return _parse_free_dict(data, word)


async def _llm_generate_full_entry(word: str, target_lang: str) -> Optional[dict]:
    """Ask the LLM for a full English entry, plus a translation into target_lang
    when target_lang is non-English.
    """
    api_key = get_dashscope_api_key()
    if not api_key:
        return None
    base_url = get_setting(
        "DASHSCOPE_COMPATIBLE_URL",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    model = _word_llm_model()

    target_name = _DICT_LANG_NAMES.get(target_lang, "English")
    needs_translation = target_lang != "en"

    if needs_translation:
        system_prompt = (
            "You are a strict English dictionary API with built-in translation. "
            f"For the given English word, output ONLY one JSON object with these exact keys: "
            '"phonetic" (IPA string, may be empty), '
            '"pos" (part of speech: noun/verb/adjective/adverb/preposition/conjunction/pronoun/interjection/exclamation, may be empty), '
            '"meaning_en" (concise English definition, 1 sentence), '
            f'"meaning_translation" (concise {target_name} definition, 1-2 short phrases), '
            '"examples" (array of up to 2 objects, each with keys "en" (natural English example sentence) '
            f'and "translation" (the {target_name} translation of that sentence)), '
            '"roots" (object with "prefix" (e.g. "epi-", may be empty string), "root" (the core morpheme in Latin/Greek/Old English, may be empty), "suffix" (e.g. "-al", may be empty string)), '
            '"etymology_en" (one short English sentence explaining the word\'s origin; empty string if unclear), '
            '"family" (array of up to 6 strings — inflected/derived forms of this word, e.g. ["ephemeral","ephemerality","ephemerally","ephemeron"]; may be empty), '
            '"related" (array of up to 4 objects {word, pos, gloss_en} for other common English words sharing the same root, do NOT include the input word itself; may be empty). '
            "No markdown, no code fences, no explanation. Output JSON only."
        )
    else:
        system_prompt = (
            "You are a strict English dictionary API. "
            "For the given English word, output ONLY one JSON object with these exact keys: "
            '"phonetic" (IPA string, may be empty), '
            '"pos" (part of speech: noun/verb/adjective/adverb/preposition/conjunction/pronoun/interjection/exclamation, may be empty), '
            '"meaning_en" (concise English definition, 1 sentence), '
            '"examples" (array of up to 2 objects, each with key "en" (natural English example sentence)), '
            '"roots" (object with "prefix" (e.g. "epi-", may be empty string), "root" (the core morpheme, may be empty), "suffix" (e.g. "-al", may be empty string)), '
            '"etymology_en" (one short English sentence explaining the word\'s origin; empty string if unclear), '
            '"family" (array of up to 6 strings of inflected/derived forms of this word; may be empty), '
            '"related" (array of up to 4 objects {word, pos, gloss_en} for other common English words sharing the same root, do NOT include the input word itself; may be empty). '
            "No markdown, no code fences, no explanation. Output JSON only."
        )
    user_prompt = f'Word: "{word.lower()}"'

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    endpoint = f"{base_url}/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
            resp = await client.post(endpoint, headers=headers, json=body)
    except Exception as e:
        logger.warning("[dict] LLM network failed for %s: %s", word, e)
        return None
    if resp.status_code != 200:
        logger.warning("[dict] LLM HTTP %d for %s: %s", resp.status_code, word, resp.text[:200])
        return None
    try:
        result = resp.json()
        content = result["choices"][0]["message"]["content"]
    except Exception as e:
        logger.warning("[dict] LLM response parse failed: %s", e)
        return None

    text = re.sub(r"^```(?:json)?\s*", "", content.strip())
    text = re.sub(r"\s*```$", "", text).strip()
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return None
        try:
            obj = json.loads(m.group(0))
        except json.JSONDecodeError:
            return None
    if not isinstance(obj, dict):
        return None

    examples_raw = obj.get("examples") or []
    examples: list[dict] = []
    if isinstance(examples_raw, list):
        for ex in examples_raw[:2]:
            if isinstance(ex, dict):
                en = (ex.get("en") or "").strip()
                if not en:
                    continue
                entry_ex: dict = {"en": en}
                if needs_translation:
                    tr = (ex.get("translation") or "").strip()
                    if tr:
                        entry_ex[target_lang] = tr
                examples.append(entry_ex)
            elif isinstance(ex, str) and ex.strip():
                examples.append({"en": ex.strip()})

    # Word root / etymology / family / related (optional fields, L1 doesn't provide)
    roots = _parse_roots(obj.get("roots"))
    etymology_en = (obj.get("etymology_en") or "").strip()
    family = _parse_string_list(obj.get("family"), max_items=6)
    related = _parse_related(obj.get("related"), max_items=4)

    entry: dict = {
        "word": word,
        "lemma": word.lower(),
        "phonetic": (obj.get("phonetic") or "").strip(),
        "pos": (obj.get("pos") or "").strip(),
        "meaning_en": (obj.get("meaning_en") or "").strip(),
        "examples": examples,
        "translations": {},
        "roots": roots,
        "etymology_en": etymology_en,
        "family": family,
        "related": related,
        "source": f"llm:{model}",
    }
    if needs_translation:
        mt = (obj.get("meaning_translation") or "").strip()
        if mt:
            entry["translations"] = {
                target_lang: {
                    "meaning": mt,
                    "source": f"llm:{model}",
                }
            }
        if etymology_en:
            entry["etymology_translations"] = {
                target_lang: etymology_en  # LLM will translate this in a follow-up if non-en target needs it
            }
    return entry


async def _llm_translate_entry(entry: dict, target_lang: str) -> Optional[dict]:
    """Translate an existing English-only entry (e.g. from L1) into target_lang.

    Mutates the entry by setting `translations[target_lang]` and per-example
    `<target_lang>` fields, then returns the new translation sub-record.
    """
    api_key = get_dashscope_api_key()
    if not api_key:
        return None
    base_url = get_setting(
        "DASHSCOPE_COMPATIBLE_URL",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    model = _word_llm_model()
    target_name = _DICT_LANG_NAMES.get(target_lang, target_lang)

    examples_en = [ex.get("en", "") for ex in (entry.get("examples") or []) if ex.get("en")]
    etymology_en = (entry.get("etymology_en") or "").strip()
    payload = {
        "meaning_en": entry.get("meaning_en", ""),
        "examples_en": examples_en,
        "etymology_en": etymology_en,
    }
    system_prompt = (
        f"You are a translation engine from English to {target_name}. "
        "Given a JSON object with `meaning_en` (English definition), `examples_en` "
        "(a list of up to 2 English example sentences), and optionally `etymology_en` "
        "(a short English sentence about the word's origin), output ONLY one JSON object with: "
        f'"meaning" (concise {target_name} definition, 1-2 short phrases), '
        f'"examples" (array of strings, each the {target_name} translation of the corresponding English example, same order), '
        f'"etymology" (the {target_name} translation of etymology_en, or empty string if etymology_en is empty). '
        "If a field is missing in the input, return an empty string or empty array for the corresponding output. "
        "No markdown, no code fences, no explanation. Output JSON only."
    )
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    endpoint = f"{base_url}/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
            resp = await client.post(endpoint, headers=headers, json=body)
    except Exception as e:
        logger.warning("[dict] LLM translate failed for %s/%s: %s", entry.get("word"), target_lang, e)
        return None
    if resp.status_code != 200:
        logger.warning("[dict] LLM translate HTTP %d for %s/%s: %s", resp.status_code, entry.get("word"), target_lang, resp.text[:200])
        return None
    try:
        result = resp.json()
        content = result["choices"][0]["message"]["content"]
    except Exception as e:
        logger.warning("[dict] LLM translate parse failed: %s", e)
        return None

    text = re.sub(r"^```(?:json)?\s*", "", content.strip())
    text = re.sub(r"\s*```$", "", text).strip()
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return None
        try:
            obj = json.loads(m.group(0))
        except json.JSONDecodeError:
            return None
    if not isinstance(obj, dict):
        return None

    meaning = (obj.get("meaning") or "").strip()
    examples_tr_raw = obj.get("examples") or []
    examples_tr: list[str] = []
    if isinstance(examples_tr_raw, list):
        for x in examples_tr_raw[: len(examples_en)]:
            if isinstance(x, str):
                examples_tr.append(x.strip())
            elif isinstance(x, dict):
                first = next((v for v in x.values() if isinstance(v, str)), "")
                examples_tr.append(first.strip())
    etymology_tr = (obj.get("etymology") or "").strip()

    if not meaning and not any(examples_tr) and not etymology_tr:
        return None

    out = {
        "meaning": meaning,
        "examples": examples_tr,
        "source": f"llm:{model}",
    }
    if etymology_tr:
        out["etymology"] = etymology_tr
    return out


def _apply_translation(entry: dict, lang: str, tr: dict) -> None:
    """Apply a translation sub-record onto the entry (in-place)."""
    entry.setdefault("translations", {})
    entry["translations"][lang] = {"meaning": tr.get("meaning", ""), "source": tr.get("source", f"llm:{_word_llm_model()}")}
    # Splice per-example translations
    ex_list = entry.get("examples") or []
    ex_tr = tr.get("examples") or []
    for i, ex in enumerate(ex_list):
        if i < len(ex_tr) and ex_tr[i] and isinstance(ex, dict):
            ex[lang] = ex_tr[i]
    # Store etymology translation if provided
    ety_tr = (tr.get("etymology") or "").strip()
    if ety_tr:
        entry.setdefault("etymology_translations", {})
        entry["etymology_translations"][lang] = ety_tr


def _build_response(entry: dict, word: str, target_lang: str, hit_source: str) -> dict:
    """Shape the entry into the response the client sees."""
    tr = (entry.get("translations") or {}).get(target_lang) or {}
    meaning_native = tr.get("meaning", "") if target_lang != "en" else entry.get("meaning_en", "")
    if target_lang == "en":
        meaning_native = entry.get("meaning_en", "")

    examples = []
    for ex in (entry.get("examples") or []):
        if not isinstance(ex, dict):
            continue
        en = ex.get("en", "")
        if not en:
            continue
        ex_out: dict = {"en": en}
        if target_lang != "en":
            tr_text = ex.get(target_lang, "")
            if tr_text:
                ex_out[target_lang] = tr_text
        examples.append(ex_out)

    # Word root / etymology / family / related
    roots = entry.get("roots") or {"prefix": "", "root": "", "suffix": ""}
    if not isinstance(roots, dict):
        roots = {"prefix": "", "root": "", "suffix": ""}
    roots = {k: (str(roots.get(k) or "").strip()) for k in ("prefix", "root", "suffix")}

    family = entry.get("family") or []
    if not isinstance(family, list):
        family = []
    family = [str(x).strip() for x in family if isinstance(x, str) and x.strip()]

    related = entry.get("related") or []
    if not isinstance(related, list):
        related = []
    related_clean = []
    for r in related[:4]:
        if not isinstance(r, dict):
            continue
        w = (r.get("word") or "").strip()
        if not w:
            continue
        related_clean.append({
            "word": w,
            "pos": (r.get("pos") or "").strip(),
            "gloss_en": (r.get("gloss_en") or "").strip(),
        })

    etymology_en = (entry.get("etymology_en") or "").strip()
    etymology_native = ""
    if target_lang != "en" and isinstance(entry.get("etymology_translations"), dict):
        etymology_native = (entry["etymology_translations"].get(target_lang) or "").strip()

    return {
        "word": entry.get("word") or word,
        "lemma": entry.get("lemma") or word.lower(),
        "phonetic": entry.get("phonetic", ""),
        "pos": entry.get("pos", ""),
        "meaning_en": entry.get("meaning_en", ""),
        "meaning_native": meaning_native,
        "native_lang": target_lang,
        "examples": examples,
        "roots": roots,
        "etymology_en": etymology_en,
        "etymology_native": etymology_native,
        "family": family,
        "related": related_clean,
        "source": hit_source,
    }


async def lookup_word(word: str, target_lang: Optional[str] = None) -> dict:
    """Look up an English word and return the localized response.

    Args:
        word: the English word/token to look up
        target_lang: native language for meaning/examples (e.g. "zh", "ja").
                     Defaults to settings.DICT_LANG or "en".

    Raises:
        ValueError for non-English / empty input.
        LookupError if all tiers fail.
    """
    if not word or not word.strip():
        raise ValueError("word is empty")
    if not is_english_word(word.strip()):
        raise ValueError(f"unsupported token: {word!r}")

    target_lang = normalize_target_lang(target_lang or get_setting("DICT_LANG", DEFAULT_DICT_LANG))
    key = word.strip().lower()

    # L0: in-process memory cache (keyed per native lang too)
    mem_key = f"{key}|{target_lang}"
    with _mem_lock:
        if mem_key in _mem_cache:
            return {**_mem_cache[mem_key], "source": "cache:memory"}

    cached = _read_disk_cache(key)
    if cached:
        # Ensure translations dict exists
        cached.setdefault("translations", {})
        tr = (cached.get("translations") or {}).get(target_lang)
        if tr is None and target_lang != "en":
            # Need to translate. Try LLM with the cached English as the base.
            tr_record = await _llm_translate_entry(cached, target_lang)
            if tr_record:
                _apply_translation(cached, target_lang, tr_record)
                _write_disk_cache(key, cached)
        response = _build_response(cached, key, target_lang, "cache:disk")
        with _mem_lock:
            _mem_cache[mem_key] = response
        return response

    # L1: free public API (English only)
    entry = await _lookup_free_dict(key)
    if entry:
        # Optionally translate to target_lang via LLM
        if target_lang != "en":
            tr_record = await _llm_translate_entry(entry, target_lang)
            if tr_record:
                _apply_translation(entry, target_lang, tr_record)
        _write_disk_cache(key, entry)
        response = _build_response(entry, key, target_lang, entry.get("source", "api:free-dict"))
        with _mem_lock:
            _mem_cache[mem_key] = response
        return response

    # L2: LLM full generation
    entry = await _llm_generate_full_entry(key, target_lang)
    if entry and (entry.get("meaning_en") or (entry.get("translations") or {}).get(target_lang)):
        _write_disk_cache(key, entry)
        response = _build_response(entry, key, target_lang, entry.get("source") or f"llm:{_word_llm_model()}")
        with _mem_lock:
            _mem_cache[mem_key] = response
        return response

    raise LookupError(f"no definition found for {word!r}")


def cache_stats() -> dict:
    try:
        files = list(CACHE_DIR.glob("*.json"))
    except Exception:
        files = []
    return {
        "disk_files": len(files),
        "memory_entries": len(_mem_cache),
    }


def invalidate(word: str) -> None:
    """Remove a word from memory + disk cache. Forces a fresh lookup next time."""
    key = word.strip().lower()
    with _mem_lock:
        keys_to_drop = [k for k in list(_mem_cache.keys()) if k == key or k.startswith(key + "|")]
        for k in keys_to_drop:
            _mem_cache.pop(k, None)
    try:
        _cache_path(key).unlink(missing_ok=True)
    except Exception as e:
        logger.warning("[dict] Failed to invalidate cache for %s: %s", key, e)
