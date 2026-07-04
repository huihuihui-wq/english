"""DashScope TTS service using qwen3-tts-instruct-flash-realtime model."""
import base64
import hashlib
import json
import logging
import os
from pathlib import Path
from typing import List, Tuple

import httpx

logger = logging.getLogger(__name__)

TTS_CACHE_DIR = Path(__file__).resolve().parent.parent / ".tts_cache"
TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Qwen3 TTS voices
TTS_VOICES = {
    "English": [
        "Cherry", "Cathy", "Annie", "Patricia", "Lois", "Lily", "Cora", "Ava",
        "Emma", "Alice", "Poppy", "Nova", "Bella", "Bryant", "Walt", "zhida",
        "zhifei", "zhichu", "zhimao", "zhinan"
    ],
    "Chinese": [
        "zhimao", "zhinan", "zhiying", "zhijing", "zhimo", "zhishu", "zhixia",
        "zhiqi", "zhiyuan", "zhiyue", "zhigang", "zhide", "zhiwei", "zhilun",
        "zhiya", "zhiru", "zhida", "zhifei", "zhichu", "Cherry", "Cathy"
    ],
}

DEFAULT_VOICE = {
    "English": "Cherry",
    "Chinese": "zhimao",
}


def _get_config():
    from services.config import get_dashscope_api_key, get_dashscope_base_url
    api_key = get_dashscope_api_key()
    if not api_key:
        logger.warning("[TTS] DASHSCOPE_API_KEY is empty or disabled")
    else:
        logger.info("[TTS] Using API key: %s...", api_key[:8] if len(api_key) > 12 else " configured")
    return {
        "api_key": api_key,
        "base_url": get_dashscope_base_url(),
    }


def _cache_key(text: str, voice: str) -> str:
    h = hashlib.sha1(f"{voice}:{text}".encode("utf-8")).hexdigest()
    return h


def _cache_path(text: str, voice: str) -> Path:
    return TTS_CACHE_DIR / f"{_cache_key(text, voice)}.mp3"


def _cache_meta_path(text: str, voice: str) -> Path:
    return TTS_CACHE_DIR / f"{_cache_key(text, voice)}.json"


def list_voices(language_type: str = "English"):
    return TTS_VOICES.get(language_type, TTS_VOICES["English"])


def get_default_voice(language_type: str = "English"):
    return DEFAULT_VOICE.get(language_type, DEFAULT_VOICE["English"])


def _normalize_voice(voice: str, language_type: str) -> str:
    """Return a valid voice name for the requested language type."""
    available = list_voices(language_type)
    if voice in available:
        return voice
    # case-insensitive fallback
    lower = voice.lower()
    for v in available:
        if v.lower() == lower:
            return v
    return get_default_voice(language_type)


def _parse_tts_response(resp: dict) -> Tuple[bytes, List[dict]]:
    """Parse DashScope TTS response and extract audio + word timestamps."""
    try:
        choices = resp.get("output", {}).get("choices", [])
        if not choices:
            raise RuntimeError("TTS returned empty choices")
        
        msg = choices[0].get("message", {})
        content = msg.get("content", [])
        
        audio_base64 = ""
        words = []
        
        if isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                # Extract audio
                if "audio" in item:
                    audio_data = item["audio"]
                    if isinstance(audio_data, dict):
                        audio_base64 = audio_data.get("data", "")
                    elif isinstance(audio_data, str):
                        audio_base64 = audio_data
                # Extract text/word timestamps
                if "text" in item:
                    text_content = item["text"]
                    if isinstance(text_content, dict):
                        words = text_content.get("words", [])
                    # Try to parse words from text if available
                if "words" in item and isinstance(item["words"], list):
                    words = item["words"]
        
        # Fallback: try to get audio from direct response fields
        if not audio_base64:
            audio_base64 = resp.get("output", {}).get("audio") or resp.get("audio", "")
            if isinstance(audio_base64, dict):
                audio_base64 = audio_base64.get("data", "")
        
        if not audio_base64:
            raise RuntimeError("TTS response did not contain audio data")
        
        audio_bytes = base64.b64decode(audio_base64)
        
        # Parse words into standard format
        parsed_words = []
        for w in (words or []):
            if isinstance(w, dict):
                parsed_words.append({
                    "text": w.get("text", "").strip(),
                    "begin_time": int(w.get("begin_time", 0)),
                    "end_time": int(w.get("end_time", 0)),
                })
        
        return audio_bytes, parsed_words
        
    except Exception as e:
        logger.exception("Failed to parse TTS response: %s", e)
        raise RuntimeError(f"Failed to parse TTS response: {e}")


async def synthesize(text: str, voice: str = "", language_type: str = "English") -> tuple[bytes, dict]:
    """Synthesize text to audio bytes using qwen-tts.
    
    Returns (audio_bytes, metadata).
    Metadata includes: voice, language_type, cached, size, words (list of word timestamps).
    """
    cfg = _get_config()
    if not cfg["api_key"]:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured")

    if not text or not text.strip():
        raise ValueError("Text is empty")

    voice = _normalize_voice(voice, language_type)
    cache_file = _cache_path(text, voice)
    cache_meta_file = _cache_meta_path(text, voice)
    
    # Check cache
    if cache_file.exists():
        audio_bytes = cache_file.read_bytes()
        words = []
        if cache_meta_file.exists():
            try:
                words = json.loads(cache_meta_file.read_text()).get("words", [])
            except Exception:
                pass
        return audio_bytes, {
            "voice": voice,
            "language_type": language_type,
            "cached": True,
            "size": len(audio_bytes),
            "words": words,
        }

    url = f"{cfg['base_url']}/services/aigc/multimodal-generation/generation"
    
    payload = {
        "model": "qwen-tts",
        "input": {
            "text": text
        },
        "parameters": {
            "voice": voice,
            "sample_rate": 24000,
            "format": "mp3",
        }
    }
    
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }

    logger.info("TTS request: url=%s, voice=%s, text_length=%d", url, voice, len(text))
    logger.debug("TTS payload: %s", json.dumps(payload, ensure_ascii=False)[:500])
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, headers=headers, json=payload)

    if resp.status_code != 200:
        logger.error("TTS failed: %s %s", resp.status_code, resp.text[:500])
        raise RuntimeError(f"TTS failed: {resp.status_code} {resp.text[:300]}")

    result = resp.json()
    
    # Parse response - qwen-tts returns audio URL
    audio_url = result.get("output", {}).get("audio", {}).get("url", "")
    if not audio_url:
        raise RuntimeError("TTS response did not contain audio URL")
    
    # Download audio from URL
    logger.info("TTS audio URL: %s", audio_url[:100])
    async with httpx.AsyncClient(timeout=60.0) as client:
        audio_resp = await client.get(audio_url)
        if audio_resp.status_code != 200:
            raise RuntimeError(f"Failed to download audio: {audio_resp.status_code}")
        audio_bytes = audio_resp.content
    
    words = []  # qwen-tts doesn't provide word timestamps
    
    # Save to cache
    cache_file.write_bytes(audio_bytes)
    cache_meta_file.write_text(
        json.dumps({"words": words, "text": text, "voice": voice}, ensure_ascii=False),
        encoding="utf-8"
    )

    return audio_bytes, {
        "voice": voice,
        "language_type": language_type,
        "cached": False,
        "size": len(audio_bytes),
        "words": words,
    }
