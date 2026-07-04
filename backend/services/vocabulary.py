"""Vocabulary / favorites persistence.

Single file: backend/data/vocabulary.json

Schema (v3):
{
  "version": 3,
  "words": [
    {
      "word": "ephemeral",
      "lemma": "ephemeral",
      "phonetic": "/ɪˈfem.ər.əl/",
      "pos": "adjective",
      "meaning_en": "lasting for a very short time",
      "meaning_native": "短暂的；瞬息的",
      "native_lang": "zh",
      "example": {"en": "...", "native": "..."} | null,
      "source_history_id": "abc123" | null,
      "added_at": "...",
      "updated_at": "...",

      // v3 additions (all optional, default empty)
      "roots": {"prefix": "e-", "root": "phemera", "suffix": "-al"} | null,
      "etymology_en": "From Greek ephēmeros 'lasting only a day'..." | "",
      "etymology_native": "源自希腊语..." | "",
      "family": ["ephemeral", "ephemerality", "ephemerally", "ephemeron"],
      "related": [{"word": "ephemerality", "pos": "noun", "gloss_en": "..."}]
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

SCHEMA_VERSION = 3
DEFAULT_NATIVE_LANG = "en"

# v3 optional fields — added with safe defaults during migration
_V3_FIELDS = ("roots", "etymology_en", "etymology_native", "family", "related")


def _now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _migrate(record: dict) -> dict:
    """Migrate older records forward. Idempotent."""
    out = dict(record)
    # v1 -> v2: meaning_zh -> meaning_native + native_lang
    if "meaning_native" not in out and "meaning_native" not in out:
        if "meaning_zh" in out:
            zh = out.pop("meaning_zh", "") or ""
            out["meaning_native"] = zh
            out["native_lang"] = "zh"
    if "native_lang" not in out:
        out["native_lang"] = "zh"
    example = out.get("example")
    if isinstance(example, dict):
        ex2 = dict(example)
        if "zh" in ex2 and "native" not in ex2:
            ex2["native"] = ex2.pop("zh")
        out["example"] = ex2
    # v2 -> v3: ensure new root/etymology/family/related fields exist
    for k in _V3_FIELDS:
        if k not in out:
            if k == "roots":
                out[k] = {"prefix": "", "root": "", "suffix": ""}
            elif k in ("family", "related"):
                out[k] = []
            else:
                out[k] = ""
    return out


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
                _cache = {"version": SCHEMA_VERSION, "words": []}
        else:
            _cache = {"version": SCHEMA_VERSION, "words": []}
        if "version" not in _cache:
            _cache["version"] = SCHEMA_VERSION
        if "words" not in _cache or not isinstance(_cache["words"], list):
            _cache["words"] = []
        else:
            # Migrate records in place
            for i, w in enumerate(_cache["words"]):
                if isinstance(w, dict):
                    _cache["words"][i] = _migrate(w)


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
        items = [dict(w) for w in _cache["words"]]
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

    native_lang = (entry.get("native_lang") or DEFAULT_NATIVE_LANG).strip().lower() or DEFAULT_NATIVE_LANG
    now = _now_iso()
    with _lock:
        _ensure_file()
        for existing in _cache["words"]:
            if (existing.get("word") or "").strip().lower() == word.lower():
                for k in ("lemma", "phonetic", "pos", "meaning_en",
                          "meaning_native", "native_lang", "example",
                          "source_history_id",
                          # v3 fields
                          "roots", "etymology_en", "etymology_native",
                          "family", "related"):
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
            "meaning_en": entry.get("meaning_en") or "",
            "meaning_native": entry.get("meaning_native") or "",
            "native_lang": native_lang,
            "example": entry.get("example") or None,
            "source_history_id": entry.get("source_history_id") or None,
            "added_at": now,
            "updated_at": now,
            "roots": entry.get("roots") or {"prefix": "", "root": "", "suffix": ""},
            "etymology_en": entry.get("etymology_en") or "",
            "etymology_native": entry.get("etymology_native") or "",
            "family": list(entry.get("family") or []),
            "related": list(entry.get("related") or []),
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
