"""Word-level TTS wrapper around the existing voice_service.

Reuses voice_service.synthesize (which already does disk caching keyed
on SHA1(voice:text)). We just enforce a sensible default and validate
the token up front.
"""
from __future__ import annotations

import logging

from services.voice_service import synthesize as tts_synthesize
from services.word_tokenize import is_english_word, normalize_for_lookup

logger = logging.getLogger(__name__)

DEFAULT_VOICE = "Cherry"
DEFAULT_LANGUAGE = "English"


async def synthesize_word(word: str, voice: str = DEFAULT_VOICE, language_type: str = DEFAULT_LANGUAGE) -> tuple[bytes, dict]:
    """Synthesize a single word. Raises ValueError for non-English tokens.

    Returns (audio_bytes, metadata_dict).
    """
    if not word or not word.strip():
        raise ValueError("word is empty")
    if not is_english_word(word):
        raise ValueError(f"not an English word token: {word!r}")

    text = normalize_for_lookup(word)
    audio, meta = await tts_synthesize(text, voice=voice, language_type=language_type)
    meta["text"] = text
    return audio, meta
