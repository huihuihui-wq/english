"""DashScope ASR service using qwen3-asr-flash with word-level timestamps."""
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

logger = logging.getLogger(__name__)

# DashScope base64 inline audio limit is roughly 10MB (~13MB after encoding)
MAX_INLINE_BYTES = 9 * 1024 * 1024


def _get_audio_duration_seconds(file_bytes: bytes) -> float:
    """Try to get audio duration from the file bytes."""
    # Try WAV header first
    try:
        if file_bytes[:4] == b"RIFF":
            with wave.open(io.BytesIO(file_bytes), "rb") as wf:
                frames = wf.getnframes()
                rate = wf.getframerate()
                if rate > 0:
                    return frames / float(rate)
    except Exception:
        pass

    # Fallback: estimate from file size assuming ~64 kbps mono (typical after ffmpeg extraction)
    # 64 kbps = 8 KB/s
    if len(file_bytes) > 0:
        return len(file_bytes) / 8000.0
    return 0.0


def _get_real_audio_duration_bytes(file_bytes: bytes) -> float:
    """Use ffprobe to get accurate audio duration from bytes."""
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(file_bytes)
        tmp = f.name
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
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


def detect_speech_segments(file_bytes: bytes, noise_db: int = -40, min_silence_duration: float = 0.5) -> tuple[list[dict], list[dict]]:
    """Use ffmpeg silencedetect to find speech and non-speech segments.

    Returns (speech_segments, non_speech_segments) with start_ms / end_ms.
    """
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(file_bytes)
        tmp = f.name

    try:
        cmd = [
            "ffmpeg", "-y", "-i", tmp,
            "-af", f"silencedetect=noise={noise_db}dB:d={min_silence_duration}",
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

        speech = []
        non_speech = []
        cursor = 0.0
        for i, start in enumerate(silence_starts):
            end = silence_ends[i] if i < len(silence_ends) else None
            if start > cursor:
                speech.append({"start_ms": int(cursor * 1000), "end_ms": int(start * 1000)})
            if end is not None:
                non_speech.append({"start_ms": int(start * 1000), "end_ms": int(end * 1000)})
                cursor = end
            else:
                non_speech.append({"start_ms": int(start * 1000), "end_ms": int(duration * 1000)})
                cursor = duration
                break

        if cursor < duration:
            speech.append({"start_ms": int(cursor * 1000), "end_ms": int(duration * 1000)})

        return speech, non_speech
    except Exception as e:
        logger.warning("VAD detection failed: %s", e)
        return [], []
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _get_config():
    from services.config import get_setting
    return {
        "api_key": get_setting("DASHSCOPE_API_KEY", ""),
        "base_url": get_setting("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/api/v1"),
        "model": get_setting("ASR_MODEL", "qwen3-asr-flash"),
    }


def extract_audio_to_mp3(file_bytes: bytes, source_ext: str) -> bytes:
    """Convert any audio/video to a compact mono MP3 using ffmpeg."""
    src_path = None
    out_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=f".{source_ext}", delete=False) as src:
            src.write(file_bytes)
            src_path = src.name
        out_path = src_path.rsplit(".", 1)[0] + ".mp3"

        cmd = [
            "ffmpeg", "-y", "-i", src_path,
            "-vn",
            "-acodec", "libmp3lame",
            "-ac", "1",
            "-ar", "16000",
            "-b:a", "64k",
            out_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            logger.error("ffmpeg failed: %s", result.stderr[:500])
            raise RuntimeError(f"ffmpeg audio extraction failed: {result.stderr[:200]}")

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
    """Slice MP3 audio into overlapping segments.

    Returns [(segment_bytes, start_offset_seconds), ...].
    Each segment covers approximately [start, start + segment_seconds + overlap_seconds].
    """
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
                "ffmpeg", "-y", "-i", src_path,
                "-vn", "-acodec", "libmp3lame",
                "-ac", "1", "-ar", "16000", "-b:a", "64k",
                "-ss", str(start), "-t", str(duration),
                out_path,
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if result.returncode != 0:
                logger.error("ffmpeg slice failed: %s", result.stderr[:500])
                raise RuntimeError(f"ffmpeg slicing failed: {result.stderr[:200]}")

            with open(out_path, "rb") as f:
                seg_bytes = f.read()

            try:
                os.unlink(out_path)
            except OSError:
                pass

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


async def _call_asr_api(file_bytes: bytes, language: str, cfg: dict) -> dict:
    """Call DashScope ASR and return parsed {text, words, duration_ms}."""
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

    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(url, headers=headers, json=payload)

    if resp.status_code != 200:
        logger.error("ASR failed: %s %s", resp.status_code, resp.text[:500])
        raise RuntimeError(f"ASR request failed: {resp.status_code} {resp.text[:300]}")

    parsed = _parse_response(resp.json())
    logger.info("ASR segment response: text_len=%d, words=%d", len(parsed.get("text", "")), len(parsed.get("words", [])))
    return parsed


def _merge_segment_words(all_words: list[dict], min_gap_ms: int = 300) -> list[dict]:
    """Merge and deduplicate words from overlapping segments."""
    if not all_words:
        return []

    sorted_words = sorted(all_words, key=lambda w: (w["begin_time"], w["end_time"]))
    merged = []

    for w in sorted_words:
        if merged and abs(w["begin_time"] - merged[-1]["begin_time"]) < min_gap_ms and w["text"] == merged[-1]["text"]:
            continue
        if merged and w["begin_time"] < merged[-1]["begin_time"]:
            continue
        merged.append({
            "text": w["text"],
            "begin_time": int(w["begin_time"]),
            "end_time": int(w["end_time"]),
        })

    return merged


def _sentence_terminator_pattern(language: str) -> str:
    if language in ("zh", "ja"):
        return r"[。！？\.\!\?]+"
    return r"[\.\!\?]+"


def _merge_segment_texts(texts: list[str], language: str = "en") -> str:
    """Concatenate segment texts while removing duplicated sentences in overlaps."""
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

        # Find longest suffix of result that matches prefix of next_text
        overlap_count = 0
        max_check = min(len(result_sentences), len(next_sentences), 5)
        for i in range(1, max_check + 1):
            if result_sentences[-i:] == next_sentences[:i]:
                overlap_count = i

        if overlap_count:
            append_idx = next_text.find(next_sentences[overlap_count])
            # Include a whitespace separator if present (e.g., space after English terminator)
            if append_idx > 0 and next_text[append_idx - 1].isspace():
                append_idx -= 1
            result = result + next_text[append_idx:]
        else:
            result = result + " " + next_text

    return result.strip()


async def _transcribe_segment(seg_bytes: bytes, offset_seconds: float, language: str, cfg: dict) -> dict:
    """Transcribe a single segment and offset its word timestamps."""
    parsed = await _call_asr_api(seg_bytes, language, cfg)
    offset_ms = int(offset_seconds * 1000)
    words = []
    for w in parsed.get("words", []):
        words.append({
            "text": w["text"],
            "begin_time": int(w["begin_time"]) + offset_ms,
            "end_time": int(w["end_time"]) + offset_ms,
        })
    return {
        "words": words,
        "text": parsed.get("text", ""),
    }


async def transcribe_audio(file_bytes: bytes, filename: str, content_type: str, language: str = "en") -> dict:
    """Call DashScope qwen3-asr-flash and return {text, words, duration_ms}.

    language: audio language code, e.g. en/zh/ja/ko/es/fr/de/pt/ru/it
    Long audio is automatically sliced into overlapping segments, transcribed
    concurrently, and merged with offset timestamps.
    """
    cfg = _get_config()
    if not cfg["api_key"]:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured")

    source_ext = (filename.rsplit(".", 1)[-1] if "." in filename else "mp4").lower()
    estimated_duration = _get_audio_duration_seconds(file_bytes)
    max_audio_seconds = int(os.getenv("MAX_ASR_AUDIO_SECONDS", "120"))
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

    if real_duration > max_audio_seconds:
        overlap_seconds = 20.0
        segment_seconds = max(30.0, float(max_audio_seconds) - overlap_seconds)
        segments = _slice_audio_to_segments(file_bytes, segment_seconds, overlap_seconds)

        if len(segments) > 50:
            raise RuntimeError(
                f"Audio is too long ({real_duration:.0f}s). "
                f"Automatic slicing would create {len(segments)} segments, which exceeds the safety limit of 50. "
                f"Please use a shorter clip or increase MAX_ASR_AUDIO_SECONDS if your model supports it."
            )

        tasks = [_transcribe_segment(seg_bytes, offset, language, cfg) for seg_bytes, offset in segments]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        all_words = []
        segment_texts = []
        for i, res in enumerate(results):
            if isinstance(res, Exception):
                logger.error("Segment %d transcription failed: %s", i, res)
                raise RuntimeError(f"Segment {i} transcription failed: {res}")
            if res.get("words"):
                all_words.extend(res["words"])
            if res.get("text"):
                segment_texts.append(res["text"])
            logger.info("Segment %d: text_len=%d, words=%d", i, len(res.get("text", "")), len(res.get("words", [])))

        speech_segments, non_speech_segments = detect_speech_segments(file_bytes)

        if all_words:
            merged_words = _merge_segment_words(all_words)
            text = "".join(w["text"] for w in merged_words)
            duration_ms = max((w["end_time"] for w in merged_words), default=int(real_duration * 1000))
            logger.info("Long audio ASR ok (words): %d segments -> %d words, %d ms", len(segments), len(merged_words), duration_ms)
            return {
                "text": text.strip(),
                "words": merged_words,
                "duration_ms": duration_ms,
                "segments": {"speech": speech_segments, "non_speech": non_speech_segments},
            }

        if segment_texts:
            full_text = _merge_segment_texts(segment_texts, language)
            duration_ms = int(real_duration * 1000)
            logger.info("Long audio ASR ok (text only): %d segments -> text_len=%d", len(segments), len(full_text))
            return {
                "text": full_text,
                "words": [],
                "duration_ms": duration_ms,
                "segments": {"speech": speech_segments, "non_speech": non_speech_segments},
            }

        raise RuntimeError("ASR returned no text/words for the long audio")

    asr_result = await _call_asr_api(file_bytes, language, cfg)
    logger.info("ASR ok: %d words, %d ms", len(asr_result.get("words", [])), asr_result.get("duration_ms", 0))
    return asr_result


def _parse_response(resp: dict) -> dict:
    """Parse DashScope qwen3-asr-flash response and extract text + words."""
    try:
        choices = resp["output"]["choices"]
        if not choices:
            raise RuntimeError("ASR returned empty choices")
        msg = choices[0]["message"]

        text = ""
        words = []
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
                if "words" in item and isinstance(item["words"], list):
                    for w in item["words"]:
                        if not isinstance(w, dict):
                            continue
                        words.append({
                            "text": w.get("text", "").strip(),
                            "begin_time": int(w.get("begin_time", 0)),
                            "end_time": int(w.get("end_time", 0)),
                        })
                if "audio_duration_ms" in item:
                    audio_duration_ms = int(item["audio_duration_ms"])

        if not text and not words:
            raise RuntimeError(f"No text/words found in ASR response: {resp}")

        if not text and words:
            text = "".join(w["text"] for w in words)

        if words and not audio_duration_ms:
            audio_duration_ms = max((w["end_time"] for w in words), default=0)

        return {
            "text": text.strip(),
            "words": words,
            "duration_ms": audio_duration_ms,
        }
    except (KeyError, IndexError, TypeError) as e:
        logger.exception("Failed to parse ASR response: %s", e)
        raise RuntimeError(f"Failed to parse ASR response: {e}; raw={str(resp)[:300]}")
