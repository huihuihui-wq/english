"""Local ASR service using faster-whisper with wav2vec2 fallback alignment.

Flow:
  1. Extract audio to mono 16 kHz WAV.
  2. faster-whisper transcribes locally with word-level timestamps.
  3. Audio classifier labels music/applause/silence segments for placeholders.
  4. If Whisper produces no word timestamps but does produce text, fall back to
     local wav2vec2 CTC forced alignment.

No cloud API is required for transcription.
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import wave
from typing import List, Optional

import numpy as np

from .audio_classifier import classify_audio, filter_speech_segments
from .vad import detect_speech_segments_unified

logger = logging.getLogger(__name__)

# Lazy faster-whisper model singleton
_whisper_lock = threading.Lock()
_whisper_model = None
_whisper_model_name: Optional[str] = None

SAMPLE_RATE = 16000


def _get_config():
    from .config import get_setting
    return {
        "model": get_setting("WHISPER_MODEL", "base").strip() or "base",
    }


def _get_whisper_model():
    """Lazy-load faster-whisper model (thread-safe)."""
    global _whisper_model, _whisper_model_name
    if _whisper_model is not None:
        return _whisper_model

    with _whisper_lock:
        if _whisper_model is not None:
            return _whisper_model

        cfg = _get_config()
        model_name = cfg["model"]
        logger.info("Loading faster-whisper model: %s", model_name)

        try:
            import torch
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise RuntimeError(
                "faster-whisper is not installed. Run: pip install faster-whisper"
            ) from e

        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"

        # Use a mirror if HuggingFace is unreachable from this region
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

        try:
            _whisper_model = WhisperModel(
                model_name,
                device=device,
                compute_type=compute_type,
                download_root=None,
            )
            _whisper_model_name = model_name
            logger.info("faster-whisper loaded on %s (compute=%s)", device, compute_type)
            return _whisper_model
        except Exception as e:
            logger.exception("Failed to load faster-whisper model '%s': %s", model_name, e)
            raise


def _get_audio_duration_seconds(file_bytes: bytes) -> float:
    """Estimate duration from WAV header or byte size."""
    try:
        if file_bytes[:4] == b"RIFF":
            with wave.open(io.BytesIO(file_bytes), "rb") as wf:
                frames = wf.getnframes()
                rate = wf.getframerate()
                if rate > 0:
                    return frames / float(rate)
    except Exception:
        pass
    if len(file_bytes) > 0:
        return len(file_bytes) / 16000.0 / 2.0
    return 0.0


def _get_real_audio_duration_bytes(file_bytes: bytes, source_ext: str = "mp3") -> float:
    """Get accurate audio duration using ffprobe."""
    with tempfile.NamedTemporaryFile(suffix=f".{source_ext}", delete=False) as f:
        f.write(file_bytes)
        tmp = f.name
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                tmp,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            dur = float(result.stdout.strip())
            if dur > 0:
                return dur
    except Exception:
        pass
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return _get_audio_duration_seconds(file_bytes)


def _extract_ffmpeg_error(stderr: str) -> str:
    lines = stderr.splitlines()
    for i, line in enumerate(lines):
        low = line.lower()
        if any(k in low for k in ("error", "invalid", "unknown", "cannot", "failed", "unable")):
            return "\n".join(lines[i:i+3])
    non_empty = [l for l in lines if l.strip() and not l.strip().startswith("  ")]
    return "\n".join(non_empty[-5:]) if non_empty else stderr[:200]


def _extract_audio_to_wav(file_bytes: bytes, source_ext: str) -> bytes:
    """Extract/decode audio to mono 16 kHz WAV bytes."""
    src_path = None
    out_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=f".{source_ext}", delete=False) as src:
            src.write(file_bytes)
            src_path = src.name
        out_path = src_path.rsplit(".", 1)[0] + "_16k.wav"

        cmd = [
            "ffmpeg", "-y", "-i", src_path,
            "-vn",
            "-map", "0:a",
            "-acodec", "pcm_s16le",
            "-ac", "1",
            "-ar", str(SAMPLE_RATE),
            out_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        if result.returncode != 0:
            err = _extract_ffmpeg_error(result.stderr)
            logger.error("ffmpeg audio extraction failed: %s", err)
            raise RuntimeError(f"ffmpeg audio extraction failed: {err}")

        with open(out_path, "rb") as f:
            wav_bytes = f.read()

        logger.info("Audio extraction: %d -> %d bytes", len(file_bytes), len(wav_bytes))
        return wav_bytes
    finally:
        for p in (src_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def extract_audio_to_mp3(file_bytes: bytes, source_ext: str) -> bytes:
    """Backward-compatible helper: extract audio to MP3.

    Kept for any callers that expect MP3 output.
    """
    wav_bytes = _extract_audio_to_wav(file_bytes, source_ext)
    src_path = None
    out_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as src:
            src.write(wav_bytes)
            src_path = src.name
        out_path = src_path.rsplit(".", 1)[0] + ".mp3"
        cmd = [
            "ffmpeg", "-y", "-i", src_path,
            "-vn", "-acodec", "libmp3lame",
            "-ac", "1", "-ar", str(SAMPLE_RATE), "-b:a", "64k",
            out_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg mp3 encode failed: {result.stderr[:500]}")
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        for p in (src_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def _decode_wav_bytes(wav_bytes: bytes) -> np.ndarray:
    """Decode WAV bytes to float32 PCM [-1, 1]."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        nframes = wf.getnframes()
        pcm = np.frombuffer(wf.readframes(nframes), dtype=np.int16)
        return pcm.astype(np.float32) / 32768.0


def _normalize_word_for_match(word: str) -> str:
    """Normalize a word for case-insensitive matching."""
    return re.sub(r"[^a-z0-9']+", "", word.lower()).strip()


def _restore_word_casing(aligned_words: list[dict], original_text: str) -> list[dict]:
    """Restore original casing/punctuation for aligned words from ASR text."""
    if not aligned_words or not original_text:
        return aligned_words

    original_words = re.findall(r"[A-Za-z0-9]+(?:['\-][A-Za-z0-9]+)*", original_text)
    if not original_words:
        return aligned_words

    norm_originals = [(_normalize_word_for_match(w), w) for w in original_words]

    result = []
    orig_idx = 0
    for w in aligned_words:
        norm_aligned = _normalize_word_for_match(w.get("text", ""))
        if not norm_aligned:
            result.append(w)
            continue

        found = None
        search_start = orig_idx
        for i in range(search_start, min(search_start + 20, len(norm_originals))):
            if norm_originals[i][0] == norm_aligned:
                found = norm_originals[i][1]
                orig_idx = i + 1
                break

        if found:
            new_w = dict(w)
            new_w["text"] = found
            result.append(new_w)
        else:
            new_w = dict(w)
            new_w["text"] = w.get("text", "").lower()
            result.append(new_w)

    return result


def _apply_wav2vec2_fallback(
    result: dict,
    wav_bytes: bytes,
    language: str,
) -> dict:
    """Apply wav2vec2 CTC forced alignment as fallback when Whisper has no words."""
    try:
        from . import aligner
        if not aligner.is_available():
            result["aligned"] = False
            result["alignment_reason"] = "wav2vec2_not_available"
            return result

        text = (result.get("text") or "").strip()
        if not text:
            result["aligned"] = False
            result["alignment_reason"] = "empty_text"
            return result

        aligned = aligner.align(
            audio_bytes=wav_bytes,
            text=text,
            language=language,
            source_ext="wav",
            use_cache=True,
        )

        if aligned is None or not aligned.words:
            result["aligned"] = False
            result["alignment_reason"] = "wav2vec2_returned_empty"
            return result

        new_words = [
            {
                "text": w.text,
                "begin_time": w.start_ms,
                "end_time": w.end_ms,
            }
            for w in aligned.words
        ]
        new_words = _restore_word_casing(new_words, text)

        result["words"] = new_words
        result["aligned"] = True
        result["alignment_source"] = "wav2vec2-ctc"
        result["alignment_word_count"] = len(new_words)
        return result
    except Exception as e:
        logger.warning("wav2vec2 fallback alignment failed: %s", e)
        result["aligned"] = False
        result["alignment_reason"] = f"wav2vec2_error: {e}"
        return result


def _run_whisper(
    wav_bytes: bytes,
    language: str,
    speech_segments: Optional[list[dict]] = None,
) -> tuple[str, list[dict], list[dict]]:
    """Transcribe WAV audio with faster-whisper and return text + word timestamps.

    For long audio, we prefer chunks aligned with VAD speech segments. VAD
    boundaries act as anchor points: after chunked transcription, word timestamps
    inside each VAD segment are linearly scaled to fit the segment exactly. This
    corrects the cumulative drift that fixed-window chunking can introduce.
    """
    real_duration_ms = int(_get_real_audio_duration_bytes(wav_bytes, "wav") * 1000)

    # Short audio: transcribe in one pass
    if real_duration_ms <= 60000:
        text, words, segments = _run_whisper_on_wav_bytes(wav_bytes, language, offset_ms=0)
        if speech_segments:
            words = _calibrate_words_with_vad_anchors(words, speech_segments)
            segments = _calibrate_segments_with_vad_anchors(segments, speech_segments)
        return text, words, segments

    # Long audio: prefer VAD-based chunks; fall back to fixed windows
    if speech_segments:
        chunks = _build_vad_chunks(speech_segments)
        logger.info("Long audio: using %d VAD-based chunks for Whisper", len(chunks))
    else:
        chunk_ms = 30000
        overlap_ms = 500
        chunks = []
        start = 0
        while start < real_duration_ms:
            end = min(start + chunk_ms, real_duration_ms)
            chunks.append((start, end))
            if end == real_duration_ms:
                break
            start += chunk_ms - overlap_ms

    if len(chunks) <= 1:
        text, words, segments = _run_whisper_on_wav_bytes(wav_bytes, language, offset_ms=0)
        if speech_segments:
            words = _calibrate_words_with_vad_anchors(words, speech_segments)
            segments = _calibrate_segments_with_vad_anchors(segments, speech_segments)
        return text, words, segments

    logger.info("Long audio: splitting into %d chunks for Whisper", len(chunks))
    all_words: list[dict] = []
    all_segments: list[dict] = []
    text_parts: list[str] = []

    for chunk_idx, (chunk_start_ms, chunk_end_ms) in enumerate(chunks):
        chunk_bytes = _slice_wav_bytes(wav_bytes, chunk_start_ms, chunk_end_ms)
        chunk_text, chunk_words, chunk_segments = _run_whisper_on_wav_bytes(
            chunk_bytes, language, offset_ms=chunk_start_ms
        )
        if chunk_text:
            text_parts.append(chunk_text)
        all_words.extend(chunk_words)
        all_segments.extend(chunk_segments)
        logger.info(
            "Chunk %d/%d: %d words, %d segments",
            chunk_idx + 1, len(chunks), len(chunk_words), len(chunk_segments),
        )

    # Merge words and segments, removing overlaps / duplicates near chunk boundaries
    all_words = _merge_chunk_words(all_words)
    all_segments = _merge_chunk_segments(all_segments)

    # Global calibration using VAD anchors: scale each VAD speech segment so its
    # first and last Whisper words align with the VAD boundaries.
    if speech_segments:
        all_words = _calibrate_words_with_vad_anchors(all_words, speech_segments)
        all_segments = _calibrate_segments_with_vad_anchors(all_segments, speech_segments)
        # Re-merge in case calibration created tiny overlaps
        all_words = _merge_chunk_words(all_words)
        all_segments = _merge_chunk_segments(all_segments)

    text = " ".join(text_parts).strip()
    logger.info(
        "Whisper chunked transcribe done: text_len=%d, words=%d, segments=%d",
        len(text), len(all_words), len(all_segments),
    )
    return text, all_words, all_segments


def _calibrate_words_with_vad_anchors(
    words: list[dict],
    speech_segments: list[dict],
) -> list[dict]:
    """Scale word timestamps to fit VAD speech-segment boundaries.

    Each VAD segment provides a reliable anchor [start_ms, end_ms]. Words whose
    begin_time falls inside the segment are linearly mapped so the first and last
    word touch the anchor boundaries. This removes cumulative drift from chunked
    transcription without changing the relative spacing inside the segment.
    """
    if not words or not speech_segments:
        return words

    words = sorted(words, key=lambda w: w["begin_time"])
    used: set[int] = set()
    calibrated: list[dict] = []

    for vad_seg in sorted(speech_segments, key=lambda s: s["start_ms"]):
        vad_start = max(0, int(vad_seg["start_ms"]))
        vad_end = max(vad_start, int(vad_seg["end_ms"]))

        seg_indices = [
            i for i, w in enumerate(words)
            if vad_start <= w["begin_time"] <= vad_end and i not in used
        ]
        if not seg_indices:
            continue

        seg_words = [words[i] for i in seg_indices]
        if len(seg_words) == 1:
            w = dict(seg_words[0])
            dur = max(50, w["end_time"] - w["begin_time"])
            w["begin_time"] = vad_start
            w["end_time"] = min(vad_start + dur, vad_end)
            calibrated.append(w)
            used.add(seg_indices[0])
            continue

        whisper_start = seg_words[0]["begin_time"]
        whisper_end = seg_words[-1]["end_time"]
        whisper_span = max(1, whisper_end - whisper_start)
        vad_span = max(1, vad_end - vad_start)

        for idx in seg_indices:
            w = dict(words[idx])
            w["begin_time"] = vad_start + int(
                (w["begin_time"] - whisper_start) * vad_span / whisper_span
            )
            w["end_time"] = vad_start + int(
                (w["end_time"] - whisper_start) * vad_span / whisper_span
            )
            w["begin_time"] = max(vad_start, min(w["begin_time"], vad_end))
            w["end_time"] = max(w["begin_time"], min(w["end_time"], vad_end))
            calibrated.append(w)
            used.add(idx)

    # Preserve any words that did not fall into a VAD segment
    for i, w in enumerate(words):
        if i not in used:
            calibrated.append(dict(w))

    return sorted(calibrated, key=lambda w: w["begin_time"])


def _calibrate_segments_with_vad_anchors(
    segments: list[dict],
    speech_segments: list[dict],
) -> list[dict]:
    """Scale Whisper segment boundaries using VAD anchors, mirroring word calibration."""
    if not segments or not speech_segments:
        return segments

    segments = sorted(segments, key=lambda s: s["start_ms"])
    used: set[int] = set()
    calibrated: list[dict] = []

    for vad_seg in sorted(speech_segments, key=lambda s: s["start_ms"]):
        vad_start = max(0, int(vad_seg["start_ms"]))
        vad_end = max(vad_start, int(vad_seg["end_ms"]))

        seg_indices = [
            i for i, s in enumerate(segments)
            if vad_start <= s["start_ms"] <= vad_end and i not in used
        ]
        if not seg_indices:
            continue

        seg_segs = [segments[i] for i in seg_indices]
        if len(seg_segs) == 1:
            s = dict(seg_segs[0])
            s["start_ms"] = vad_start
            s["end_ms"] = vad_end
            calibrated.append(s)
            used.add(seg_indices[0])
            continue

        whisper_start = seg_segs[0]["start_ms"]
        whisper_end = seg_segs[-1]["end_ms"]
        whisper_span = max(1, whisper_end - whisper_start)
        vad_span = max(1, vad_end - vad_start)

        for idx in seg_indices:
            s = dict(segments[idx])
            s["start_ms"] = vad_start + int(
                (s["start_ms"] - whisper_start) * vad_span / whisper_span
            )
            s["end_ms"] = vad_start + int(
                (s["end_ms"] - whisper_start) * vad_span / whisper_span
            )
            s["start_ms"] = max(vad_start, min(s["start_ms"], vad_end))
            s["end_ms"] = max(s["start_ms"], min(s["end_ms"], vad_end))

            if s.get("words"):
                s["words"] = [
                    {
                        **w,
                        "begin_time": vad_start + int(
                            (w["begin_time"] - whisper_start) * vad_span / whisper_span
                        ),
                        "end_time": vad_start + int(
                            (w["end_time"] - whisper_start) * vad_span / whisper_span
                        ),
                    }
                    for w in s["words"]
                ]
            calibrated.append(s)
            used.add(idx)

    for i, s in enumerate(segments):
        if i not in used:
            calibrated.append(dict(s))

    return sorted(calibrated, key=lambda s: s["start_ms"])


def _build_vad_chunks(speech_segments: list[dict], max_chunk_ms: int = 30000, overlap_ms: int = 500) -> list[tuple[int, int]]:
    """Build transcription chunks from VAD speech segments.

    Merges adjacent speech segments and splits long merged segments into chunks
    of at most max_chunk_ms, with small overlap at boundaries.
    """
    if not speech_segments:
        return []

    # Sort and merge overlapping/adjacent speech segments
    sorted_segs = sorted(speech_segments, key=lambda x: x["start_ms"])
    merged = []
    for seg in sorted_segs:
        start = seg["start_ms"]
        end = seg["end_ms"]
        if merged and start <= merged[-1][1] + overlap_ms:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    chunks = []
    for start, end in merged:
        duration = end - start
        if duration <= max_chunk_ms:
            chunks.append((max(0, start), end))
            continue

        # Split long merged segment into max_chunk_ms chunks
        pos = start
        while pos < end:
            chunk_end = min(pos + max_chunk_ms, end)
            chunks.append((max(0, pos), chunk_end))
            pos += max_chunk_ms - overlap_ms
            if chunk_end == end:
                break

    return chunks


def _slice_wav_bytes(wav_bytes: bytes, start_ms: int, end_ms: int) -> bytes:
    """Slice a WAV byte buffer by time using ffmpeg."""
    src_path = None
    out_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav_bytes)
            src_path = f.name
        out_path = src_path.rsplit(".", 1)[0] + f"_slice_{start_ms}_{end_ms}.wav"

        duration_ms = end_ms - start_ms
        cmd = [
            "ffmpeg", "-y", "-i", src_path,
            "-vn", "-acodec", "pcm_s16le",
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            "-ss", str(start_ms / 1000.0),
            "-t", str(duration_ms / 1000.0),
            out_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg slice failed: {result.stderr[:500]}")

        with open(out_path, "rb") as f:
            return f.read()
    finally:
        for p in (src_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def _merge_chunk_words(words: list[dict]) -> list[dict]:
    """Merge words from overlapping chunks and remove duplicates."""
    if not words:
        return words

    # Sort by time
    words = sorted(words, key=lambda w: (w["begin_time"], w["end_time"]))
    merged = []
    for w in words:
        if merged and abs(w["begin_time"] - merged[-1]["begin_time"]) < 200 and w["text"] == merged[-1]["text"]:
            continue
        merged.append(w)
    return merged


def _merge_chunk_segments(segments: list[dict]) -> list[dict]:
    """Merge Whisper segments from overlapping chunks and remove duplicates.

    Duplicates often appear at chunk boundaries where the overlapping audio is
    transcribed again. We merge them if they overlap or are adjacent and have
    the same text. Overlapping segments with different text are kept as-is;
    subtitle.py will resolve small overlaps at display time.
    """
    if not segments:
        return segments

    def norm(text: str) -> str:
        return re.sub(r"[^a-z0-9]", "", (text or "").lower())

    segments = sorted(segments, key=lambda s: (s["start_ms"], s["end_ms"]))
    merged = []
    for s in segments:
        if not merged:
            merged.append(s)
            continue

        last = merged[-1]
        overlap = min(s["end_ms"], last["end_ms"]) - max(s["start_ms"], last["start_ms"])
        gap = s["start_ms"] - last["end_ms"]
        same_text = norm(s.get("text", "")) == norm(last.get("text", ""))

        # Overlapping or adjacent duplicate: merge time spans
        if (overlap > 0 or gap <= 500) and same_text:
            last["start_ms"] = min(last["start_ms"], s["start_ms"])
            last["end_ms"] = max(last["end_ms"], s["end_ms"])
            continue

        # Otherwise keep both segments (even if they overlap)
        merged.append(s)

    return merged


def _run_whisper_on_wav_bytes(wav_bytes: bytes, language: str, offset_ms: int = 0) -> tuple[str, list[dict], list[dict]]:
    """Transcribe a single WAV buffer with faster-whisper.

    Returns (text, words, segments) where segments are Whisper's own segment
    boundaries with timestamps in milliseconds relative to the full audio.
    """
    model = _get_whisper_model()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav_bytes)
        wav_path = f.name

    try:
        segments, info = model.transcribe(
            wav_path,
            language=language if language else None,
            task="transcribe",
            word_timestamps=True,
            vad_filter=True,
            condition_on_previous_text=True,
        )

        words: list[dict] = []
        text_parts: list[str] = []
        whisper_segments: list[dict] = []
        for segment in segments:
            segment_text = segment.text or ""
            text_parts.append(segment_text)
            seg_start_ms = max(0, int(segment.start * 1000) + offset_ms)
            seg_end_ms = max(0, int(segment.end * 1000) + offset_ms)
            seg_words: list[dict] = []
            if segment.words:
                for word in segment.words:
                    w_text = (word.word or "").strip()
                    if not w_text:
                        continue
                    w = {
                        "text": w_text,
                        "begin_time": max(0, int(word.start * 1000) + offset_ms),
                        "end_time": max(0, int(word.end * 1000) + offset_ms),
                    }
                    words.append(w)
                    seg_words.append(w)
            whisper_segments.append({
                "start_ms": seg_start_ms,
                "end_ms": seg_end_ms,
                "text": segment_text.strip(),
                "words": seg_words,
            })

        text = " ".join(text_parts).strip()
        return text, words, whisper_segments
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


def _override_non_speech_with_whisper_words(
    classified_segments: list[dict],
    words: list[dict],
    duration_ms: int,
    coverage_threshold: float = 0.20,
) -> list[dict]:
    """Re-label non-speech segments as speech if Whisper detected words there.

    This is the critical safety check that prevents dialogue from being
    overwritten by music/applause placeholders. If more than 20% of a classified
    non-speech region contains transcribed words, it is speech.
    """
    if not classified_segments or not words:
        return classified_segments or []

    word_ranges = sorted(
        [(int(w.get("begin_time", 0)), int(w.get("end_time", 0))) for w in words],
        key=lambda x: x[0],
    )

    def word_coverage(start_ms: int, end_ms: int) -> float:
        if end_ms <= start_ms:
            return 0.0
        total = 0
        for wb, we in word_ranges:
            if we <= start_ms:
                continue
            if wb >= end_ms:
                break
            total += min(we, end_ms) - max(wb, start_ms)
        return total / (end_ms - start_ms)

    refined = []
    for seg in classified_segments:
        label = seg["label"]
        start_ms = int(seg["start_ms"])
        end_ms = int(seg["end_ms"])
        dur = end_ms - start_ms
        cov = word_coverage(start_ms, end_ms)

        if label != "speech" and cov > coverage_threshold:
            logger.info(
                "Reclassifying %dms-%dms from %s to speech (Whisper coverage %.0f%%)",
                start_ms, end_ms, label, cov * 100,
            )
            label = "speech"

        refined.append({
            "label": label,
            "start_ms": start_ms,
            "end_ms": end_ms,
        })

    # Merge adjacent same-label segments
    merged = []
    for seg in refined:
        if merged and merged[-1]["label"] == seg["label"]:
            merged[-1]["end_ms"] = seg["end_ms"]
        else:
            merged.append(seg)

    return merged


async def transcribe_audio(
    file_bytes: bytes,
    filename: str,
    content_type: str,
    language: str = "en",
) -> dict:
    """Transcribe audio/video locally using faster-whisper.

    Returns dict with:
        text: full transcript
        words: list of {text, begin_time, end_time}
        duration_ms: audio duration
        aligned: whether word timestamps were obtained
        alignment_source: "whisper" or "wav2vec2-ctc" or ""
        whisper_segments: Whisper segment boundaries
        segments: {speech, non_speech}
        classified_segments: music/applause/silence/speech labels
    """
    source_ext = (filename.rsplit(".", 1)[-1] if "." in filename else "mp4").lower()
    is_video = (
        content_type.startswith("video/")
        or source_ext in ("mp4", "mov", "avi", "mkv", "flv", "webm")
    )

    logger.info(
        "Local ASR start: filename=%s, is_video=%s, size=%.1fMB, lang=%s",
        filename, is_video, len(file_bytes) / 1024 / 1024, language,
    )

    # Convert input to 16kHz mono WAV
    wav_bytes = _extract_audio_to_wav(file_bytes, source_ext)
    real_duration = _get_real_audio_duration_bytes(wav_bytes, "wav")

    # Step 1: VAD + classification must complete before chunked Whisper
    loop = asyncio.get_running_loop()

    def run_vad_and_classify():
        speech, non_speech, _ = detect_speech_segments_unified(
            wav_bytes, source_ext="wav", prefer="auto",
        )
        classified = classify_audio(wav_bytes, source_ext="wav", speech_segments=speech)
        return speech, non_speech, classified

    speech_segments, non_speech_segments, classified_segments = await loop.run_in_executor(
        None, run_vad_and_classify
    )

    # Step 2: transcribe. For long audio, _run_whisper uses VAD-based chunks and
    # calibrates word timestamps against VAD anchors to reduce cumulative drift.
    text, words, whisper_segments = await loop.run_in_executor(
        None, _run_whisper, wav_bytes, language, speech_segments
    )

    result = {
        "text": text,
        "words": words,
        "whisper_segments": whisper_segments,
        "duration_ms": int(real_duration * 1000),
        "aligned": len(words) > 0,
        "alignment_source": "whisper" if words else "",
        "alignment_reason": "" if words else "whisper_no_word_timestamps",
        "segments": {
            "speech": speech_segments,
            "non_speech": non_speech_segments,
        },
        "classified_segments": classified_segments,
    }

    # Fallback to wav2vec2 if Whisper gave text but no word timestamps
    if text and not words:
        logger.info("Whisper produced no word timestamps; trying wav2vec2 fallback")
        result = await loop.run_in_executor(
            None, _apply_wav2vec2_fallback, result, wav_bytes, language,
        )

    # Refine classification using Whisper word coverage: any region that
    # actually contains transcribed words is speech, regardless of what the
    # acoustic classifier said. This prevents dialogue from being overwritten
    # by music/applause placeholders.
    if result.get("classified_segments") and result.get("words"):
        refined = _override_non_speech_with_whisper_words(
            result["classified_segments"], result["words"], result.get("duration_ms", 0),
        )
        result["classified_segments"] = refined
        cls_speech, cls_non_speech = filter_speech_segments(refined)
        result["segments"] = {
            "speech": cls_speech,
            "non_speech": cls_non_speech,
        }

    logger.info(
        "Local ASR done: aligned=%s, source=%s, words=%d, duration=%.1fs",
        result.get("aligned"), result.get("alignment_source"), len(result.get("words", [])),
        real_duration,
    )
    return result


# ---------------------------------------------------------------------------
# ffmpeg-based VAD fallback (imported by services/vad.py)
# ---------------------------------------------------------------------------

def detect_speech_segments(
    file_bytes: bytes,
    noise_db: int = -45,
    min_silence_duration: float = 1.0,
) -> tuple[list[dict], list[dict]]:
    """Use ffmpeg silencedetect with voice-band filtering to find speech segments."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(file_bytes)
        tmp = f.name

    try:
        af_chain = (
            f"highpass=f=300,lowpass=f=2500,"
            f"silencedetect=noise=-50dB:d=0.8"
        )
        cmd = [
            "ffmpeg", "-y", "-i", tmp,
            "-af", af_chain,
            "-f", "null", "-",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

        silence_starts = []
        silence_ends = []
        for line in result.stderr.splitlines():
            if "silence_start:" in line:
                try:
                    t = float(line.split("silence_start:")[-1].strip())
                    silence_starts.append(t)
                except ValueError:
                    pass
            elif "silence_end:" in line:
                try:
                    parts = line.split("silence_end:")[-1].strip().split("|")[0].strip()
                    t = float(parts)
                    silence_ends.append(t)
                except ValueError:
                    pass

        duration = _get_real_audio_duration_bytes(file_bytes, "wav")

        raw_speech = []
        raw_non_speech = []
        cursor = 0.0
        for i, start in enumerate(silence_starts):
            end = silence_ends[i] if i < len(silence_ends) else None
            if start > cursor:
                raw_speech.append({"start_ms": int(cursor * 1000), "end_ms": int(start * 1000)})
            if end is not None:
                raw_non_speech.append({"start_ms": int(start * 1000), "end_ms": int(end * 1000)})
                cursor = end
            else:
                raw_non_speech.append({"start_ms": int(start * 1000), "end_ms": int(duration * 1000)})
                cursor = duration
                break

        if cursor < duration:
            raw_speech.append({"start_ms": int(cursor * 1000), "end_ms": int(duration * 1000)})

        MIN_SPEECH_MS = 500
        filtered_speech = [s for s in raw_speech if s["end_ms"] - s["start_ms"] >= MIN_SPEECH_MS]

        GAP_THRESHOLD_MS = 2000
        merged_speech = []
        for seg in filtered_speech:
            if not merged_speech:
                merged_speech.append(seg)
            else:
                last = merged_speech[-1]
                gap = seg["start_ms"] - last["end_ms"]
                if gap <= GAP_THRESHOLD_MS:
                    last["end_ms"] = seg["end_ms"]
                else:
                    merged_speech.append(seg)

        merged_non_speech = []
        cursor_ms = 0
        for seg in merged_speech:
            if seg["start_ms"] > cursor_ms:
                merged_non_speech.append({"start_ms": cursor_ms, "end_ms": seg["start_ms"]})
            cursor_ms = seg["end_ms"]
        if cursor_ms < int(duration * 1000):
            merged_non_speech.append({"start_ms": cursor_ms, "end_ms": int(duration * 1000)})

        logger.info("VAD: %d raw speech -> %d merged speech, %d non-speech (dur=%.1fs)",
                    len(filtered_speech), len(merged_speech), len(merged_non_speech), duration)

        return merged_speech, merged_non_speech
    except Exception as e:
        logger.warning("VAD detection failed: %s", e)
        return [], []
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
