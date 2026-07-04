"""Per-sentence translation cache.

Avoids paying for / waiting on the LLM to translate a sentence we have
already translated in a previous request. The cache key is a hash of
(source_text + target_lang + source_lang), so the same English sentence
translated to Chinese and Japanese gets two independent cache entries.

Storage: data/trans_cache/<sha1>.json
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = BASE_DIR / "data" / "trans_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# In-process cache to avoid disk roundtrips for repeated lookups
_mem: dict[str, str] = {}
_lock = threading.RLock()


def _key(text: str, target_lang: str, source_lang: str = "en") -> str:
    norm = (text or "").strip().lower()
    return f"{source_lang.lower()}|{target_lang.lower()}|{norm}"


def _hash(k: str) -> str:
    return hashlib.sha1(k.encode("utf-8")).hexdigest()


def _path_for(k: str) -> Path:
    return CACHE_DIR / f"{_hash(k)}.json"


def get(text: str, target_lang: str, source_lang: str = "en") -> Optional[str]:
    """Return the cached translation, or None if not cached."""
    if not text or not text.strip():
        return None
    k = _key(text, target_lang, source_lang)
    with _lock:
        if k in _mem:
            return _mem[k]
    fp = _path_for(k)
    if not fp.exists():
        return None
    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
        translation = data.get("translation", "")
    except Exception as e:
        logger.warning("[trans_cache] read failed: %s", e)
        return None
    if translation:
        with _lock:
            _mem[k] = translation
    return translation or None


def put(text: str, target_lang: str, translation: str, source_lang: str = "en") -> None:
    """Store a translation in cache. No-op for empty translation."""
    if not text or not text.strip() or not translation:
        return
    k = _key(text, target_lang, source_lang)
    with _lock:
        _mem[k] = translation
    fp = _path_for(k)
    try:
        fp.write_text(
            json.dumps(
                {"text": text.strip(), "source_lang": source_lang, "target_lang": target_lang, "translation": translation},
                ensure_ascii=False,
                indent=0,
            ),
            encoding="utf-8",
        )
    except Exception as e:
        logger.warning("[trans_cache] write failed: %s", e)


def bulk_get(texts: list[str], target_lang: str, source_lang: str = "en") -> list[Optional[str]]:
    """Return cached translations aligned with the input list (None for misses)."""
    return [get(t, target_lang, source_lang) for t in texts]


def bulk_put(pairs: list[tuple[str, str]], target_lang: str, source_lang: str = "en") -> None:
    """Store many translations at once. pairs = [(text, translation), ...]"""
    for text, tr in pairs:
        put(text, target_lang, tr, source_lang)


def stats() -> dict:
    try:
        files = list(CACHE_DIR.glob("*.json"))
    except Exception:
        files = []
    return {
        "disk_files": len(files),
        "memory_entries": len(_mem),
    }


def clear() -> int:
    """Wipe both memory and disk caches. Returns number of files removed."""
    with _lock:
        _mem.clear()
    count = 0
    try:
        for fp in CACHE_DIR.glob("*.json"):
            try:
                fp.unlink()
                count += 1
            except Exception:
                pass
    except Exception:
        pass
    return count
