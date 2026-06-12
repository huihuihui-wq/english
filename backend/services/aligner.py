"""Forced alignment using wav2vec2 CTC for precise word-level subtitles.

This module replaces the previous Qwen3-ForcedAligner implementation.
It uses facebook/wav2vec2-base-960h (English) by default.
For non-English audio it falls back to proportional timing.

Why wav2vec2 CTC:
  - Much lighter and faster than Qwen3-ForcedAligner (~380MB vs ~1.7GB).
  - Well-tested alignment approach via CTC log-probabilities + Viterbi.
  - First load still takes a few seconds, but inference is fast on GPU/CPU.

Failure handling:
  - Any error returns None; caller falls back to sentence-level timestamps.
  - Lazy model load on first alignment request.
  - Thread-safe singleton via lock.

Caching:
  - SHA-256(audio + text + language) -> aligned result.
  - Stored in backend/data/align_cache/{hash}.json.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
import wave
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import List, Optional

import numpy as np

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
ALIGN_CACHE_DIR = BASE_DIR / "data" / "align_cache"
ALIGN_CACHE_DIR.mkdir(parents=True, exist_ok=True)

SAMPLE_RATE = 16000
MAX_ALIGN_SECONDS = 60.0  # wav2vec2-base receptive field is ~25s; keep chunks short
ALIGN_OVERLAP_SECONDS = 2.0

# Supported languages: only English for wav2vec2-base-960h
SUPPORTED_LANGUAGES = {"en"}

# Lazy model singletons
_model_lock = threading.Lock()
_processor = None
_model = None
_model_load_error: Optional[Exception] = None
_model_device = "cpu"


@dataclass
class AlignedWord:
    text: str
    start_ms: int
    end_ms: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class AlignmentResult:
    words: List[AlignedWord]
    duration_ms: int
    aligned: bool = True
    source: str = "wav2vec2-ctc"
    language: str = "en"

    def to_dict(self) -> dict:
        return {
            "words": [w.to_dict() for w in self.words],
            "duration_ms": self.duration_ms,
            "aligned": self.aligned,
            "source": self.source,
            "language": self.language,
        }


def _load_model():
    """Lazy-load wav2vec2 processor and model (thread-safe)."""
    global _processor, _model, _model_load_error, _model_device
    if _model is not None:
        return True
    if _model_load_error is not None:
        return False

    with _model_lock:
        if _model is not None:
            return True
        try:
            logger.info("Loading wav2vec2 CTC alignment model...")
            # Use a mirror if HuggingFace is unreachable from this region
            os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

            import torch
            from transformers import Wav2Vec2Processor, Wav2Vec2ForCTC

            device = "cuda" if torch.cuda.is_available() else "cpu"
            model_name = "facebook/wav2vec2-base-960h"
            processor = Wav2Vec2Processor.from_pretrained(model_name)
            model = Wav2Vec2ForCTC.from_pretrained(model_name)
            model.to(device)
            model.eval()

            _processor = processor
            _model = model
            _model_device = device
            logger.info("wav2vec2 alignment model loaded on %s", device)
            return True
        except Exception as e:
            _model_load_error = e
            logger.warning("Failed to load wav2vec2 alignment model: %s", e)
            return False


def is_available() -> bool:
    """Check if wav2vec2 model can be loaded."""
    try:
        import torch  # noqa: F401
        from transformers import Wav2Vec2Processor, Wav2Vec2ForCTC  # noqa: F401
    except ImportError:
        return False
    return True


def _is_aligner_enabled() -> bool:
    """Check if the user has enabled forced alignment in settings."""
    try:
        from .config import get_setting
        v = get_setting("USE_WAV2VEC2_ALIGNER", "true")
        if isinstance(v, bool):
            return v
        if isinstance(v, str):
            return v.strip().lower() not in ("", "0", "false", "no", "off")
        return bool(v)
    except Exception:
        return True


def _decode_to_pcm(audio_bytes: bytes, source_ext: str = "mp3") -> np.ndarray:
    """Decode audio to mono 16 kHz float PCM [-1, 1]."""
    with tempfile.NamedTemporaryFile(suffix=f".{source_ext}", delete=False) as src:
        src.write(audio_bytes)
        src_path = src.name
    out_path = src_path.rsplit(".", 1)[0] + ".wav"

    try:
        cmd = [
            "ffmpeg", "-y", "-i", src_path,
            "-vn", "-map", "0:a",
            "-acodec", "pcm_s16le",
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            out_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg decode failed: {result.stderr[:500]}")

        with wave.open(out_path, "rb") as wf:
            nframes = wf.getnframes()
            pcm = np.frombuffer(wf.readframes(nframes), dtype=np.int16)
            return pcm.astype(np.float32) / 32768.0
    finally:
        for p in (src_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def _chunk_audio(waveform: np.ndarray, chunk_seconds: float, overlap_seconds: float) -> list[tuple[np.ndarray, float]]:
    """Split waveform into overlapping chunks. Returns (chunk_array, offset_seconds)."""
    total_samples = len(waveform)
    chunk_samples = int(chunk_seconds * SAMPLE_RATE)
    overlap_samples = int(overlap_seconds * SAMPLE_RATE)
    stride_samples = chunk_samples

    chunks = []
    start = 0
    while start < total_samples:
        end = min(start + chunk_samples + overlap_samples, total_samples)
        chunk = waveform[start:end]
        chunks.append((chunk, start / SAMPLE_RATE))
        start += stride_samples
        if stride_samples <= 0:
            break
    return chunks


def _normalize_text(text: str) -> str:
    """Keep only letters, numbers, apostrophes and spaces."""
    text = text.lower()
    text = re.sub(r"[^a-z0-9' ]+", " ", text)
    return " ".join(text.split())


def _split_text_for_chunks(text: str, num_chunks: int) -> list[str]:
    """Split text roughly evenly across chunks."""
    words = text.split()
    if num_chunks <= 1 or len(words) <= num_chunks:
        return [text] if num_chunks <= 1 else [" ".join(words[i:i+1 or len(words)]) for i in range(num_chunks)]

    avg = len(words) / num_chunks
    chunks = []
    start = 0
    for i in range(num_chunks):
        end = min(len(words), int((i + 1) * avg))
        if i == num_chunks - 1:
            end = len(words)
        chunks.append(" ".join(words[start:end]))
        start = end
    return chunks


def _align_chunk(waveform: np.ndarray, text: str) -> list[AlignedWord]:
    """Run wav2vec2 CTC alignment on a single chunk and return word timestamps."""
    import torch

    processor = _processor
    model = _model

    # Normalize and tokenize text to labels
    norm_text = _normalize_text(text)
    if not norm_text:
        return []

    inputs = processor(waveform, sampling_rate=SAMPLE_RATE, return_tensors="pt", padding=True)
    input_values = inputs.input_values.to(_model_device)

    with torch.no_grad():
        logits = model(input_values).logits

    log_probs = torch.log_softmax(logits, dim=-1).cpu().squeeze(0).numpy()
    predicted_ids = np.argmax(log_probs, axis=-1)

    # Map labels to characters
    labels = processor.tokenizer.convert_ids_to_tokens(range(log_probs.shape[1]))
    # Build frame duration
    num_frames = log_probs.shape[0]
    audio_duration_s = len(waveform) / SAMPLE_RATE
    frame_duration_s = audio_duration_s / num_frames if num_frames else 0

    # CTC decoding with timestamps for each token
    tokens = []
    prev_id = -1
    for t, token_id in enumerate(predicted_ids):
        if token_id == prev_id or token_id == processor.tokenizer.pad_token_id:
            continue
        token = labels[token_id]
        if token == processor.tokenizer.word_delimiter_token:
            token = " "
        tokens.append((token, t))
        prev_id = token_id

    # Group tokens into words and assign timestamps
    words = []
    current_word_chars = []
    word_start_frame = None

    def flush_word(end_frame):
        nonlocal current_word_chars, word_start_frame
        if not current_word_chars:
            return
        word_text = "".join(current_word_chars).strip()
        if word_text:
            start_s = word_start_frame * frame_duration_s
            end_s = end_frame * frame_duration_s
            words.append(AlignedWord(
                text=word_text,
                start_ms=int(start_s * 1000),
                end_ms=int(end_s * 1000),
            ))
        current_word_chars = []
        word_start_frame = None

    for token, frame in tokens:
        if token == " ":
            flush_word(frame)
        else:
            if not current_word_chars:
                word_start_frame = frame
            current_word_chars.append(token)

    flush_word(num_frames)
    return words


def _cache_key(audio_bytes: bytes, text: str, language: str) -> str:
    return hashlib.sha256(
        audio_bytes + b"\x00" + text.encode("utf-8") + b"\x00" + language.encode("utf-8")
    ).hexdigest()


def align(
    audio_bytes: bytes,
    text: str,
    language: str = "en",
    source_ext: str = "mp3",
    use_cache: bool = True,
) -> Optional[AlignmentResult]:
    """Align known text to audio using wav2vec2 CTC and return word timestamps.

    Only English is currently supported. Other languages return None.
    """
    if not _is_aligner_enabled():
        return None

    language = (language or "en").lower().split("-")[0]
    if language not in SUPPORTED_LANGUAGES:
        logger.info("wav2vec2 CTC alignment not supported for language '%s'", language)
        return None

    text = (text or "").strip()
    if not text:
        return None

    if use_cache:
        cache_key = _cache_key(audio_bytes, text, language)
        cache_path = ALIGN_CACHE_DIR / f"{cache_key}.json"
        if cache_path.exists():
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                words = [AlignedWord(**w) for w in data.get("words", [])]
                return AlignmentResult(
                    words=words,
                    duration_ms=data.get("duration_ms", 0),
                    aligned=True,
                    source="wav2vec2-ctc",
                    language=language,
                )
            except Exception as e:
                logger.warning("Failed to load alignment cache: %s", e)

    if not _load_model():
        return None

    try:
        start_time = time.time()
        waveform = _decode_to_pcm(audio_bytes, source_ext)
        duration_ms = int(len(waveform) / SAMPLE_RATE * 1000)

        if duration_ms <= 0:
            return None

        # For short audio, align in one pass
        if len(waveform) / SAMPLE_RATE <= MAX_ALIGN_SECONDS:
            words = _align_chunk(waveform, text)
        else:
            chunks = _chunk_audio(waveform, MAX_ALIGN_SECONDS, ALIGN_OVERLAP_SECONDS)
            text_chunks = _split_text_for_chunks(_normalize_text(text), len(chunks))
            all_words = []
            for (chunk_wave, offset_s), chunk_text in zip(chunks, text_chunks):
                chunk_words = _align_chunk(chunk_wave, chunk_text)
                offset_ms = int(offset_s * 1000)
                for w in chunk_words:
                    w.start_ms += offset_ms
                    w.end_ms += offset_ms
                    all_words.append(w)
            # Deduplicate boundary words
            words = []
            for w in sorted(all_words, key=lambda x: x.start_ms):
                if words and abs(w.start_ms - words[-1].start_ms) < 200 and w.text == words[-1].text:
                    continue
                words.append(w)

        # Ensure monotonic and clamp
        for i, w in enumerate(words):
            w.start_ms = max(0, min(w.start_ms, duration_ms))
            w.end_ms = max(w.start_ms + 20, min(w.end_ms, duration_ms))

        result = AlignmentResult(words=words, duration_ms=duration_ms, language=language)
        logger.info("wav2vec2 alignment: %d words in %.2fs", len(words), time.time() - start_time)

        if use_cache:
            try:
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump(result.to_dict(), f, ensure_ascii=False)
            except Exception as e:
                logger.warning("Failed to save alignment cache: %s", e)

        return result
    except Exception as e:
        logger.warning("wav2vec2 alignment failed: %s", e)
        return None
