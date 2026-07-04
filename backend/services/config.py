"""Runtime configuration persistence.

Priority (high -> low):
  1) In-memory _OVERRIDES (temporary UI changes not yet persisted)
  2) data/settings.json (persisted from the UI)
  3) Process environment variables (.env / startup env)

Special sentinel: a key stored as "__DISABLED__" means the user explicitly
removed it in the UI, overriding any .env value.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DISABLED_SENTINEL = "__DISABLED__"

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
SETTINGS_FILE = DATA_DIR / "settings.json"

_lock = threading.RLock()
_overrides: dict[str, Any] = {}
_persisted: dict[str, Any] = {}
_loaded: bool = False


def _ensure_loaded() -> None:
    global _persisted, _loaded
    if _loaded:
        return
    _loaded = True
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if SETTINGS_FILE.exists():
            _persisted = json.loads(SETTINGS_FILE.read_text(encoding="utf-8-sig"))
            logger.info("[config] Loaded settings.json keys: %s", list(_persisted.keys()))
    except Exception as e:
        logger.warning("[config] Failed to load settings.json: %s", e)
        _persisted = {}


def _save_persisted() -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(
            json.dumps(_persisted, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        logger.info("[config] Saved settings.json keys: %s", list(_persisted.keys()))
    except Exception as e:
        logger.error("[config] Failed to write settings.json: %s", e)


def get_setting(key: str, default: Any = None) -> Any:
    """Read a setting with priority: overrides > persisted > env > default."""
    with _lock:
        _ensure_loaded()
        if key in _overrides:
            return _overrides[key]
        if key in _persisted and _persisted[key] not in (None, ""):
            return _persisted[key]
        env_val = os.getenv(key)
        if env_val not in (None, ""):
            return env_val
        return default


def is_disabled(key: str) -> bool:
    """Return True if the user explicitly disabled the key in the UI."""
    with _lock:
        _ensure_loaded()
        if key in _overrides and _overrides[key] == _DISABLED_SENTINEL:
            return True
        if key in _persisted and _persisted[key] == _DISABLED_SENTINEL:
            return True
        return False


def set_setting(key: str, value: Any, *, persist: bool = True) -> None:
    """Set a setting. If persist=True, write to settings.json as well."""
    with _lock:
        _ensure_loaded()
        _overrides[key] = value
        if persist:
            _persisted[key] = value
            _save_persisted()


def delete_setting(key: str, *, persist: bool = True) -> bool:
    """Delete a key from overrides/persisted. .env remains as a fallback.

    To explicitly disable a key (override .env), use set_setting(key, _DISABLED_SENTINEL).
    """
    with _lock:
        _ensure_loaded()
        deleted = False
        if key in _overrides:
            del _overrides[key]
            deleted = True
        if persist and key in _persisted:
            del _persisted[key]
            _save_persisted()
            deleted = True
        return deleted


def disable_setting(key: str, *, persist: bool = True) -> None:
    """Explicitly disable a key so .env is ignored."""
    set_setting(key, _DISABLED_SENTINEL, persist=persist)


def get_all_settings() -> dict[str, Any]:
    """Return all currently effective settings for frontend display."""
    with _lock:
        _ensure_loaded()
        result: dict[str, Any] = {}
        for k, v in _persisted.items():
            result[k] = v
        for k, v in _overrides.items():
            result[k] = v
        for k, v in os.environ.items():
            if k.startswith(("DASHSCOPE_", "TRANSLATE_", "WHISPER_", "MAX_")):
                if k not in result and v:
                    result[k] = v
        return result


def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 12:
        return key[:3] + "..." + key[-2:] if len(key) > 5 else "***"
    return f"{key[:6]}...{key[-4:]}"


def get_dashscope_api_key() -> str:
    """Return the DashScope API key, or empty string if explicitly disabled."""
    if is_disabled("DASHSCOPE_API_KEY"):
        return ""
    val = get_setting("DASHSCOPE_API_KEY", "")
    return val or ""


def get_dashscope_base_url() -> str:
    if is_disabled("DASHSCOPE_BASE_URL"):
        return "https://dashscope.aliyuncs.com/api/v1"
    return get_setting("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/api/v1")


def is_dashscope_configured() -> bool:
    """Return True if a usable DashScope API key is configured."""
    return bool(get_dashscope_api_key())
