"""English word dictionary lookup with 3-tier fallback.

Tier 0: local disk cache (data/dict_cache/<sha1>.json)
Tier 1: free public API (https://api.dictionaryapi.dev/api/v2/entries/en/<word>)
Tier 2: DashScope qwen-plus (strict-JSON prompt, only when L1 misses)

Only English words are supported (project scope).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
from pathlib import Path
from typing import Any, Optional

import httpx

from services.config import get_dashscope_api_key, get_setting

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


def _cache_key(word: str) -> str:
    return hashlib.sha1(word.strip().lower().encode("utf-8")).hexdigest()


def _cache_path(word: str) -> Path:
    return CACHE_DIR / f"{_cache_key(word)}.json"


def _is_english_word(word: str) -> bool:
    if not word:
        return False
    return bool(re.fullmatch(r"[A-Za-z][A-Za-z'\-]*", word))


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
        meaning_zh = ""
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
                    examples.append({"en": ex, "zh": ""})
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
            "meaning_zh": meaning_zh,
            "examples": examples,
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


async def _lookup_llm(word: str) -> Optional[dict]:
    api_key = get_dashscope_api_key()
    if not api_key:
        return None
    base_url = get_setting(
        "DASHSCOPE_COMPATIBLE_URL",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    model = get_setting("TRANSLATE_MODEL", "qwen-plus")

    system_prompt = (
        "You are a strict English dictionary API. "
        "For the given English word, output ONLY one JSON object with these exact keys: "
        '"phonetic" (IPA string, may be empty), '
        '"pos" (part of speech: noun/verb/adjective/adverb/preposition/conjunction/pronoun/interjection/exclamation, may be empty), '
        '"meaning_zh" (concise Chinese definition, 1-2 short phrases separated by semicolons), '
        '"meaning_en" (concise English definition, 1 sentence), '
        '"examples" (array of up to 2 objects with keys "en" and "zh", use natural sentences). '
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
                zh = (ex.get("zh") or "").strip()
                if en:
                    examples.append({"en": en, "zh": zh})
            elif isinstance(ex, str) and ex.strip():
                examples.append({"en": ex.strip(), "zh": ""})

    return {
        "word": word,
        "lemma": word.lower(),
        "phonetic": (obj.get("phonetic") or "").strip(),
        "pos": (obj.get("pos") or "").strip(),
        "meaning_zh": (obj.get("meaning_zh") or "").strip(),
        "meaning_en": (obj.get("meaning_en") or "").strip(),
        "examples": examples,
        "source": "llm:qwen-plus",
    }


async def lookup_word(word: str) -> dict:
    """Look up an English word and return the standard WordEntry.

    Raises ValueError for non-English / empty input.
    Raises LookupError if all tiers fail.
    """
    if not word or not word.strip():
        raise ValueError("word is empty")
    if not _is_english_word(word.strip()):
        raise ValueError(f"unsupported token: {word!r}")

    key = word.strip().lower()
    with _mem_lock:
        if key in _mem_cache:
            return {**_mem_cache[key], "source": "cache:memory"}

    cached = _read_disk_cache(key)
    if cached:
        with _mem_lock:
            _mem_cache[key] = cached
        return {**cached, "source": "cache:disk"}

    # L1: free public API
    entry = await _lookup_free_dict(key)
    if entry:
        _write_disk_cache(key, entry)
        with _mem_lock:
            _mem_cache[key] = entry
        return entry

    # L2: LLM fallback
    entry = await _lookup_llm(key)
    if entry and (entry.get("meaning_zh") or entry.get("meaning_en")):
        _write_disk_cache(key, entry)
        with _mem_lock:
            _mem_cache[key] = entry
        return entry

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
        _mem_cache.pop(key, None)
    try:
        _cache_path(key).unlink(missing_ok=True)
    except Exception as e:
        logger.warning("[dict] Failed to invalidate cache for %s: %s", key, e)
