"""Vocabulary / favorites persistence.

Single file: backend/data/vocabulary.json

Schema:
{
  "version": 1,
  "words": [
    {
      "word": "ephemeral",
      "lemma": "ephemeral",
      "phonetic": "/ɪˈfem.ər.əl/",
      "pos": "adjective",
      "meaning_zh": "短暂的；瞬息的",
      "meaning_en": "lasting for a very short time",
      "example": {"en": "...", "zh": "..."} | null,
      "source_history_id": "abc123" | null,
      "added_at": "2025-01-01T00:00:00Z",
      "updated_at": "2025-01-01T00:00:00Z"
    }
  ]
}
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
VOCAB_FILE = DATA_DIR / "vocabulary.json"

_lock = threading.RLock()
_cache: Optional[dict] = None


def _now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _ensure_file() -> None:
    global _cache
    with _lock:
        if _cache is not None:
            return
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if VOCAB_FILE.exists():
            try:
                _cache = json.loads(VOCAB_FILE.read_text(encoding="utf-8-sig"))
            except Exception as e:
                logger.warning("[vocab] Failed to parse vocabulary.json: %s", e)
                _cache = {"version": 1, "words": []}
        else:
            _cache = {"version": 1, "words": []}
        if "version" not in _cache:
            _cache["version"] = 1
        if "words" not in _cache or not isinstance(_cache["words"], list):
            _cache["words"] = []


def _flush() -> None:
    if _cache is None:
        return
    try:
        VOCAB_FILE.write_text(
            json.dumps(_cache, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as e:
        logger.error("[vocab] Failed to write vocabulary.json: %s", e)


def list_words() -> list[dict]:
    with _lock:
        _ensure_file()
        items = list(_cache["words"])
    items.sort(key=lambda w: (w.get("added_at") or ""), reverse=True)
    return items


def has_word(word: str) -> bool:
    key = (word or "").strip().lower()
    if not key:
        return False
    with _lock:
        _ensure_file()
        for w in _cache["words"]:
            if (w.get("word") or "").strip().lower() == key:
                return True
    return False


def get_word(word: str) -> Optional[dict]:
    key = (word or "").strip().lower()
    if not key:
        return None
    with _lock:
        _ensure_file()
        for w in _cache["words"]:
            if (w.get("word") or "").strip().lower() == key:
                return dict(w)
    return None


def add_word(entry: dict) -> dict:
    """Add or update a word entry. Returns the stored record."""
    word = (entry.get("word") or "").strip()
    if not word:
        raise ValueError("word is required")

    now = _now_iso()
    with _lock:
        _ensure_file()
        for existing in _cache["words"]:
            if (existing.get("word") or "").strip().lower() == word.lower():
                for k in ("lemma", "phonetic", "pos", "meaning_zh", "meaning_en", "example", "source_history_id"):
                    if k in entry and entry[k] is not None:
                        existing[k] = entry[k]
                existing["updated_at"] = now
                _flush()
                return dict(existing)

        record = {
            "word": word,
            "lemma": (entry.get("lemma") or word).lower(),
            "phonetic": entry.get("phonetic") or "",
            "pos": entry.get("pos") or "",
            "meaning_zh": entry.get("meaning_zh") or "",
            "meaning_en": entry.get("meaning_en") or "",
            "example": entry.get("example") or None,
            "source_history_id": entry.get("source_history_id") or None,
            "added_at": now,
            "updated_at": now,
        }
        _cache["words"].append(record)
        _flush()
        return dict(record)


def remove_word(word: str) -> bool:
    key = (word or "").strip().lower()
    if not key:
        return False
    with _lock:
        _ensure_file()
        before = len(_cache["words"])
        _cache["words"] = [
            w for w in _cache["words"]
            if (w.get("word") or "").strip().lower() != key
        ]
        removed = len(_cache["words"]) != before
        if removed:
            _flush()
        return removed


def stats() -> dict:
    with _lock:
        _ensure_file()
        return {
            "total": len(_cache["words"]),
        }
