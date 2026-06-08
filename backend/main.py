"""FastAPI 主入口 - Shadow Reader"""
import os
import re
import json
import time
import logging
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from services.asr import transcribe_audio
from services.translate import translate_sentences
from services.subtitle import split_sentences_with_timestamps, _fallback_proportional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("shadow-reader")

app = FastAPI(title="Shadow Reader", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "200"))


class SubtitleItem(BaseModel):
    start: float
    end: float
    en: str
    zh: str = ""


class TranscribeResponse(BaseModel):
    duration: float
    subtitles: list[SubtitleItem]
    raw_text: str


def get_audio_duration(file_bytes: bytes, content_type: str) -> float:
    """
    估算音频时长。
    优先用 wave 模块解析 wav；否则用文件大小按比特率粗估。
    """
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
        logger.warning(f"wave 解析失败，回退估算: {e}")

    size_bytes = len(file_bytes)
    est_bitrate_kbps = 128
    return size_bytes * 8.0 / (est_bitrate_kbps * 1000.0)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


import subprocess
from services.funasr import transcribe_with_words

@app.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe(
    file: UploadFile = File(...),
    duration: Optional[float] = Form(None),
):
    """
    接收音频/视频文件：
    1) ffmpeg 抽音 → 存临时文件 → 本地 URL 供 fun-asr 下载
    2) DashScope fun-asr 异步转写，返回词级时间戳
    3) 按标点切句
    4) 调用 Hunyuan-MT-7B 翻译
    5) 返回结构化字幕（毫秒级对齐）
    """
    content_type = file.content_type or "application/octet-stream"
    filename = file.filename or "audio"
    file_bytes = await file.read()

    if not file_bytes:
        raise HTTPException(400, "文件为空")

    size_mb = len(file_bytes) / 1024 / 1024
    if size_mb > MAX_UPLOAD_MB:
        raise HTTPException(413, f"文件超过 {MAX_UPLOAD_MB}MB 限制 ({size_mb:.1f}MB)")

    logger.info(f"接收文件: {filename}, type={content_type}, size={size_mb:.2f}MB")

    # 保存原始文件到临时目录
    tmp_name = f"{int(time.time())}_{filename}"
    tmp_path = TEMP_DIR / tmp_name
    tmp_path.write_bytes(file_bytes)

    try:
        # 视频文件 → ffmpeg 抽音转 mp3
        ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
        if content_type.startswith("video/") or ext in ("mp4", "mov", "avi", "mkv", "flv", "webm"):
            mp3_name = tmp_name.rsplit(".", 1)[0] + ".mp3"
            mp3_path = TEMP_DIR / mp3_name
            cmd = [
                "ffmpeg", "-y", "-i", str(tmp_path),
                "-vn", "-acodec", "libmp3lame",
                "-ac", "1", "-ar", "16000", "-b:a", "64k",
                str(mp3_path),
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if result.returncode != 0:
                logger.error(f"ffmpeg failed: {result.stderr[:500]}")
                raise RuntimeError(f"ffmpeg 抽音失败")
            logger.info(f"抽音完成: {mp3_path.stat().st_size} bytes")
            serve_name = mp3_name
        else:
            serve_name = tmp_name

        # 构造本地可访问 URL（fun-asr 需要公网/内网 URL，这里用 localhost）
        # 注意：DashScope 服务器在外网，无法访问 localhost。
        # 解决方案：先用 qwen3-asr-flash 拿文本（已有），再用本地对齐
        # 或者使用 ngrok/内网穿透（复杂）。
        #  pragmatic 方案：回退到 qwen3-asr-flash + 比例分配，但修复 duration。
        #  更好的方案：用本地 whisper 强制对齐（需要装模型）。
        #  最简方案：先尝试用现有 qwen3-asr-flash 结果，如果 words 为空，
        #            用 ffprobe 拿真实 duration，再做比例分配（比文件大小估算准得多）。

        # 先用 qwen3-asr-flash 拿文本（传入抽音后的 mp3 字节）
        from services.asr import transcribe_audio as asr_flash
        mp3_bytes = file_bytes
        if content_type.startswith("video/") or ext in ("mp4", "mov", "avi", "mkv", "flv", "webm"):
            mp3_bytes = mp3_path.read_bytes()
        asr_result = await asr_flash(mp3_bytes, serve_name, "audio/mpeg")
        text = asr_result.get("text", "").strip()
        words = asr_result.get("words", [])

        # 如果 qwen3-asr-flash 没返回 words（通常情况），用 ffprobe 拿真实 duration 做比例分配
        if not words:
            logger.info("qwen3-asr-flash 未返回词级时间戳，用 ffprobe 拿真实时长 + 比例分配")
            real_duration = _get_real_duration(str(tmp_path))
            if real_duration <= 0:
                real_duration = get_audio_duration(file_bytes, content_type)

            # 比例分配时间戳
            from services.subtitle import _fallback_proportional
            items = _fallback_proportional(text, int(real_duration * 1000))
        else:
            items = split_sentences_with_timestamps(words, text)
            real_duration = asr_result.get("duration_ms", 0) / 1000.0

        if not items:
            raise HTTPException(400, "未能切出任何句子")

        if duration is None or duration <= 0:
            duration = real_duration if real_duration > 0 else get_audio_duration(file_bytes, content_type)

        en_list = [it["en"] for it in items]

        try:
            translations = await translate_sentences(en_list)
        except Exception as e:
            logger.exception("翻译失败")
            translations = [{"en": s, "zh": ""} for s in en_list]

        for it, tr in zip(items, translations):
            it["zh"] = tr.get("zh", "")

        subtitles = [
            SubtitleItem(
                start=round(it["start"] / 1000.0, 3),
                end=round(it["end"] / 1000.0, 3),
                en=it["en"],
                zh=it["zh"],
            )
            for it in items
        ]

        return TranscribeResponse(
            duration=round(duration, 2),
            subtitles=subtitles,
            raw_text=text,
        )

    finally:
        # 清理临时文件
        try:
            if tmp_path.exists():
                tmp_path.unlink()
            mp3_path = TEMP_DIR / (tmp_name.rsplit(".", 1)[0] + ".mp3")
            if mp3_path.exists():
                mp3_path.unlink()
        except Exception:
            pass


def _get_real_duration(filepath: str) -> float:
    """用 ffprobe 获取视频/音频真实时长（秒）"""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", filepath],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            return float(result.stdout.strip())
    except Exception:
        pass
    return 0.0


# 临时文件服务（供 fun-asr 异步任务下载）
import tempfile
import shutil
TEMP_DIR = Path(tempfile.mkdtemp(prefix="shadow_"))

@app.get("/tmp/{filename}")
async def serve_temp(filename: str):
    fp = TEMP_DIR / filename
    if fp.exists() and fp.is_file():
        return FileResponse(fp)
    raise HTTPException(404, "文件不存在")

# 内置素材 API
MATERIALS_DIR = (BASE_DIR / "data" / "materials").resolve()

import re as _re

def _parse_srt_time(s: str) -> float:
    """SRT 时间格式 00:00:00,000 → 秒"""
    m = _re.match(r"(\d+):(\d+):(\d+)[,.](\d+)", s.strip())
    if not m:
        return 0.0
    h, mn, sec, ms = m.groups()
    return int(h) * 3600 + int(mn) * 60 + int(sec) + int(ms) / 1000.0


def _parse_srt(content: str) -> list:
    """解析 SRT 为 [{start, end, en}]"""
    out = []
    blocks = _re.split(r"\n\s*\n", content.strip())
    for blk in blocks:
        lines = [l.rstrip() for l in blk.splitlines() if l.strip()]
        if len(lines) < 2:
            continue
        time_line = next((l for l in lines if "-->" in l), None)
        text_lines = [l for l in lines if l != time_line and not l.isdigit()]
        if not time_line or not text_lines:
            continue
        try:
            start_s, end_s = [_parse_srt_time(t) for t in time_line.split("-->")]
        except Exception:
            continue
        text = " ".join(text_lines).strip()
        if text:
            out.append({"start": start_s, "end": end_s, "en": text})
    return out


def _load_manifest():
    manifest_path = MATERIALS_DIR / "static" / "manifest.json"
    if not manifest_path.exists():
        return {"materials": [], "updated": None, "note": "manifest 不存在"}
    try:
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.error(f"manifest 解析失败: {e}")
        return {"materials": [], "updated": None, "note": str(e)}


@app.get("/api/materials")
async def list_materials(category: Optional[str] = None, difficulty: Optional[str] = None):
    """列出所有内置素材"""
    data = _load_manifest()
    items = data.get("materials", [])
    if category:
        items = [m for m in items if m.get("category") == category]
    if difficulty:
        items = [m for m in items if m.get("difficulty") == difficulty]
    return {
        "materials": items,
        "total": len(items),
        "updated": data.get("updated"),
    }


def _find_material_path(mid: str) -> Path | None:
    """在 static 和 daily 目录中查找素材路径"""
    # 先查 static
    static_path = MATERIALS_DIR / "static" / mid
    if static_path.exists():
        return static_path
    # 再查 daily 下的所有日期目录
    daily_parent = MATERIALS_DIR / "daily"
    if daily_parent.exists():
        for date_dir in sorted(daily_parent.iterdir(), reverse=True):
            if date_dir.is_dir():
                daily_path = date_dir / mid
                if daily_path.exists():
                    return daily_path
    return None


@app.get("/api/materials/{mid}/audio")
async def get_material_audio(mid: str):
    """获取素材音频"""
    base = _find_material_path(mid)
    if not base:
        raise HTTPException(404, "素材不存在")
    
    # 支持 mp3 和 wav
    for ext, mime in [(".mp3", "audio/mpeg"), (".wav", "audio/wav")]:
        fp = base / f"audio{ext}"
        if fp.exists():
            return FileResponse(fp, media_type=mime)
    
    raise HTTPException(404, "音频文件不存在")


@app.get("/api/materials/{mid}/srt")
async def get_material_srt(mid: str):
    """获取素材字幕"""
    base = _find_material_path(mid)
    if not base:
        raise HTTPException(404, "素材不存在")
    
    fp = base / "subtitles.srt"
    if not fp.exists():
        raise HTTPException(404, "字幕不存在")
    return FileResponse(fp, media_type="text/plain", charset="utf-8")


@app.get("/api/materials/{mid}/full")
async def get_material_full(mid: str):
    """
    一站式接口：返回素材的音频 URL + 解析后的字幕数组
    前端可一次性拿到全部信息，避免多次请求
    """
    manifest_data = _load_manifest()
    item = next((m for m in manifest_data.get("materials", []) if m["id"] == mid), None)
    if not item:
        raise HTTPException(404, "素材不存在")

    base = _find_material_path(mid)
    if not base:
        raise HTTPException(404, "素材目录不存在")
    
    srt_path = base / "subtitles.srt"
    if not srt_path.exists():
        raise HTTPException(404, "字幕文件不存在")

    content = srt_path.read_text(encoding="utf-8")
    subtitles = _parse_srt(content)

    duration = subtitles[-1]["end"] if subtitles else 0

    # 翻译（可选，失败不影响）
    en_list = [s["en"] for s in subtitles]
    try:
        from services.translate import translate_sentences
        translations = await translate_sentences(en_list)
        for s, tr in zip(subtitles, translations):
            s["zh"] = tr.get("zh", "")
    except Exception as e:
        logger.warning(f"素材 {mid} 翻译失败: {e}")
        for s in subtitles:
            s["zh"] = ""

    return {
        "id": item["id"],
        "title": item["title"],
        "duration": duration,
        "audio_url": item["audio_url"],
        "subtitles": subtitles,
        "is_placeholder": item.get("is_placeholder", False),
    }


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
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
