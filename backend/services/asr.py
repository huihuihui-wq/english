"""DashScope ASR service with wav2vec2 CTC forced alignment.

Flow:
  1. DashScope qwen3-asr-flash returns the transcript text.
  2. For English audio, wav2vec2 CTC aligns the transcript to the audio,
     producing word-level timestamps locally.
  3. Non-English audio falls back to sentence-level proportional timestamps.
"""
import asyncio
import base64
import io
import logging
import os
import re
import subprocess
import tempfile
import wave

import httpx

from .audio_classifier import classify_audio
from .vad import detect_speech_segments_unified

logger = logging.getLogger(__name__)

MAX_INLINE_BYTES = 9 * 1024 * 1024
DEFAULT_MAX_ASR_AUDIO_SECONDS = 120
DEFAULT_OVERLAP_SECONDS = 20.0


def _get_config():
    from services.config import get_setting
    return {
        "api_key": get_setting("DASHSCOPE_API_KEY", ""),
        "base_url": get_setting("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/api/v1"),
        "model": get_setting("ASR_MODEL", "qwen3-asr-flash"),
    }


def _get_audio_duration_seconds(file_bytes: bytes) -> float:
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
        return len(file_bytes) / 8000.0
    return 0.0


def _get_real_audio_duration_bytes(file_bytes: bytes) -> float:
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
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


def extract_audio_to_mp3(file_bytes: bytes, source_ext: str) -> bytes:
    src_path = None
    out_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=f".{source_ext}", delete=False) as src:
            src.write(file_bytes)
            src_path = src.name
        out_path = src_path.rsplit(".", 1)[0] + "_converted.mp3"

        cmd = [
            "ffmpeg", "-y", "-i", src_path,
            "-vn",
            "-map", "0:a",
            "-acodec", "libmp3lame",
            "-ac", "1",
            "-ar", "16000",
            "-b:a", "64k",
            out_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            err = _extract_ffmpeg_error(result.stderr)
            logger.error("ffmpeg failed: %s", err)
            raise RuntimeError(f"ffmpeg audio extraction failed: {err}")

        with open(out_path, "rb") as f:
            mp3_bytes = f.read()

        logger.info("Audio extraction: %d -> %d bytes", len(file_bytes), len(mp3_bytes))
        return mp3_bytes
    finally:
        for p in (src_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def _slice_audio_to_segments(mp3_bytes: bytes, segment_seconds: float, overlap_seconds: float) -> list[tuple[bytes, float]]:
    total_duration = _get_real_audio_duration_bytes(mp3_bytes)
    if total_duration <= segment_seconds:
        return [(mp3_bytes, 0.0)]

    stride = segment_seconds
    segments = []

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as src:
        src.write(mp3_bytes)
        src_path = src.name

    try:
        start = 0.0
        while start < total_duration:
            duration = min(segment_seconds + overlap_seconds, total_duration - start)
            out_path = src_path + f"_seg_{start:.1f}.mp3"

            cmd = [
                "ffmpeg", "-y",
                "-ss", str(start),
                "-i", src_path,
                "-vn", "-acodec", "libmp3lame",
                "-ac", "1", "-ar", "16000", "-b:a", "64k",
                "-t", str(duration),
                out_path,
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
            if result.returncode != 0:
                err = _extract_ffmpeg_error(result.stderr)
                logger.error("ffmpeg slice failed at %.1fs: %s", start, err)
                raise RuntimeError(f"ffmpeg slicing failed at {start:.1f}s: {err}")

            with open(out_path, "rb") as f:
                seg_bytes = f.read()

            try:
                os.unlink(out_path)
            except OSError:
                pass

            if len(seg_bytes) < 1024:
                logger.warning("Segment at %.1fs is empty (%d bytes), skipping", start, len(seg_bytes))
                start += stride
                continue

            segments.append((seg_bytes, start))
            start += stride

            if stride <= 0:
                break

        logger.info("Sliced audio: %.1fs -> %d segments (stride=%.1fs, overlap=%.1fs)",
                    total_duration, len(segments), stride, overlap_seconds)
        return segments
    finally:
        try:
            os.unlink(src_path)
        except OSError:
            pass


def _sentence_terminator_pattern(language: str) -> str:
    if language in ("zh", "ja"):
        return r"[。！？\.\!\?]+"
    return r"[\.\!\?]+"


def _merge_segment_texts(texts: list[str], language: str = "en") -> str:
    if not texts:
        return ""

    pat = _sentence_terminator_pattern(language)
    result = texts[0]
    for next_text in texts[1:]:
        result_sentences = [s.strip() for s in re.split(pat, result) if s.strip()]
        next_sentences = [s.strip() for s in re.split(pat, next_text) if s.strip()]
        if not result_sentences or not next_sentences:
            result = result + " " + next_text
            continue

        overlap_count = 0
        max_check = min(len(result_sentences), len(next_sentences), 5)
        for i in range(1, max_check + 1):
            if result_sentences[-i:] == next_sentences[:i]:
                overlap_count = i

        if overlap_count:
            append_idx = next_text.find(next_sentences[overlap_count])
            if append_idx > 0 and next_text[append_idx - 1].isspace():
                append_idx -= 1
            result = result + next_text[append_idx:]
        else:
            result = result + " " + next_text

    return result.strip()


async def _call_asr_api(file_bytes: bytes, language: str, cfg: dict) -> dict:
    b64 = base64.b64encode(file_bytes).decode()
    data_uri = f"data:audio/mpeg;base64,{b64}"

    payload = {
        "model": cfg["model"],
        "input": {
            "messages": [
                {"role": "system", "content": [{"text": ""}]},
                {"role": "user", "content": [{"audio": data_uri}]},
            ]
        },
        "parameters": {
            "asr_options": {
                "language": language,
                "enable_itn": False,
            },
        },
    }

    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }

    url = f"{cfg['base_url']}/services/aigc/multimodal-generation/generation"
    logger.info("ASR request: model=%s, size=%d bytes", cfg["model"], len(file_bytes))

    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(url, headers=headers, json=payload)

    if resp.status_code != 200:
        logger.error("ASR failed: %s %s", resp.status_code, resp.text[:500])
        raise RuntimeError(f"ASR request failed: {resp.status_code} {resp.text[:300]}")

    parsed = _parse_response(resp.json())
    logger.info("ASR segment response: text_len=%d", len(parsed.get("text", "")))
    return parsed


def _parse_response(resp: dict) -> dict:
    try:
        choices = resp["output"]["choices"]
        if not choices:
            raise RuntimeError("ASR returned empty choices")
        msg = choices[0]["message"]

        text = ""
        audio_duration_ms = 0

        if isinstance(msg, dict) and "text" in msg:
            text = msg["text"]

        content = msg.get("content") if isinstance(msg, dict) else None
        if isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                if "text" in item and not text:
                    text = item["text"]
                if "audio_duration_ms" in item:
                    audio_duration_ms = int(item["audio_duration_ms"])

        if not text:
            raise RuntimeError(f"No text found in ASR response: {resp}")

        return {
            "text": text.strip(),
            "duration_ms": audio_duration_ms,
        }
    except (KeyError, IndexError, TypeError) as e:
        logger.exception("Failed to parse ASR response: %s", e)
        raise RuntimeError(f"Failed to parse ASR response: {e}; raw={str(resp)[:300]}")


async def _transcribe_segment(seg_bytes: bytes, offset_seconds: float, language: str, cfg: dict) -> dict:
    parsed = await _call_asr_api(seg_bytes, language, cfg)
    return {
        "text": parsed.get("text", ""),
    }


def _refine_classified_segments(
    classified_segments: list[dict],
    words: list[dict],
    duration_ms: int,
) -> list[dict]:
    """Use alignment word coverage to fix speech segments that are actually music.

    Only converts speech -> music when there is very low word coverage, which
    usually means intro/outro music or long background music misclassified as
    speech. We intentionally do NOT convert music -> speech here to avoid
    turning real music into speech placeholders.
    """
    if not classified_segments:
        return classified_segments

    word_ranges = [(int(w.get("begin_time", 0)), int(w.get("end_time", 0))) for w in words]

    def word_coverage(start_ms: int, end_ms: int) -> float:
        if not word_ranges or end_ms <= start_ms:
            return 0.0
        total_word_ms = 0
        for wb, we in word_ranges:
            overlap = max(0, min(we, end_ms) - max(wb, start_ms))
            total_word_ms += overlap
        return total_word_ms / (end_ms - start_ms)

    refined = []
    for seg in classified_segments:
        label = seg["label"]
        start_ms = int(seg["start_ms"])
        end_ms = int(seg["end_ms"])
        dur = end_ms - start_ms
        cov = word_coverage(start_ms, end_ms)

        # Low coverage speech segment = likely music/background.
        if label == "speech" and cov < 0.10 and dur > 1500:
            label = "music"

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


def _normalize_word_for_match(word: str) -> str:
    """Normalize a word for case-insensitive matching."""
    return re.sub(r"[^a-z0-9']+", "", word.lower()).strip()


def _restore_word_casing(aligned_words: list[dict], original_text: str) -> list[dict]:
    """Restore original casing/punctuation for aligned words from ASR text.

    wav2vec2 returns uppercase/lowercase normalized tokens; we map them back
    to the original words in the ASR transcript to preserve readable subtitles.
    """
    if not aligned_words or not original_text:
        return aligned_words

    # Split original text into words roughly matching the normalized tokens.
    # Keep apostrophes and hyphens inside words.
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

        # Find next matching original word
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
            # No match: at least convert to lowercase for readability
            new_w = dict(w)
            new_w["text"] = w.get("text", "").lower()
            result.append(new_w)

    return result


def _apply_forced_alignment(
    result: dict,
    file_bytes: bytes,
    language: str,
    source_ext: str = "mp3",
) -> dict:
    """Apply wav2vec2 CTC forced alignment to ASR text."""
    try:
        from . import aligner
        if not aligner.is_available():
            result["aligned"] = False
            result["alignment_reason"] = "aligner_not_available"
            return result

        text = (result.get("text") or "").strip()
        if not text:
            result["aligned"] = False
            result["alignment_reason"] = "empty_text"
            return result

        aligned = aligner.align(
            audio_bytes=file_bytes,
            text=text,
            language=language,
            source_ext=source_ext,
            use_cache=True,
        )

        if aligned is None or not aligned.words:
            result["aligned"] = False
            result["alignment_reason"] = "aligner_returned_empty"
            return result

        new_words = [
            {
                "text": w.text,
                "begin_time": w.start_ms,
                "end_time": w.end_ms,
            }
            for w in aligned.words
        ]

        # Restore original casing from ASR transcript
        new_words = _restore_word_casing(new_words, text)

        result["words"] = new_words
        result["aligned"] = True
        result["alignment_source"] = "wav2vec2-ctc"
        result["alignment_word_count"] = len(new_words)
        return result
    except Exception as e:
        logger.warning("wav2vec2 alignment failed, falling back: %s", e)
        result["aligned"] = False
        result["alignment_reason"] = f"error: {e}"
        return result


async def transcribe_audio(file_bytes: bytes, filename: str, content_type: str, language: str = "en") -> dict:
    cfg = _get_config()
    if not cfg["api_key"]:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured")

    source_ext = (filename.rsplit(".", 1)[-1] if "." in filename else "mp4").lower()
    estimated_duration = _get_audio_duration_seconds(file_bytes)
    max_audio_seconds = int(os.getenv("MAX_ASR_AUDIO_SECONDS", str(DEFAULT_MAX_ASR_AUDIO_SECONDS)))
    likely_too_long = estimated_duration > max_audio_seconds

    is_video = content_type.startswith("video/") or source_ext in ("mp4", "mov", "avi", "mkv", "flv", "webm")

    if is_video or len(file_bytes) > MAX_INLINE_BYTES or likely_too_long:
        if not is_video and len(file_bytes) > MAX_INLINE_BYTES and source_ext not in ("mp3", "wav", "m4a", "aac", "ogg", "flac", "wma"):
            raise RuntimeError(f"File is {len(file_bytes)/1024/1024:.1f}MB and exceeds the 9MB inline limit. Only compressed audio (mp3/wav/m4a) is supported.")
        kind = "video" if is_video else ("large file" if len(file_bytes) > MAX_INLINE_BYTES else "long audio")
        logger.info("Detected %s, extracting audio with ffmpeg", kind)
        file_bytes = extract_audio_to_mp3(file_bytes, source_ext)

    if len(file_bytes) > MAX_INLINE_BYTES:
        raise RuntimeError(f"After extraction the file is still {len(file_bytes)/1024/1024:.1f}MB > 9MB. Please use a shorter clip.")

    real_duration = _get_real_audio_duration_bytes(file_bytes)

    speech_segments, non_speech_segments, _ = detect_speech_segments_unified(
        file_bytes, source_ext="mp3", prefer="auto",
    )

    if real_duration > max_audio_seconds:
        overlap_seconds = DEFAULT_OVERLAP_SECONDS
        segment_seconds = max(30.0, float(max_audio_seconds) - overlap_seconds)
        segments = _slice_audio_to_segments(file_bytes, segment_seconds, overlap_seconds)

        if len(segments) > 50:
            raise RuntimeError(
                f"Audio is too long ({real_duration:.0f}s). "
                f"Automatic slicing would create {len(segments)} segments, which exceeds the safety limit of 50. "
                f"Please use a shorter clip or increase MAX_ASR_AUDIO_SECONDS if your model supports it."
            )

        semaphore = asyncio.Semaphore(3)

        async def transcribe_with_limit(seg_bytes, offset):
            async with semaphore:
                return await _transcribe_segment(seg_bytes, offset, language, cfg)

        tasks = [transcribe_with_limit(seg_bytes, offset) for seg_bytes, offset in segments]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        segment_texts = []
        for i, res in enumerate(results):
            if isinstance(res, Exception):
                logger.error("Segment %d transcription failed: %s", i, res)
                raise RuntimeError(f"Segment {i} transcription failed: {res}")
            if res.get("text"):
                segment_texts.append(res["text"])
            logger.info("Segment %d: text_len=%d", i, len(res.get("text", "")))

        text = _merge_segment_texts(segment_texts, language)
        result = {
            "text": text,
            "words": [],
            "duration_ms": int(real_duration * 1000),
        }
    else:
        asr_result = await _call_asr_api(file_bytes, language, cfg)
        logger.info("ASR ok: text_len=%d", len(asr_result.get("text", "")))
        result = {
            "text": asr_result.get("text", ""),
            "words": [],
            "duration_ms": asr_result.get("duration_ms", 0),
        }

    if speech_segments or non_speech_segments:
        result["segments"] = {
            "speech": speech_segments,
            "non_speech": non_speech_segments,
        }

    # Classify audio segments (music/applause/silence/speech)
    try:
        classified_segments = classify_audio(file_bytes, source_ext="mp3", speech_segments=speech_segments)
        if classified_segments:
            result["classified_segments"] = classified_segments
            # Recalculate speech/non_speech from classifier for consistency
            from .audio_classifier import filter_speech_segments
            cls_speech, cls_non_speech = filter_speech_segments(classified_segments)
            if cls_speech and cls_non_speech:
                result["segments"] = {
                    "speech": cls_speech,
                    "non_speech": cls_non_speech,
                }
    except Exception as e:
        logger.warning("Audio classification failed: %s", e)

    # Apply wav2vec2 CTC forced alignment for English word timestamps
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None, _apply_forced_alignment, result, file_bytes, language, "mp3",
    )

    # Refine music/speech labels using alignment coverage
    if result.get("classified_segments") and result.get("words"):
        refined = _refine_classified_segments(
            result["classified_segments"], result["words"], result.get("duration_ms", 0),
        )
        result["classified_segments"] = refined
        # Update segments dict to match refined labels
        from .audio_classifier import filter_speech_segments
        cls_speech, cls_non_speech = filter_speech_segments(refined)
        if cls_speech:
            result["segments"] = {
                "speech": cls_speech,
                "non_speech": cls_non_speech,
            }

    return result


def detect_speech_segments(file_bytes: bytes, noise_db: int = -45, min_silence_duration: float = 1.0) -> tuple[list[dict], list[dict]]:
    """Use ffmpeg silencedetect with voice-band filtering to find speech segments."""
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
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

        duration = _get_real_audio_duration_bytes(file_bytes)

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
