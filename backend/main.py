"""FastAPI main entry - Shadow Reader"""
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
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from services import config as app_config
from services import dictionary as dict_service
from services import vocabulary as vocab_service
from services.asr import transcribe_audio
from services.subtitle import (
    _fallback_proportional,
    build_subtitles_from_speech_segments,
    split_sentences_with_timestamps,
)
from services.translate import translate_sentences
from services.voice_service import synthesize as tts_synthesize
from services.word_tts import synthesize_word
from services.word_tokenize import is_english_word, lemma, normalize_for_lookup

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


class ConfigUpdateRequest(BaseModel):
    DASHSCOPE_API_KEY: Optional[str] = None
    DICT_LANG: Optional[str] = None


class TranslateSubtitlesRequest(BaseModel):
    sentences: list[str]
    target_lang: Optional[str] = "Chinese"
    source_lang: Optional[str] = "English"


class SubtitleGenerateRequest(BaseModel):
    video_url: str
    language: str = "en"


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
    meaning_zh: Optional[str] = ""
    meaning_en: Optional[str] = ""
    example: Optional[dict] = None
    source_history_id: Optional[str] = None


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
    return {"has_api_key": has_key, "DASHSCOPE_API_KEY": masked}


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
        app_config.set_setting("DICT_LANG", req.DICT_LANG.strip() or "Chinese", persist=True)
        if action == "none":
            action = "saved"
    if action == "none":
        raise HTTPException(400, "DASHSCOPE_API_KEY or DICT_LANG is required")
    has_key = bool(app_config.get_dashscope_api_key())
    masked = app_config.mask_key(
        app_config.get_all_settings().get("DASHSCOPE_API_KEY", "")
    )
    return {"ok": True, "action": action, "has_api_key": has_key, "DASHSCOPE_API_KEY": masked}


# ---------------------------------------------------------------------------
# Transcribe (local audio/video)
# ---------------------------------------------------------------------------
@app.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe(
    file: UploadFile = File(...),
    duration: Optional[float] = Form(None),
    language: str = Form("en"),
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
            msg = str(e)
            if "not configured" in msg.lower():
                raise HTTPException(401, msg)
            if "401" in msg or "InvalidApiKey" in msg:
                raise HTTPException(401, "Invalid DashScope API key. Please check your key in Settings.")
            raise HTTPException(502, f"ASR service error: {msg}")

        text = asr_result.get("text", "").strip()
        words = asr_result.get("words", [])
        segments = asr_result.get("segments")
        real_duration = asr_result.get("duration_ms", 0) / 1000.0

        if words:
            items = split_sentences_with_timestamps(words, text, language=language)
        elif segments and (segments.get("speech") or segments.get("non_speech")):
            items = build_subtitles_from_speech_segments(
                text,
                segments.get("speech", []),
                segments.get("non_speech", []),
                language=language,
            )
        else:
            real_duration = _get_real_duration(str(tmp_path)) or get_audio_duration(file_bytes, content_type)
            items = _fallback_proportional(text, int(real_duration * 1000), language=language)

        if not items:
            raise HTTPException(400, "No sentences could be extracted")

        if duration is None or duration <= 0:
            duration = real_duration or get_audio_duration(file_bytes, content_type)

        # Auto-translate only English source for now; non-English sources keep translation blank
        # so the user can manually translate later. Skip placeholder entries.
        if language == "en":
            translate_indices = [i for i, it in enumerate(items) if not it.get("is_placeholder")]
            en_list = [items[i]["en"] for i in translate_indices]
            trans_map = {i: {"en": items[i]["en"], "zh": ""} for i in translate_indices}
            if en_list:
                try:
                    translations = await translate_sentences(en_list)
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
        )
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass


@app.post("/api/transcribe/test")
async def transcribe_test():
    if not app_config.is_dashscope_configured():
        raise HTTPException(401, "DashScope API key is not configured")

    api_key = app_config.get_dashscope_api_key()
    base_url = app_config.get_setting("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/api/v1")
    url = f"{base_url}/services/aigc/text-generation/generation"
    payload = {
        "model": "qwen-plus",
        "input": {"messages": [{"role": "user", "content": "Respond with OK only."}]},
        "parameters": {"max_tokens": 10},
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
        if resp.status_code == 200:
            return {"ok": True}
        raise HTTPException(502, f"DashScope returned HTTP {resp.status_code}: {resp.text[:200]}")
    except httpx.RequestError as e:
        logger.warning("Transcribe test connection failed: %s", e)
        raise HTTPException(502, f"Connection test failed: {e}")


# ---------------------------------------------------------------------------
# Subtitle generation for online videos
# ---------------------------------------------------------------------------
async def _process_online_video(video_url: str, language: str = "en") -> dict:
    language = (language or "en").strip().lower()
    logger.info("Processing online video: %s, lang=%s", video_url, language)

    try:
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            response = await client.get(video_url)
            response.raise_for_status()
            file_bytes = response.content
    except Exception as e:
        logger.error("Failed to download video: %s", e)
        raise HTTPException(400, f"Unable to download video: {e}")

    if not file_bytes:
        raise HTTPException(400, "Downloaded file is empty")

    size_mb = len(file_bytes) / 1024 / 1024
    if size_mb > MAX_UPLOAD_MB:
        raise HTTPException(413, f"Video exceeds {MAX_UPLOAD_MB}MB limit ({size_mb:.1f}MB)")

    tmp_name = f"online_{int(time.time())}.mp4"
    tmp_path = TEMP_DIR / tmp_name
    tmp_path.write_bytes(file_bytes)
    mp3_path = TEMP_DIR / (tmp_name.rsplit(".", 1)[0] + ".mp3")

    try:
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
        real_duration = asr_result.get("duration_ms", 0) / 1000.0

        if words:
            items = split_sentences_with_timestamps(words, text, language=language)
        elif segments and (segments.get("speech") or segments.get("non_speech")):
            items = build_subtitles_from_speech_segments(
                text,
                segments.get("speech", []),
                segments.get("non_speech", []),
                language=language,
            )
        else:
            real_duration = real_duration or _get_real_duration(str(mp3_path))
            items = _fallback_proportional(text, int(real_duration * 1000), language=language)

        if not items:
            raise HTTPException(400, "No sentences could be extracted")

        if language == "en":
            translate_indices = [i for i, it in enumerate(items) if not it.get("is_placeholder")]
            en_list = [items[i]["en"] for i in translate_indices]
            trans_map = {i: {"en": items[i]["en"], "zh": ""} for i in translate_indices}
            if en_list:
                try:
                    translations = await translate_sentences(en_list)
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
            "source": "ai_recognition",
            "source_lang": language,
        }
    finally:
        for p in (tmp_path, mp3_path):
            try:
                if p.exists():
                    p.unlink()
            except Exception:
                pass


@app.post("/api/generate-subtitles")
async def generate_subtitles_api(req: SubtitleGenerateRequest):
    video_url = req.video_url
    is_youtube = "youtube.com" in video_url or "youtu.be" in video_url

    if is_youtube:
        logger.info("Fetching YouTube subtitles: %s", video_url)
        try:
            from services.youtube_subtitles import get_youtube_subtitles

            result = await get_youtube_subtitles(video_url)
            subtitles = result["subtitles"]
            if not subtitles:
                raise HTTPException(400, "This video has no subtitles. Try another video or upload an SRT file.")

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
        except (ValueError, RuntimeError) as e:
            logger.warning("YouTube subtitle fetch failed, falling back to AI recognition: %s", e)
            try:
                ai_result = await _process_online_video(video_url, req.language)
                ai_result["source"] = "ai_recognition_fallback"
                ai_result["fallback_reason"] = str(e)
                return ai_result
            except Exception as ai_err:
                logger.exception("AI subtitle fallback also failed")
                raise HTTPException(
                    500,
                    f"YouTube subtitles failed and AI fallback also failed:\n"
                    f"  · Subtitle path: {e}\n"
                    f"  · AI path: {ai_err}\n"
                    f"Suggestions:\n"
                    f"  1. Upload an SRT file manually\n"
                    f"  2. Try a different video\n"
                    f"  3. Set YT_COOKIES in backend/.env if YouTube blocks your IP",
                )

    return await _process_online_video(video_url, req.language)


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
        translations = await translate_sentences(
            sentences, target_lang=target_lang, source_lang=req.source_lang or "en"
        )
    except Exception as e:
        logger.exception("Translation failed")
        raise HTTPException(500, f"Translation failed: {e}")

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
        "quota": {
            "total_quota": total_quota,
            "used_tokens": current_used + estimated_tokens,
            "remaining": max(0, total_quota - current_used - estimated_tokens),
        },
    }


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
async def word_lookup(word: str, force_refresh: bool = False):
    if not word or not word.strip():
        raise HTTPException(400, "word is required")
    if not is_english_word(word):
        raise HTTPException(400, f"unsupported token: {word!r}")
    target = normalize_for_lookup(word)
    try:
        if force_refresh:
            dict_service.invalidate(target)
        entry = await dict_service.lookup_word(target)
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


@app.post("/api/vocabulary")
async def vocabulary_add(req: VocabularyAddRequest):
    word = (req.word or "").strip()
    if not word:
        raise HTTPException(400, "word is required")
    if not is_english_word(word):
        raise HTTPException(400, f"unsupported token: {word!r}")
    try:
        record = vocab_service.add_word({
            "word": word,
            "lemma": req.lemma or lemma(word),
            "phonetic": req.phonetic or "",
            "pos": req.pos or "",
            "meaning_zh": req.meaning_zh or "",
            "meaning_en": req.meaning_en or "",
            "example": req.example,
            "source_history_id": req.source_history_id,
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
# Static frontend
# ---------------------------------------------------------------------------
FRONTEND_DIR = (BASE_DIR.parent / "frontend").resolve()
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/")
    async def index():
        index_file = FRONTEND_DIR / "index.html"
        if index_file.exists():
            return FileResponse(index_file)
        return JSONResponse({"msg": "frontend not built"})


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
