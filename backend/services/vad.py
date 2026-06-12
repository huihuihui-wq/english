"""Voice Activity Detection (VAD) service.

Two backends are available:
1. Silero VAD (default when installed) - neural network, ~2MB ONNX model.
   Most accurate for distinguishing speech from background music.
2. ffmpeg silencedetect (fallback) - volume-based, uses bandpass filter
   to isolate human voice frequency range (300-2500Hz).

Both produce identical output: list of {start_ms, end_ms} speech segments
and list of non-speech segments.
"""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# Lazy-loaded model (singleton)
_silero_model = None
_silero_available: Optional[bool] = None


def _get_silero_model():
    """Lazy-load Silero VAD ONNX model. Returns (model, True) on success, (None, False) on failure."""
    global _silero_model, _silero_available

    if _silero_available is False:
        return None, False
    if _silero_model is not None:
        return _silero_model, True

    try:
        from silero_vad import load_silero_vad
        _silero_model = load_silero_vad(onnx=True, opset_version=16)
        _silero_available = True
        logger.info("Silero VAD loaded successfully (ONNX)")
        return _silero_model, True
    except Exception as e:
        logger.warning("Silero VAD not available: %s", e)
        _silero_available = False
        return None, False


def is_silero_available() -> bool:
    """Check if Silero VAD is installed and importable."""
    _, ok = _get_silero_model()
    return ok


def _decode_audio_to_pcm(audio_bytes: bytes, source_ext: str = "mp3", target_sr: int = 16000) -> np.ndarray:
    """Decode audio bytes to mono 16kHz float32 PCM using ffmpeg."""
    src_path = None
    out_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=f".{source_ext}", delete=False) as src:
            src.write(audio_bytes)
            src_path = src.name
        out_path = src_path.rsplit(".", 1)[0] + "_pcm.wav"

        cmd = [
            "ffmpeg", "-y", "-i", src_path,
            "-ac", "1",
            "-ar", str(target_sr),
            "-acodec", "pcm_s16le",
            "-f", "wav",
            out_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg decode failed: {result.stderr[:200]}")

        import wave
        with wave.open(out_path, "rb") as wf:
            sr = wf.getframerate()
            if sr != target_sr:
                raise RuntimeError(f"sample rate mismatch: {sr}")
            data = wf.readframes(wf.getnframes())
        return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    finally:
        for p in (src_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def _silero_detect(audio_bytes: bytes, source_ext: str = "mp3") -> tuple[list[dict], list[dict], float]:
    """Run Silero VAD and return (speech, non_speech, duration_seconds)."""
    from silero_vad import get_speech_timestamps

    model, ok = _get_silero_model()
    if not ok:
        return [], [], 0.0

    wav = _decode_audio_to_pcm(audio_bytes, source_ext=source_ext)
    duration = len(wav) / 16000.0

    speech_ts = get_speech_timestamps(
        list(wav),
        model,
        sampling_rate=16000,
        return_seconds=True,
        min_speech_duration_ms=250,
        min_silence_duration_ms=100,
        speech_pad_ms=30,
    )

    speech = [
        {"start_ms": int(s["start"] * 1000), "end_ms": int(s["end"] * 1000)}
        for s in speech_ts
    ]

    # Build non-speech segments as gaps
    non_speech = []
    cursor_ms = 0
    for s in speech:
        if s["start_ms"] > cursor_ms:
            non_speech.append({"start_ms": cursor_ms, "end_ms": s["start_ms"]})
        cursor_ms = s["end_ms"]
    if int(duration * 1000) > cursor_ms:
        non_speech.append({"start_ms": cursor_ms, "end_ms": int(duration * 1000)})

    return speech, non_speech, duration


def _ffmpeg_detect(audio_bytes: bytes) -> tuple[list[dict], list[dict], float]:
    """ffmpeg-based VAD with voice-band filtering. Fallback when Silero unavailable.

    Uses highpass+lowpass (300-2500Hz) to isolate human voice, then silencedetect
    on the filtered stream. Catches gaps that include music, applause, pauses.
    """
    from .asr import detect_speech_segments  # reuse existing implementation
    speech, non_speech = detect_speech_segments(audio_bytes)
    # estimate duration from last segment end
    duration = 0.0
    if non_speech:
        duration = max(duration, non_speech[-1]["end_ms"] / 1000.0)
    if speech:
        duration = max(duration, speech[-1]["end_ms"] / 1000.0)
    return speech, non_speech, duration


def detect_speech_segments_unified(
    file_bytes: bytes,
    source_ext: str = "mp3",
    prefer: str = "auto",
) -> tuple[list[dict], list[dict], float]:
    """Detect speech segments using best available backend.

    Args:
        file_bytes: Raw audio bytes.
        source_ext: File extension hint for ffmpeg decoding.
        prefer: "auto" (Silero if available, else ffmpeg), "silero", or "ffmpeg".

    Returns:
        (speech_segments, non_speech_segments, duration_seconds)
        Each segment is {"start_ms": int, "end_ms": int}.
    """
    backend = prefer
    if prefer == "auto":
        backend = "silero" if is_silero_available() else "ffmpeg"

    if backend == "silero":
        try:
            speech, non_speech, duration = _silero_detect(file_bytes, source_ext)
            if speech or non_speech:
                logger.info("VAD (Silero): %d speech, %d non-speech, %.1fs",
                            len(speech), len(non_speech), duration)
                return speech, non_speech, duration
            logger.info("VAD (Silero) returned empty, falling back to ffmpeg")
        except Exception as e:
            logger.warning("Silero VAD failed (%s), falling back to ffmpeg", e)

    # ffmpeg fallback
    speech, non_speech, duration = _ffmpeg_detect(file_bytes)
    logger.info("VAD (ffmpeg fallback): %d speech, %d non-speech, %.1fs",
                len(speech), len(non_speech), duration)
    return speech, non_speech, duration
