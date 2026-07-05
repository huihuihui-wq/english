"""FastAPI main entry - Shadow Reader"""
import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from services import config as app_config
from services import dictionary as dict_service
from services import vocabulary as vocab_service
from services.asr import transcribe_audio
from services.subtitle import (
    _fallback_proportional,
    build_subtitles_from_speech_segments,
    insert_placeholders_for_word_gaps,
    split_sentences_with_timestamps,
)
from services.translate import translate_sentences
from services.voice_service import synthesize as tts_synthesize
from services.word_tts import synthesize_word
from services.word_tokenize import is_english_word, lemma, normalize_for_lookup
from services import ai_service

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("shadow-reader")

app = FastAPI(title="Shadow Reader", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(request: Request, exc: RequestValidationError):
    """把 Pydantic 校验错误转为友好的中文提示，不暴露字段细节。"""
    logger.warning("Validation error on %s %s: %s", request.method, request.url.path, exc.errors())
    messages = []
    for err in exc.errors():
        loc = err.get("loc") or []
        field = ".".join(str(x) for x in loc if isinstance(x, str))
        msg = err.get("msg", "参数错误")
        messages.append(f"{field or '请求参数'}: {msg}" if field else msg)
    return JSONResponse(
        status_code=422,
        content={
            "detail": "请求参数有误",
            "errors": messages[:5],
        },
    )


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    """服务端日志记录完整 traceback；客户端只返回通用错误信息。"""
    import traceback
    tb = traceback.format_exc()
    logger.error("Unhandled exception on %s %s:\n%s", request.method, request.url.path, tb)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "服务器内部错误，请稍后重试",
            "error_code": "internal_error",
        },
    )


MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "200"))

# Temporary files for online video processing
TEMP_DIR = Path(tempfile.mkdtemp(prefix="shadow_"))


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class SubtitleItem(BaseModel):
    start: float
    end: float
    en: str
    zh: str = ""
    source_lang: str = "en"
    is_placeholder: bool = False


class TranscribeResponse(BaseModel):
    duration: float
    subtitles: list[SubtitleItem]
    raw_text: str
    aligned: bool = False
    alignment_source: str = ""  # e.g. "qwen3-forced-aligner" or ""
    alignment_reason: str = ""




class ConfigUpdateRequest(BaseModel):
    DASHSCOPE_API_KEY: Optional[str] = None
    DICT_LANG: Optional[str] = None
    TRANSLATE_MODEL: Optional[str] = None
    WORD_LLM_MODEL: Optional[str] = None
    WHISPER_MODEL: Optional[str] = None


class TranslateSubtitlesRequest(BaseModel):
    sentences: list[str]
    target_lang: Optional[str] = "Chinese"
    source_lang: Optional[str] = "English"


class TranslateSubtitlesStreamRequest(BaseModel):
    sentences: list[str]
    target_lang: Optional[str] = "Chinese"
    source_lang: Optional[str] = "English"
    batch_size: int = 25


class SubtitleGenerateRequest(BaseModel):
    video_url: str
    language: str = "en"
    translate: bool = False


class HistoryCreateRequest(BaseModel):
    type: str
    title: str
    source: str
    size_bytes: int = 0
    duration: float = 0
    subtitles: list[dict] = []
    raw_text: str = ""
    progress_seconds: float = 0
    source_lang: str = "en"


class HistoryProgressRequest(BaseModel):
    progress_seconds: float


class HistoryTranslationsRequest(BaseModel):
    field: str
    translations: list[str]
    target_lang: Optional[str] = ""


class QuotaUpdateRequest(BaseModel):
    total_quota: Optional[int] = None
    used_tokens: Optional[int] = None


class TTSRequest(BaseModel):
    text: str
    voice: str = "Cherry"
    language_type: str = "English"


class WordLookupRequest(BaseModel):
    word: str
    force_refresh: bool = False


class VocabularyAddRequest(BaseModel):
    word: str
    lemma: Optional[str] = None
    phonetic: Optional[str] = ""
    pos: Optional[str] = ""
    meaning_en: Optional[str] = ""
    meaning_native: Optional[str] = ""
    native_lang: str = "en"
    example: Optional[dict] = None
    source_history_id: Optional[str] = None
    roots: Optional[dict] = None
    etymology_en: Optional[str] = ""
    etymology_native: Optional[str] = ""
    family: Optional[list] = None
    related: Optional[list] = None


class VocabularyReviewRequest(BaseModel):
    word: str
    correct: bool


class VocabularyReviewModeRequest(BaseModel):
    mode: str = "choice"  # choice | spelling | listening
    count: int = 10
class AIChatRequest(BaseModel):
    message: str
    context: Optional[str] = ""
    history: Optional[list] = None
    voice: Optional[str] = "Cherry"


class AIExamChatRequest(BaseModel):
    message: str
    question: str
    question_index: int = 0
    total_questions: int = 1
    history: Optional[list] = None


class AIExamGenerateRequest(BaseModel):
    subtitles: Optional[list] = None
    count: int = 3
    raw_text: Optional[str] = ""


class AIExplainRequest(BaseModel):
    text: str
    context: Optional[str] = ""
    # v3: word root / etymology / family / related
    roots: Optional[dict] = None
    etymology_en: Optional[str] = ""
    etymology_native: Optional[str] = ""
    family: Optional[list] = None
    related: Optional[list] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def get_audio_duration(file_bytes: bytes, content_type: str) -> float:
    try:
        import wave
        import io

        if content_type in ("audio/wav", "audio/x-wav", "audio/wave") or file_bytes[:4] == b"RIFF":
            with wave.open(io.BytesIO(file_bytes), "rb") as wf:
                frames = wf.getnframes()
                rate = wf.getframerate()
                if rate > 0:
                    return frames / float(rate)
    except Exception as e:
        logger.warning("wave parse failed, fallback estimate: %s", e)

    size_bytes = len(file_bytes)
    est_bitrate_kbps = 128
    return size_bytes * 8.0 / (est_bitrate_kbps * 1000.0)


def _get_real_duration(filepath: str) -> float:
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
                filepath,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            return float(result.stdout.strip())
    except Exception:
        pass
    return 0.0


def _estimate_tokens(texts: list[str]) -> int:
    total = 0
    for t in texts:
        s = t or ""
        cjk = len(re.findall(r"[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]", s))
        other = len(re.sub(r"[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]", "", s))
        total += cjk + max(1, other // 4)
    return total


# ---------------------------------------------------------------------------
# Health & Config
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/config")
async def get_config():
    has_key = bool(app_config.get_dashscope_api_key())
    masked = app_config.mask_key(
        app_config.get_all_settings().get("DASHSCOPE_API_KEY", "")
    )
    return {
        "has_api_key": has_key,
        "DASHSCOPE_API_KEY": masked,
        "TRANSLATE_MODEL": app_config.get_setting("TRANSLATE_MODEL", "qwen-turbo"),
        "WORD_LLM_MODEL": app_config.get_setting("WORD_LLM_MODEL", "qwen-flash"),
        "WHISPER_MODEL": app_config.get_setting("WHISPER_MODEL", "base"),
    }


@app.post("/api/config")
async def update_config(req: ConfigUpdateRequest):
    action = "none"
    if req.DASHSCOPE_API_KEY is not None:
        api_key = req.DASHSCOPE_API_KEY.strip()
        if api_key == "":
            app_config.disable_setting("DASHSCOPE_API_KEY", persist=True)
            action = "disabled"
        else:
            app_config.set_setting("DASHSCOPE_API_KEY", api_key, persist=True)
            action = "saved"
    if req.DICT_LANG is not None:
        normalized = dict_service.normalize_target_lang(req.DICT_LANG)
        app_config.set_setting("DICT_LANG", normalized, persist=True)
        if action == "none":
            action = "saved"
    if req.TRANSLATE_MODEL is not None:
        model = req.TRANSLATE_MODEL.strip()
        if model:
            app_config.set_setting("TRANSLATE_MODEL", model, persist=True)
            action = "saved" if action == "none" else action + "+translate_model"
    if req.WORD_LLM_MODEL is not None:
        model = req.WORD_LLM_MODEL.strip()
        if model:
            app_config.set_setting("WORD_LLM_MODEL", model, persist=True)
            action = "saved" if action == "none" else action + "+word_llm_model"
    if req.WHISPER_MODEL is not None:
        model = req.WHISPER_MODEL.strip()
        if model:
            app_config.set_setting("WHISPER_MODEL", model, persist=True)
            action = "saved" if action == "none" else action + "+whisper_model"
    if action == "none":
        raise HTTPException(400, "At least one of DASHSCOPE_API_KEY, DICT_LANG, TRANSLATE_MODEL, WORD_LLM_MODEL, WHISPER_MODEL is required")
    has_key = bool(app_config.get_dashscope_api_key())
    masked = app_config.mask_key(
        app_config.get_all_settings().get("DASHSCOPE_API_KEY", "")
    )
    return {
        "ok": True,
        "action": action,
        "has_api_key": has_key,
        "DASHSCOPE_API_KEY": masked,
        "TRANSLATE_MODEL": app_config.get_setting("TRANSLATE_MODEL", "qwen-turbo"),
        "WORD_LLM_MODEL": app_config.get_setting("WORD_LLM_MODEL", "qwen-flash"),
        "WHISPER_MODEL": app_config.get_setting("WHISPER_MODEL", "base"),
    }


# ---------------------------------------------------------------------------
# Transcribe (local audio/video)
# ---------------------------------------------------------------------------
@app.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe(
    file: UploadFile = File(...),
    duration: Optional[float] = Form(None),
    language: str = Form("en"),
    translate: bool = Form(False),
):
    language = (language or "en").strip().lower()
    content_type = file.content_type or "application/octet-stream"
    filename = file.filename or "audio"
    file_bytes = await file.read()

    if not file_bytes:
        raise HTTPException(400, "File is empty")

    size_mb = len(file_bytes) / 1024 / 1024
    if size_mb > MAX_UPLOAD_MB:
        raise HTTPException(413, f"File exceeds {MAX_UPLOAD_MB}MB limit ({size_mb:.1f}MB)")

    logger.info("Received file: %s, type=%s, size=%.2fMB, lang=%s", filename, content_type, size_mb, language)

    tmp_name = f"{int(time.time())}_{filename}"
    tmp_path = TEMP_DIR / tmp_name
    tmp_path.write_bytes(file_bytes)

    try:
        try:
            asr_result = await transcribe_audio(file_bytes, filename, content_type, language=language)
        except RuntimeError as e:
            raise HTTPException(502, f"ASR service error: {e}")
        except Exception as e:
            logger.exception("Local ASR failed")
            raise HTTPException(502, f"Local ASR failed: {e}")

        text = asr_result.get("text", "").strip()
        words = asr_result.get("words", [])
        segments = asr_result.get("segments")
        classified_segments = asr_result.get("classified_segments")
        real_duration = asr_result.get("duration_ms", 0) / 1000.0
        # Fallback: if ASR didn’t report duration, measure the file directly
        if not real_duration:
            real_duration = _get_real_duration(str(tmp_path)) or get_audio_duration(file_bytes, content_type)

        if words:
            items = split_sentences_with_timestamps(
                words, text, language=language, segments=asr_result.get("whisper_segments")
            )
            if items and real_duration > 0:
                items = insert_placeholders_for_word_gaps(
                    items,
                    duration_ms=int(real_duration * 1000),
                    min_gap_ms=1000,
                    classified_segments=classified_segments,
                )
        elif segments and (segments.get("speech") or segments.get("non_speech")):
            items = build_subtitles_from_speech_segments(
                text,
                segments.get("speech", []),
                segments.get("non_speech", []),
                language=language,
                classified_segments=classified_segments,
            )
        else:
            real_duration = real_duration or _get_real_duration(str(tmp_path)) or get_audio_duration(file_bytes, content_type)
            items = _fallback_proportional(
                text,
                int(real_duration * 1000),
                language=language,
                non_speech_segments=classified_segments,
            )

        if not items:
            raise HTTPException(400, "No sentences could be extracted")

        if duration is None or duration <= 0:
            duration = real_duration or get_audio_duration(file_bytes, content_type)

        # Auto-translate only when explicitly requested and source is English.
        # Non-English sources keep translation blank so the user can manually translate later.
        if language == "en" and translate:
            translate_indices = [i for i, it in enumerate(items) if not it.get("is_placeholder")]
            en_list = [items[i]["en"] for i in translate_indices]
            trans_map = {i: {"en": items[i]["en"], "zh": ""} for i in translate_indices}
            if en_list:
                try:
                    llm_resp = await translate_sentences(en_list)
                    translations = llm_resp.get("translations", [])
                    for idx, tr in zip(translate_indices, translations):
                        trans_map[idx] = tr
                except Exception as e:
                    logger.exception("Translation failed: %s", e)

            for i, it in enumerate(items):
                it["zh"] = trans_map.get(i, {}).get("zh", "")
        else:
            for it in items:
                it["zh"] = ""

        subtitles = [
            SubtitleItem(
                start=round(it["start"] / 1000.0, 3),
                end=round(it["end"] / 1000.0, 3),
                en=it["en"],
                zh=it["zh"],
                source_lang=language,
                is_placeholder=bool(it.get("is_placeholder", False)),
            )
            for it in items
        ]

        return TranscribeResponse(
            duration=round(duration, 2),
            subtitles=subtitles,
            raw_text=text,
            aligned=bool(asr_result.get("aligned", False)),
            alignment_source=str(asr_result.get("alignment_source", "") or ""),
            alignment_reason=str(asr_result.get("alignment_reason", "") or ""),
        )
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass


@app.post("/api/transcribe/test")
async def transcribe_test():
    """Check that the local ASR backend is ready.

    This only verifies faster-whisper can be imported/loaded.
    Actual transcription uses the model on first request.
    """
    try:
        from services.asr import _get_whisper_model
        _get_whisper_model()
        return {"ok": True, "asr": "local_whisper_ready"}
    except Exception as e:
        logger.warning("Local ASR readiness test failed: %s", e)
        raise HTTPException(503, f"Local ASR not ready: {e}")


# ---------------------------------------------------------------------------
# Subtitle generation for online videos
# ---------------------------------------------------------------------------
async def _download_direct_video(video_url: str) -> bytes:
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        response = await client.get(video_url)
        response.raise_for_status()
        return response.content


def _download_youtube_audio(video_url: str, out_path: Path) -> None:
    """Download YouTube audio to out_path (mp3) using yt-dlp."""
    try:
        from yt_dlp import YoutubeDL
    except ImportError as e:
        raise RuntimeError("yt-dlp is not installed") from e

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out_path.with_suffix("")),
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "64",
        }],
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "overwrites": True,
        "socket_timeout": 60,
        "retries": 2,
    }
    cookies_path = os.getenv("YT_COOKIES", "").strip()
    if cookies_path and Path(cookies_path).is_file():
        opts["cookiefile"] = cookies_path

    with YoutubeDL(opts) as ydl:
        ydl.download([video_url])


async def _process_online_video(video_url: str, language: str = "en", translate: bool = False) -> dict:
    language = (language or "en").strip().lower()
    logger.info("Processing online video: %s, lang=%s", video_url, language)

    is_youtube = "youtube.com" in video_url or "youtu.be" in video_url
    tmp_name = f"online_{int(time.time())}"
    tmp_path = TEMP_DIR / (tmp_name + ".mp4")
    mp3_path = TEMP_DIR / (tmp_name + ".mp3")

    try:
        if is_youtube:
            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, _download_youtube_audio, video_url, mp3_path)
                if not mp3_path.exists():
                    raise RuntimeError("yt-dlp did not produce an audio file")
                file_bytes = mp3_path.read_bytes()
            except Exception as e:
                logger.error("Failed to download YouTube audio: %s", e)
                raise HTTPException(400, f"Unable to download YouTube audio: {e}")
        else:
            try:
                file_bytes = await _download_direct_video(video_url)
            except Exception as e:
                logger.error("Failed to download video: %s", e)
                raise HTTPException(400, f"Unable to download video: {e}")

            if not file_bytes:
                raise HTTPException(400, "Downloaded file is empty")

            size_mb = len(file_bytes) / 1024 / 1024
            if size_mb > MAX_UPLOAD_MB:
                raise HTTPException(413, f"Video exceeds {MAX_UPLOAD_MB}MB limit ({size_mb:.1f}MB)")

            tmp_path.write_bytes(file_bytes)

            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(tmp_path),
                "-vn",
                "-acodec",
                "libmp3lame",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-b:a",
                "64k",
                str(mp3_path),
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if result.returncode != 0:
                raise RuntimeError("ffmpeg audio extraction failed")

        mp3_bytes = mp3_path.read_bytes()
        asr_result = await transcribe_audio(mp3_bytes, "audio.mp3", "audio/mpeg", language=language)
        text = asr_result.get("text", "").strip()
        words = asr_result.get("words", [])
        segments = asr_result.get("segments")
        classified_segments = asr_result.get("classified_segments")
        real_duration = asr_result.get("duration_ms", 0) / 1000.0
        if not real_duration:
            real_duration = _get_real_duration(str(mp3_path))

        if words:
            items = split_sentences_with_timestamps(words, text, language=language)
            if items and real_duration > 0:
                items = insert_placeholders_for_word_gaps(
                    items,
                    duration_ms=int(real_duration * 1000),
                    min_gap_ms=1000,
                    classified_segments=classified_segments,
                )
        elif segments and (segments.get("speech") or segments.get("non_speech")):
            items = build_subtitles_from_speech_segments(
                text,
                segments.get("speech", []),
                segments.get("non_speech", []),
                language=language,
                classified_segments=classified_segments,
            )
        else:
            real_duration = real_duration or _get_real_duration(str(mp3_path))
            items = _fallback_proportional(
                text,
                int(real_duration * 1000),
                language=language,
                non_speech_segments=classified_segments,
            )

        if not items:
            raise HTTPException(400, "No sentences could be extracted")

        if language == "en" and translate:
            translate_indices = [i for i, it in enumerate(items) if not it.get("is_placeholder")]
            en_list = [items[i]["en"] for i in translate_indices]
            trans_map = {i: {"en": items[i]["en"], "zh": ""} for i in translate_indices}
            if en_list:
                try:
                    llm_resp = await translate_sentences(en_list)
                    translations = llm_resp.get("translations", [])
                    for idx, tr in zip(translate_indices, translations):
                        trans_map[idx] = tr
                except Exception as e:
                    logger.warning("Translation failed: %s", e)
            for i, it in enumerate(items):
                it["zh"] = trans_map.get(i, {}).get("zh", "")
        else:
            for it in items:
                it["zh"] = ""

        duration = real_duration if real_duration > 0 else items[-1]["end"] / 1000.0
        subtitles = [
            {
                "start": round(it["start"] / 1000.0, 3),
                "end": round(it["end"] / 1000.0, 3),
                "en": it["en"],
                "zh": it["zh"],
                "source_lang": language,
                "is_placeholder": bool(it.get("is_placeholder", False)),
            }
            for it in items
        ]

        return {
            "subtitles": subtitles,
            "duration": round(duration, 2),
            "raw_text": text,
            "source": "local_asr" if is_youtube else "ai_recognition",
            "source_lang": language,
            "aligned": bool(asr_result.get("aligned", False)),
            "alignment_source": str(asr_result.get("alignment_source", "") or ""),
            "alignment_reason": str(asr_result.get("alignment_reason", "") or ""),
        }
    finally:
        for p in (tmp_path, mp3_path):
            try:
                if p.exists():
                    p.unlink()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Subtitle generation for online videos
# ---------------------------------------------------------------------------
@app.post("/api/generate-subtitles")
async def generate_subtitles_api(req: SubtitleGenerateRequest):
    video_url = req.video_url
    is_youtube = "youtube.com" in video_url or "youtu.be" in video_url

    if is_youtube:
        logger.info("Fetching YouTube subtitles: %s", video_url)
        try:
            from services.youtube_subtitles import get_youtube_subtitles, YouTubeSubtitleError

            result = await get_youtube_subtitles(video_url)
            subtitles = result["subtitles"]
            if not subtitles:
                raise HTTPException(400, "This video has no subtitles. Try another video or upload an SRT file.")

            # YouTube returns only spoken-line cues. Inject placeholder items for
            # the silent gaps (music / applause / black frames) so they show up
            # as clickable empty entries in the subtitle list.
            yt_duration = result.get("duration")
            if not yt_duration or yt_duration <= 0:
                yt_duration = subtitles[-1]["end"] if subtitles else 0
            if subtitles and yt_duration > 0:
                subs_ms = [
                    {
                        "start": int(s.get("start", 0) * 1000),
                        "end": int(s.get("end", 0) * 1000),
                        "en": s.get("en", ""),
                    }
                    for s in subtitles
                ]
                with_ph_ms = insert_placeholders_for_word_gaps(
                    subs_ms,
                    duration_ms=int(yt_duration * 1000),
                    min_gap_ms=1000,
                )
                subtitles = [
                    {
                        "start": round(it["start"] / 1000.0, 3),
                        "end": round(it["end"] / 1000.0, 3),
                        "en": it.get("en", ""),
                        "is_placeholder": bool(it.get("is_placeholder", False)),
                    }
                    for it in with_ph_ms
                ]

            for s in subtitles:
                s["zh"] = ""
                if "source_lang" not in s:
                    s["source_lang"] = "en"

            duration = subtitles[-1]["end"] if subtitles else 0
            source = result.get("source") or "youtube_official"
            return {
                "subtitles": subtitles,
                "duration": round(duration, 2),
                "raw_text": result.get("raw_text", ""),
                "source": source,
                "is_auto_generated": result.get("is_auto_generated", False),
                "source_lang": "en",
            }
        except YouTubeSubtitleError as e:
            logger.warning("YouTube subtitle fetch failed, falling back to local ASR: %s", e)
            try:
                ai_result = await _process_online_video(video_url, req.language, req.translate)
                ai_result["source"] = "local_asr_fallback"
                ai_result["fallback_reason"] = e.user_message
                ai_result["youtube_error_code"] = e.error_code
                return ai_result
            except Exception as ai_err:
                logger.exception("Local ASR subtitle fallback also failed")
                raise HTTPException(
                    500,
                    {
                        "detail": e.user_message,
                        "error_code": e.error_code,
                        "fallback_failed": True,
                        "asr_error": str(ai_err),
                        "suggestions": [
                            "Upload an SRT file manually",
                            "Try a different video",
                            "Set YT_COOKIES in backend/.env if YouTube blocks your IP",
                        ],
                    },
                )
        except (ValueError, RuntimeError) as e:
            logger.warning("YouTube subtitle fetch failed, falling back to local ASR: %s", e)
            try:
                ai_result = await _process_online_video(video_url, req.language, req.translate)
                ai_result["source"] = "local_asr_fallback"
                ai_result["fallback_reason"] = str(e)
                return ai_result
            except Exception as ai_err:
                logger.exception("Local ASR subtitle fallback also failed")
                raise HTTPException(
                    500,
                    f"YouTube subtitles failed and local ASR fallback also failed:\n"
                    f"  · Subtitle path: {e}\n"
                    f"  · ASR path: {ai_err}\n"
                    f"Suggestions:\n"
                    f"  1. Upload an SRT file manually\n"
                    f"  2. Try a different video\n"
                    f"  3. Set YT_COOKIES in backend/.env if YouTube blocks your IP",
                )

    return await _process_online_video(video_url, req.language, req.translate)


# ---------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------
@app.get("/api/translate/info")
async def translate_info():
    from services.translate import SUPPORTED_TARGET_LANGS

    return {"target_langs": SUPPORTED_TARGET_LANGS, "default": "Chinese"}


@app.post("/api/translate-subtitles")
async def translate_subtitles_api(req: TranslateSubtitlesRequest):
    sentences = [s for s in (req.sentences or []) if isinstance(s, str) and s.strip()]
    if not sentences:
        return {
            "translations": [],
            "target_lang": req.target_lang,
            "field": "zh",
            "estimated_tokens": 0,
        }

    from services.translate import _TARGET_LANG_MAP

    target_lang = req.target_lang or "Chinese"
    if target_lang not in _TARGET_LANG_MAP:
        raise HTTPException(
            400,
            f"Unsupported target language: {target_lang}. Available: {list(_TARGET_LANG_MAP.keys())}",
        )
    field = _TARGET_LANG_MAP[target_lang]["field"]

    try:
        llm_resp = await translate_sentences(
            sentences, target_lang=target_lang, source_lang=req.source_lang or "en"
        )
    except Exception as e:
        logger.exception("Translation failed")
        raise HTTPException(500, f"Translation failed: {e}")

    translations = llm_resp.get("translations", [])
    outputs = [t.get(field, "") if isinstance(t, dict) else "" for t in translations]
    estimated_tokens = _estimate_tokens(sentences) + _estimate_tokens(outputs)

    current_used = 0
    try:
        current_used = int(app_config.get_setting("DASHSCOPE_USED_TOKENS", "0") or 0)
        app_config.set_setting(
            "DASHSCOPE_USED_TOKENS",
            str(current_used + estimated_tokens),
            persist=True,
        )
    except Exception:
        pass

    total_quota = int(app_config.get_setting("DASHSCOPE_FREE_QUOTA", "1000000") or 1000000)

    return {
        "translations": translations,
        "target_lang": target_lang,
        "field": field,
        "estimated_tokens": estimated_tokens,
        "model": llm_resp.get("model", ""),
        "cache_hits": llm_resp.get("cache_hits", 0),
        "llm_calls": llm_resp.get("llm_calls", 0),
        "elapsed_s": llm_resp.get("elapsed_s", 0),
        "quota": {
            "total_quota": total_quota,
            "used_tokens": current_used + estimated_tokens,
            "remaining": max(0, total_quota - current_used - estimated_tokens),
        },
    }


@app.post("/api/translate-subtitles/stream")
async def translate_subtitles_stream_api(req: TranslateSubtitlesStreamRequest, request: Request):
    """Stream subtitle translation in batches via SSE.

    Each completed batch is emitted immediately so the UI can show progressive
    results. Cancelled/disconnected clients stop further processing but keep
    everything already translated.
    """
    sentences = [s for s in (req.sentences or []) if isinstance(s, str) and s.strip()]
    if not sentences:
        raise HTTPException(400, "No sentences to translate")

    from services.translate import _TARGET_LANG_MAP

    target_lang = req.target_lang or "Chinese"
    if target_lang not in _TARGET_LANG_MAP:
        raise HTTPException(
            400,
            f"Unsupported target language: {target_lang}. Available: {list(_TARGET_LANG_MAP.keys())}",
        )

    batch_size = max(5, min(50, req.batch_size or 25))
    field = _TARGET_LANG_MAP[target_lang]["field"]
    total = len(sentences)

    async def event_stream():
        completed = 0
        cache_hits_total = 0
        llm_calls_total = 0
        elapsed_total = 0.0
        all_outputs: list[str] = []
        try:
            for start in range(0, total, batch_size):
                if await request.is_disconnected():
                    yield f"data: {json.dumps({'type': 'cancelled', 'completed': completed, 'total': total})}\n\n"
                    return

                end = min(start + batch_size, total)
                batch = sentences[start:end]
                try:
                    llm_resp = await translate_sentences(
                        batch,
                        target_lang=target_lang,
                        source_lang=req.source_lang or "en",
                    )
                except Exception as e:
                    logger.exception("Translation batch %d-%d failed", start, end)
                    yield f"data: {json.dumps({'type': 'error', 'start_index': start, 'end_index': end, 'message': str(e), 'completed': completed, 'total': total})}\n\n"
                    continue

                completed += len(batch)
                cache_hits_total += llm_resp.get("cache_hits", 0)
                llm_calls_total += llm_resp.get("llm_calls", 0)
                elapsed_total += llm_resp.get("elapsed_s", 0.0)

                batch_translations = llm_resp.get("translations", [])
                all_outputs.extend([
                    (t.get(field, "") if isinstance(t, dict) else "")
                    for t in batch_translations
                ])

                yield f"data: {json.dumps({'type': 'batch', 'start_index': start, 'end_index': end, 'translations': batch_translations, 'field': field})}\n\n"
                yield f"data: {json.dumps({'type': 'progress', 'completed': completed, 'total': total})}\n\n"

            estimated_tokens = _estimate_tokens(sentences) + _estimate_tokens(all_outputs)
            current_used = 0
            try:
                current_used = int(app_config.get_setting("DASHSCOPE_USED_TOKENS", "0") or 0)
                app_config.set_setting(
                    "DASHSCOPE_USED_TOKENS",
                    str(current_used + estimated_tokens),
                    persist=True,
                )
            except Exception:
                pass

            total_quota = int(app_config.get_setting("DASHSCOPE_FREE_QUOTA", "1000000") or 1000000)
            yield f"data: {json.dumps({'type': 'done', 'completed': completed, 'total': total, 'cache_hits': cache_hits_total, 'llm_calls': llm_calls_total, 'elapsed_s': round(elapsed_total, 3), 'estimated_tokens': estimated_tokens, 'quota': {'total_quota': total_quota, 'used_tokens': current_used + estimated_tokens, 'remaining': max(0, total_quota - current_used - estimated_tokens)}})}\n\n"
        except asyncio.CancelledError:
            logger.info("Translation stream cancelled")
            yield f"data: {json.dumps({'type': 'cancelled', 'completed': completed, 'total': total})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------
HISTORY_DIR = BASE_DIR / "data" / "history"
HISTORY_DIR.mkdir(parents=True, exist_ok=True)


def _now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _history_id(payload: dict) -> str:
    if payload.get("type") == "youtube":
        raw = f"youtube:{payload.get('source', '')}"
    elif payload.get("type") == "online_url":
        raw = f"url:{payload.get('source', '')}"
    else:
        raw = f"local:{payload.get('source', '')}:{payload.get('size_bytes', 0)}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _read_history_file(history_id: str) -> Optional[dict]:
    fp = HISTORY_DIR / f"{history_id}.json"
    if not fp.exists():
        return None
    try:
        return json.loads(fp.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Failed to read history file: %s", fp)
        return None


def _write_history_file(record: dict) -> None:
    fp = HISTORY_DIR / f"{record['id']}.json"
    fp.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")


def _list_history_files() -> list[dict]:
    items = []
    for fp in HISTORY_DIR.glob("*.json"):
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
            lite = {k: v for k, v in data.items() if k not in ("subtitles", "raw_text")}
            lite["has_subtitles"] = bool(data.get("subtitles"))
            lite["subtitle_count"] = len(data.get("subtitles") or [])
            items.append(lite)
        except Exception:
            logger.warning("Skipping corrupted history file: %s", fp)
    items.sort(
        key=lambda x: x.get("last_opened") or x.get("created_at") or "",
        reverse=True,
    )
    return items


@app.get("/api/history")
async def list_history():
    return {"items": _list_history_files()}


@app.get("/api/history/{history_id}")
async def get_history(history_id: str):
    rec = _read_history_file(history_id)
    if not rec:
        raise HTTPException(404, "History record not found")
    return rec


@app.post("/api/history")
async def create_or_update_history(req: HistoryCreateRequest):
    if req.type not in ("local", "youtube", "online_url"):
        raise HTTPException(400, "type must be local / youtube / online_url")

    hid = _history_id(req.model_dump())
    existing = _read_history_file(hid)
    now = _now_iso()
    if existing:
        rec = existing
        rec["title"] = req.title or rec.get("title", "")
        rec["source"] = req.source or rec.get("source", "")
        rec["size_bytes"] = req.size_bytes or rec.get("size_bytes", 0)
        rec["duration"] = req.duration or rec.get("duration", 0)
        new_subtitles = req.subtitles or []
        old_subtitles = rec.get("subtitles") or []
        source_lang = req.source_lang or rec.get("source_lang", "en")
        for s in new_subtitles:
            if "source_lang" not in s:
                s["source_lang"] = source_lang
        if new_subtitles and old_subtitles:
            from services.translate import _TARGET_LANG_MAP

            old_trans_map = {s.get("en", ""): s for s in old_subtitles}
            translation_fields = {x["field"] for x in _TARGET_LANG_MAP.values()}
            for s in new_subtitles:
                old = old_trans_map.get(s.get("en", ""))
                if old:
                    for f in translation_fields:
                        if old.get(f) and not s.get(f):
                            s[f] = old[f]
            rec["subtitles"] = new_subtitles
        else:
            rec["subtitles"] = new_subtitles or old_subtitles
        rec["raw_text"] = req.raw_text or rec.get("raw_text", "")
        rec["source_lang"] = req.source_lang or rec.get("source_lang", "en")
        rec["type"] = req.type
        rec["last_opened"] = now
        rec["open_count"] = (rec.get("open_count", 0) or 0) + 1
        if req.progress_seconds:
            rec["progress_seconds"] = req.progress_seconds
    else:
        rec = {
            "id": hid,
            "type": req.type,
            "title": req.title,
            "source": req.source,
            "size_bytes": req.size_bytes,
            "duration": req.duration,
            "subtitles": req.subtitles,
            "raw_text": req.raw_text,
            "progress_seconds": req.progress_seconds,
            "source_lang": req.source_lang or "en",
            "created_at": now,
            "last_opened": now,
            "open_count": 1,
        }
    _write_history_file(rec)
    return {"id": hid, "open_count": rec["open_count"]}


@app.patch("/api/history/{history_id}/progress")
async def update_history_progress(history_id: str, req: HistoryProgressRequest):
    rec = _read_history_file(history_id)
    if not rec:
        raise HTTPException(404, "History record not found")
    rec["progress_seconds"] = max(0, float(req.progress_seconds))
    rec["last_opened"] = _now_iso()
    _write_history_file(rec)
    return {"id": history_id, "progress_seconds": rec["progress_seconds"]}


@app.delete("/api/history/{history_id}")
async def delete_history(history_id: str):
    fp = HISTORY_DIR / f"{history_id}.json"
    if not fp.exists():
        raise HTTPException(404, "History record not found")
    fp.unlink()
    return {"id": history_id, "deleted": True}


@app.patch("/api/history/{history_id}/translations")
async def patch_history_translations(history_id: str, req: HistoryTranslationsRequest):
    rec = _read_history_file(history_id)
    if not rec:
        raise HTTPException(404, "History record not found")

    subtitles = rec.get("subtitles") or []
    if not subtitles:
        return {"id": history_id, "updated": 0}

    available_translations = rec.get("available_translations") or {}
    available_translations[req.field] = req.target_lang or req.field

    updated = 0
    for i, text in enumerate(req.translations or []):
        if i < len(subtitles) and isinstance(text, str):
            subtitles[i][req.field] = text
            updated += 1

    rec["subtitles"] = subtitles
    rec["available_translations"] = available_translations
    rec["last_opened"] = _now_iso()
    _write_history_file(rec)
    return {"id": history_id, "updated": updated, "field": req.field}


# ---------------------------------------------------------------------------
# Quota
# ---------------------------------------------------------------------------
@app.get("/api/quota")
async def get_quota():
    total = int(app_config.get_setting("DASHSCOPE_FREE_QUOTA", "1000000") or 1000000)
    used = int(app_config.get_setting("DASHSCOPE_USED_TOKENS", "0") or 0)
    return {
        "total_quota": total,
        "used_tokens": used,
        "remaining": max(0, total - used),
        "note": "Estimated local usage. DashScope does not provide a public quota API; verify in the console.",
        "console_url": "https://bailian.console.aliyun.com/?tab=model#/model-usage/free-quota",
    }


@app.post("/api/quota")
async def update_quota(req: QuotaUpdateRequest):
    if req.total_quota is not None:
        app_config.set_setting("DASHSCOPE_FREE_QUOTA", str(max(0, req.total_quota)), persist=True)
    if req.used_tokens is not None:
        app_config.set_setting("DASHSCOPE_USED_TOKENS", str(max(0, req.used_tokens)), persist=True)
    return await get_quota()


@app.post("/api/quota/consume")
async def consume_quota(tokens: int = 0):
    if tokens <= 0:
        return await get_quota()
    current = int(app_config.get_setting("DASHSCOPE_USED_TOKENS", "0") or 0)
    app_config.set_setting("DASHSCOPE_USED_TOKENS", str(current + tokens), persist=True)
    return await get_quota()


# ---------------------------------------------------------------------------
# TTS
# ---------------------------------------------------------------------------
@app.post("/api/tts")
async def tts_api(req: TTSRequest):
    if not app_config.is_dashscope_configured():
        raise HTTPException(401, "DashScope API key is not configured")
    try:
        audio_bytes, meta = await tts_synthesize(
            req.text,
            voice=req.voice,
            language_type=req.language_type,
        )
        # Build response with word-level timestamps for subtitle following
        response_data = {
            "audio": base64.b64encode(audio_bytes).decode("utf-8"),
            "meta": {
                "size": meta["size"],
                "cached": meta.get("cached", False),
                "voice": meta["voice"],
                "language_type": meta["language_type"],
                "words": meta.get("words", []),
            }
        }
        return JSONResponse(content=response_data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        logger.warning("TTS runtime error: %s", e)
        raise HTTPException(502, str(e))
    except Exception as e:
        logger.exception("TTS failed")
        raise HTTPException(500, f"TTS failed: {e}")


@app.get("/api/tts/voices")
async def tts_voices(language_type: str = "English"):
    from services.voice_service import list_voices, get_default_voice
    voices = list_voices(language_type)
    return {
        "voices": voices,
        "default": get_default_voice(language_type),
        "language_type": language_type,
    }


# ---------------------------------------------------------------------------
# Word lookup & vocabulary
# ---------------------------------------------------------------------------
@app.get("/api/word/lookup")
async def word_lookup(word: str, lang: Optional[str] = None, force_refresh: bool = False):
    if not word or not word.strip():
        raise HTTPException(400, "word is required")
    if not is_english_word(word):
        raise HTTPException(400, f"unsupported token: {word!r}")
    target = normalize_for_lookup(word)
    target_lang = dict_service.normalize_target_lang(lang) if lang else None
    try:
        if force_refresh:
            dict_service.invalidate(target)
        entry = await dict_service.lookup_word(target, target_lang=target_lang)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        logger.exception("[word/lookup] failed for %s", word)
        raise HTTPException(502, f"dictionary error: {e}")
    if "lemma" not in entry or not entry.get("lemma"):
        entry["lemma"] = lemma(target)
    return {**entry, "saved": vocab_service.has_word(target)}


@app.get("/api/word/languages")
async def word_languages():
    return {
        "languages": dict_service.SUPPORTED_DICT_LANGS,
        "default": app_config.get_setting("DICT_LANG", dict_service.DEFAULT_DICT_LANG),
    }


@app.get("/api/word/tts")
async def word_tts(word: str, voice: str = "Cherry", language_type: str = "English"):
    if not word or not word.strip():
        raise HTTPException(400, "word is required")
    if not is_english_word(word):
        raise HTTPException(400, f"unsupported token: {word!r}")
    try:
        audio_bytes, meta = await synthesize_word(word, voice=voice, language_type=language_type)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        if "not configured" in str(e).lower():
            raise HTTPException(401, "DashScope API key is not configured")
        raise HTTPException(502, str(e))
    except Exception as e:
        logger.exception("[word/tts] failed for %s", word)
        raise HTTPException(500, f"tts error: {e}")
    headers = {
        "X-Cache": "HIT" if meta.get("cached") else "MISS",
        "X-Voice": meta.get("voice", voice),
    }
    return Response(content=audio_bytes, media_type="audio/mpeg", headers=headers)


@app.get("/api/vocabulary")
async def vocabulary_list():
    return {"items": vocab_service.list_words(), "stats": vocab_service.stats()}


@app.get("/api/vocabulary/due")
async def vocabulary_due():
    return {"items": vocab_service.due_words(), "stats": vocab_service.stats()}


@app.post("/api/vocabulary/review")
async def vocabulary_review(req: VocabularyReviewRequest):
    word = (req.word or "").strip()
    if not word:
        raise HTTPException(400, "word is required")
    record = vocab_service.review_word(word, req.correct)
    if record is None:
        raise HTTPException(404, f"word not in vocabulary: {word}")
    return {"ok": True, "item": record}


@app.post("/api/vocabulary/review-session")
async def vocabulary_review_session(req: VocabularyReviewModeRequest):
    """Generate a review session from due words.

    Returns a list of questions in the requested mode. For modes that need
    distractors (choice/listening), picks them from the rest of the vocabulary.
    """
    mode = (req.mode or "choice").strip().lower()
    if mode not in ("choice", "spelling", "listening"):
        raise HTTPException(400, "mode must be one of: choice, spelling, listening")

    due = vocab_service.due_words()
    all_words = vocab_service.list_words()
    word_pool = [w["word"] for w in all_words if w.get("word")]

    questions = []
    for word in due[: req.count]:
        item = {
            "word": word["word"],
            "meaning_native": word.get("meaning_native", ""),
            "meaning_en": word.get("meaning_en", ""),
            "pos": word.get("pos", ""),
            "proficiency": word.get("proficiency", 1),
        }

        if mode == "choice":
            # 4 choices: correct meaning + 3 distractor meanings
            distractors = [
                w.get("meaning_native", "") or w.get("meaning_en", "")
                for w in all_words
                if w.get("word") and w["word"].lower() != word["word"].lower()
                and (w.get("meaning_native") or w.get("meaning_en"))
            ]
            import random
            random.seed(word["word"])
            choices = [item["meaning_native"] or item["meaning_en"]]
            for d in random.sample(distractors, min(3, len(distractors))):
                if d not in choices:
                    choices.append(d)
            random.shuffle(choices)
            item["choices"] = choices
            item["answer"] = item["meaning_native"] or item["meaning_en"]

        elif mode == "listening":
            # 4 choices: correct word + 3 distractor words
            distractors = [
                w["word"] for w in all_words
                if w.get("word") and w["word"].lower() != word["word"].lower()
            ]
            import random
            random.seed(word["word"])
            choices = [word["word"]]
            for d in random.sample(distractors, min(3, len(distractors))):
                if d not in choices:
                    choices.append(d)
            random.shuffle(choices)
            item["choices"] = choices
            item["answer"] = word["word"]

        elif mode == "spelling":
            item["answer"] = word["word"]

        questions.append(item)

    return {"mode": mode, "questions": questions, "stats": vocab_service.stats()}


@app.post("/api/vocabulary")
async def vocabulary_add(req: VocabularyAddRequest):
    word = (req.word or "").strip()
    if not word:
        raise HTTPException(400, "word is required")
    if not is_english_word(word):
        raise HTTPException(400, f"unsupported token: {word!r}")
    native_lang = dict_service.normalize_target_lang(req.native_lang)
    try:
        record = vocab_service.add_word({
            "word": word,
            "lemma": req.lemma or lemma(word),
            "phonetic": req.phonetic or "",
            "pos": req.pos or "",
            "meaning_en": req.meaning_en or "",
            "meaning_native": req.meaning_native or "",
            "native_lang": native_lang,
            "example": req.example,
            "source_history_id": req.source_history_id,
            "roots": req.roots,
            "etymology_en": req.etymology_en,
            "etymology_native": req.etymology_native,
            "family": req.family,
            "related": req.related,
        })
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "item": record}


@app.delete("/api/vocabulary/{word}")
async def vocabulary_remove(word: str):
    from urllib.parse import unquote
    decoded = unquote(word).strip()
    if not decoded:
        raise HTTPException(400, "word is required")
    removed = vocab_service.remove_word(decoded)
    if not removed:
        raise HTTPException(404, f"word not in vocabulary: {decoded}")
    return {"ok": True, "word": decoded, "removed": True}


@app.get("/api/vocabulary/check/{word}")
async def vocabulary_check(word: str):
    from urllib.parse import unquote
    decoded = unquote(word).strip()
    return {"word": decoded, "saved": vocab_service.has_word(decoded)}


# ---------------------------------------------------------------------------
# AI 助手 (chat / exam / explain / generate)
# ---------------------------------------------------------------------------
@app.get("/api/ai/health")
async def ai_health():
    return ai_service.health()


@app.post("/api/ai/chat")
async def ai_chat(req: AIChatRequest):
    message = (req.message or "").strip()
    if not message:
        raise HTTPException(400, "message is required")
    try:
        result = await ai_service.chat(
            message=message,
            context=req.context or "",
            history=req.history,
            voice=req.voice or "Cherry",
        )
        return {"ok": True, **result}
    except RuntimeError as e:
        msg = str(e)
        if "DASHSCOPE_API_KEY" in msg:
            raise HTTPException(401, "DashScope API key is not configured")
        raise HTTPException(502, f"AI chat failed: {msg}")
    except Exception as e:
        logger.exception("[ai/chat] failed")
        raise HTTPException(500, f"AI chat error: {e}")


@app.post("/api/ai/chat/stream")
async def ai_chat_stream(req: AIChatRequest):
    """流式 AI 聊天（SSE）。"""
    message = (req.message or "").strip()
    if not message:
        raise HTTPException(400, "message is required")

    if not app_config.is_dashscope_configured():
        raise HTTPException(401, "DashScope API key is not configured")

    async def event_stream():
        async for data in ai_service.stream_chat(
            message=message,
            context=req.context or "",
            history=req.history,
            voice=req.voice or "Cherry",
        ):
            yield f"data: {data}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/ai/exam")
async def ai_exam_chat(req: AIExamChatRequest):
    message = (req.message or "").strip()
    question = (req.question or "").strip()
    if not message:
        raise HTTPException(400, "message is required")
    if not question:
        raise HTTPException(400, "question is required")
    try:
        result = await ai_service.exam_chat(
            message=message,
            question=question,
            question_index=max(0, req.question_index),
            total_questions=max(1, req.total_questions),
            history=req.history,
        )
        return {"ok": True, **result}
    except RuntimeError as e:
        msg = str(e)
        if "DASHSCOPE_API_KEY" in msg:
            raise HTTPException(401, "DashScope API key is not configured")
        raise HTTPException(502, f"AI exam failed: {msg}")
    except Exception as e:
        logger.exception("[ai/exam] failed")
        raise HTTPException(500, f"AI exam error: {e}")


@app.post("/api/ai/exam/generate")
async def ai_exam_generate(req: AIExamGenerateRequest):
    subtitles = req.subtitles or []
    # 若没传 subtitles 但传了 raw_text, 拆成单句列表
    if not subtitles and req.raw_text:
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", req.raw_text) if s.strip()]
        subtitles = [{"en": s} for s in sentences]
    try:
        result = await ai_service.generate_exam_questions(
            subtitles=subtitles,
            count=max(1, min(10, req.count)),
        )
        return {"ok": True, **result}
    except RuntimeError as e:
        msg = str(e)
        if "DASHSCOPE_API_KEY" in msg:
            raise HTTPException(401, "DashScope API key is not configured")
        raise HTTPException(502, f"AI generate failed: {msg}")
    except Exception as e:
        logger.exception("[ai/exam/generate] failed")
        raise HTTPException(500, f"AI generate error: {e}")


@app.post("/api/ai/explain")
async def ai_explain(req: AIExplainRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "text is required")
    try:
        result = await ai_service.explain(text=text, context=req.context or "")
        return {"ok": True, **result}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        msg = str(e)
        if "DASHSCOPE_API_KEY" in msg:
            raise HTTPException(401, "DashScope API key is not configured")
        raise HTTPException(502, f"AI explain failed: {msg}")
    except Exception as e:
        logger.exception("[ai/explain] failed")
        raise HTTPException(500, f"AI explain error: {e}")


# ---------------------------------------------------------------------------
# AI Voice Chat (ASR → AI → TTS)
# ---------------------------------------------------------------------------
@app.post("/api/ai/voice-chat")
async def ai_voice_chat(
    audio: UploadFile = File(...),
    context: str = Form(""),
    history: str = Form("[]"),
    language: str = Form("en"),
    voice: str = Form("Cherry"),
):
    """Voice conversation: ASR → AI chat → TTS.
    
    Receives audio file, transcribes it, sends to AI, returns AI text + audio reply.
    """
    if not app_config.is_dashscope_configured():
        raise HTTPException(401, "DashScope API key is not configured")
    
    try:
        # Read audio file
        file_bytes = await audio.read()
        if not file_bytes:
            raise HTTPException(400, "Audio file is empty")
        
        filename = audio.filename or "audio.webm"
        content_type = audio.content_type or "audio/webm"
        
        # 1. ASR: Convert speech to text
        logger.info("[voice-chat] ASR started: %s, %d bytes", filename, len(file_bytes))
        asr_result = await transcribe_audio(file_bytes, filename, content_type, language=language)
        
        if not asr_result or not asr_result.get("text"):
            raise HTTPException(400, "Could not transcribe audio. Please speak clearly and try again.")
        
        user_text = asr_result["text"]
        logger.info("[voice-chat] ASR result: %s", user_text[:100])
        
        # 2. AI Chat: Process the transcribed text
        history_list = json.loads(history) if history else []
        ai_result = await ai_service.chat(
            message=user_text,
            context=context,
            history=history_list,
            voice=voice,
        )
        
        # 3. Return text + audio (already generated by ai_service.chat)
        return {
            "ok": True,
            "transcription": user_text,
            "reply": ai_result["reply"],
            "audio": ai_result.get("audio", ""),
            "model": ai_result.get("model", ""),
            "asr_duration": asr_result.get("duration", 0),
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[voice-chat] failed")
        raise HTTPException(500, f"Voice chat failed: {e}")


# ---------------------------------------------------------------------------
# AI Video Test
# ---------------------------------------------------------------------------
class VideoTestRequest(BaseModel):
    subtitles: str
    previous_question: Optional[str] = ""
    user_answer: Optional[str] = ""
    history: Optional[list] = None
    voice: Optional[str] = "Cherry"

@app.post("/api/ai/video-test")
async def ai_video_test(req: VideoTestRequest):
    """Video comprehension test based on subtitles."""
    if not app_config.is_dashscope_configured():
        raise HTTPException(401, "DashScope API key is not configured")
    
    try:
        result = await ai_service.video_test(
            subtitles=req.subtitles,
            previous_question=req.previous_question or "",
            user_answer=req.user_answer or "",
            history=req.history,
            voice=req.voice or "Cherry",
        )
        return {"ok": True, **result}
    except RuntimeError as e:
        msg = str(e)
        if "DASHSCOPE_API_KEY" in msg:
            raise HTTPException(401, "DashScope API key is not configured")
        raise HTTPException(502, f"AI video test failed: {msg}")
    except Exception as e:
        logger.exception("[ai/video-test] failed")
        raise HTTPException(500, f"AI video test error: {e}")


# ---------------------------------------------------------------------------
# Cache stats & cost estimate
# ---------------------------------------------------------------------------
@app.get("/api/cache/stats")
async def cache_stats_endpoint():
    from services import sentence_cache as sc
    return {
        "dict_cache": dict_service.cache_stats(),
        "trans_cache": sc.stats(),
        "tts_cache": {
            "disk_files": _count_tts_cache(),
        },
    }


def _count_tts_cache() -> int:
    try:
        from services.voice_service import TTS_CACHE_DIR
        return len(list(TTS_CACHE_DIR.glob("*.mp3")))
    except Exception:
        return 0


@app.post("/api/cache/clear")
async def cache_clear(target: str = "trans"):
    """Clear a specific cache. target ∈ {trans, dict, tts, all}."""
    target = (target or "trans").lower()
    cleared = {"trans": 0, "dict": 0, "tts": 0}
    if target in ("trans", "all"):
        from services import sentence_cache as sc
        cleared["trans"] = sc.clear()
    if target in ("dict", "all"):
        try:
            from services.dictionary import CACHE_DIR
            for fp in CACHE_DIR.glob("*.json"):
                try:
                    fp.unlink()
                    cleared["dict"] += 1
                except Exception:
                    pass
        except Exception:
            pass
    if target in ("tts", "all"):
        try:
            from services.voice_service import TTS_CACHE_DIR
            for fp in TTS_CACHE_DIR.glob("*"):
                try:
                    fp.unlink()
                    cleared["tts"] += 1
                except Exception:
                    pass
        except Exception:
            pass
    return {"ok": True, "cleared": cleared, "target": target}


@app.get("/api/cost/estimate")
async def cost_estimate():
    """Estimate the savings gained by using turbo+flash instead of qwen-plus,
    based on current cache sizes and assumed workload."""
    from services import sentence_cache as sc
    # DashScope public pricing (CNY / 1k tokens) — checked 2024
    pricing = {
        "qwen-plus":  {"input": 0.004,  "output": 0.012,  "speed_tps": 70},
        "qwen-turbo": {"input": 0.003,  "output": 0.006,  "speed_tps": 150},
        "qwen-flash": {"input": 0.0005, "output": 0.002,  "speed_tps": 250},
    }
    current_translate = app_config.get_setting("TRANSLATE_MODEL", "qwen-turbo")
    current_word = app_config.get_setting("WORD_LLM_MODEL", "qwen-flash")

    # Heuristics: 1 video/day (100 sentences) + 10 word lookups/day (2 L1-miss)
    workload = {
        "subtitle_sentences_per_day": 100,
        "word_lookups_per_day": 10,
        "l1_miss_rate": 0.20,
    }

    def est(model: str, inp: int, out: int) -> dict:
        p = pricing.get(model, pricing["qwen-plus"])
        in_cost = inp * p["input"] / 1000
        out_cost = out * p["output"] / 1000
        return {
            "cost_cny": round(in_cost + out_cost, 6),
            "latency_s": round(out / max(p["speed_tps"], 1), 2),
        }

    # Cost with qwen-plus everywhere (the OLD baseline)
    plus_subtitle = est("qwen-plus", 2200, 1000)
    plus_word_miss = est("qwen-plus", 200, 180)
    plus_word_xlate = est("qwen-plus", 250, 120)
    plus_daily = (
        plus_subtitle["cost_cny"]
        + (workload["word_lookups_per_day"] * workload["l1_miss_rate"]) * plus_word_miss["cost_cny"]
        + (workload["word_lookups_per_day"] * (1 - workload["l1_miss_rate"])) * plus_word_xlate["cost_cny"]
    )
    plus_latency = (
        plus_subtitle["latency_s"]
        + (workload["word_lookups_per_day"] * workload["l1_miss_rate"]) * plus_word_miss["latency_s"]
        + (workload["word_lookups_per_day"] * (1 - workload["l1_miss_rate"])) * plus_word_xlate["latency_s"]
    )

    # Cost with current (configurable) models
    cur_subtitle = est(current_translate, 2200, 1000)
    cur_word_miss = est(current_word, 200, 180)
    cur_word_xlate = est(current_word, 250, 120)
    cur_daily = (
        cur_subtitle["cost_cny"]
        + (workload["word_lookups_per_day"] * workload["l1_miss_rate"]) * cur_word_miss["cost_cny"]
        + (workload["word_lookups_per_day"] * (1 - workload["l1_miss_rate"])) * cur_word_xlate["cost_cny"]
    )
    cur_latency = (
        cur_subtitle["latency_s"]
        + (workload["word_lookups_per_day"] * workload["l1_miss_rate"]) * cur_word_miss["latency_s"]
        + (workload["word_lookups_per_day"] * (1 - workload["l1_miss_rate"])) * cur_word_xlate["latency_s"]
    )

    trans_cache = sc.stats()
    # Rough estimate: every cached sentence in trans_cache represents one saved LLM call.
    # We count that as one equivalent subtitle-translation call (avg tokens).
    per_saved_call_cost = cur_subtitle["cost_cny"] / max(workload["subtitle_sentences_per_day"], 1)
    cumulative_savings = round(trans_cache["disk_files"] * per_saved_call_cost, 4)

    return {
        "workload": workload,
        "current_models": {
            "TRANSLATE_MODEL": current_translate,
            "WORD_LLM_MODEL": current_word,
        },
        "baseline_qwen_plus": {
            "daily_cost_cny": round(plus_daily, 4),
            "daily_latency_s": round(plus_latency, 1),
            "monthly_cost_cny": round(plus_daily * 30, 2),
        },
        "current_setup": {
            "daily_cost_cny": round(cur_daily, 4),
            "daily_latency_s": round(cur_latency, 1),
            "monthly_cost_cny": round(cur_daily * 30, 2),
        },
        "savings": {
            "daily_cny": round(plus_daily - cur_daily, 4),
            "monthly_cny": round((plus_daily - cur_daily) * 30, 2),
            "daily_latency_s": round(plus_latency - cur_latency, 1),
            "speedup_x": round(plus_daily / max(cur_daily, 0.0001), 1),
        },
        "trans_cache": trans_cache,
        "cumulative_savings_from_cache_cny": cumulative_savings,
    }


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
# 生产构建产物位于 ../english-learning-web/dist
FRONTEND_DIR = (BASE_DIR.parent / "english-learning-web" / "dist").resolve()
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/")
    async def index():
        index_file = FRONTEND_DIR / "index.html"
        if index_file.exists():
            return FileResponse(index_file)
        return JSONResponse({"msg": "frontend not built"})

else:
    @app.get("/")
    async def index():
        return JSONResponse(
            {
                "msg": "frontend not built",
                "hint": f"Run 'npm run build' in {BASE_DIR.parent / 'english-learning-web'}",
                "expected_dir": str(FRONTEND_DIR),
            }
        )


if __name__ == "__main__":
    has_key = app_config.is_dashscope_configured()
    key_src = (
        "settings.json"
        if app_config.get_all_settings().get("DASHSCOPE_API_KEY")
        else ".env / environment"
    ) if has_key else "not configured"
    print("=" * 60)
    print("Shadow Reader starting...")
    print(f"   DashScope API key: {key_src}")
    if not has_key:
        print()
        print("   First-time setup: open http://localhost:8000")
        print("   and enter your DashScope API key in Settings (top-right).")
        print("   Or set DASHSCOPE_API_KEY in backend/.env.")
        print()
    print("=" * 60)
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
