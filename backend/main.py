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


# ========== 纯 TTS API (供前端 TTS 测试 tab 使用) ==========
class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = None  # 不传则用环境变量 TTS_VOICE


class TTSInfoResponse(BaseModel):
    model: str
    voice: str
    language: str
    cache_dir: str
    cache_size: int


@app.post("/api/tts")
async def api_tts(req: TTSRequest):
    """
    纯 TTS 接口: 输入文本 -> 返回 MP3 音频字节.
    供前端 "TTS 测试" tab 调用, 与 AI 教练解耦.
    """
    from services.voice_service import synthesize_speech
    if not req.text or not req.text.strip():
        raise HTTPException(400, "text 不能为空")
    if len(req.text) > 2000:
        raise HTTPException(400, "text 过长 (上限 2000 字符)")
    try:
        audio_bytes = await synthesize_speech(req.text, voice=req.voice or os.getenv("TTS_VOICE", "Cherry"))
    except Exception as e:
        logger.exception("TTS 失败")
        raise HTTPException(500, f"TTS 失败: {e}")
    from fastapi import Response
    return Response(
        content=audio_bytes,
        media_type="audio/mp3",
        headers={
            "X-Text-Length": str(len(req.text)),
            "X-Audio-Size": str(len(audio_bytes)),
        },
    )


@app.get("/api/tts/info")
async def api_tts_info():
    """返回当前 TTS 配置 (供前端 UI 展示)."""
    from pathlib import Path
    cache_dir = Path(os.getenv("TTS_CACHE_DIR", str(BASE_DIR / ".tts_cache")))
    cache_size = 0
    if cache_dir.exists():
        cache_size = sum(1 for _ in cache_dir.glob("*.wav"))
    return TTSInfoResponse(
        model=os.getenv("TTS_MODEL", "qwen3-tts-flash"),
        voice=os.getenv("TTS_VOICE", "Cherry"),
        language=os.getenv("TTS_LANGUAGE", "Chinese"),
        cache_dir=str(cache_dir),
        cache_size=cache_size,
    )


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
    4) DashScope qwen-plus 翻译
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
            mp3_path = tmp_path

        # 尝试使用 Paraformer 进行精准识别（词级时间戳）
        from services.paraformer_asr import transcribe_local_file, get_oss_config_status
        
        oss_status = get_oss_config_status()
        words = []
        text = ""
        real_duration = 0
        
        if oss_status["configured"]:
            logger.info("OSS 已配置，使用 Paraformer 精准识别...")
            try:
                mp3_bytes = mp3_path.read_bytes()
                paraformer_result = await transcribe_local_file(
                    mp3_bytes, serve_name, "audio/mpeg", language="en"
                )
                text = paraformer_result["text"]
                words = paraformer_result["words"]
                real_duration = paraformer_result["duration_ms"] / 1000.0
                logger.info(f"Paraformer 识别成功: {len(words)} 词")
            except Exception as e:
                logger.warning(f"Paraformer 识别失败，回退到 qwen3-asr-flash: {e}")
                words = []
        else:
            logger.info("OSS 未配置，使用 qwen3-asr-flash...")

        # 如果 Paraformer 失败或未配置，回退到 qwen3-asr-flash
        if not words:
            from services.asr import transcribe_audio as asr_flash
            mp3_bytes = mp3_path.read_bytes()
            asr_result = await asr_flash(mp3_bytes, serve_name, "audio/mpeg")
            text = asr_result.get("text", "").strip()
            words = asr_result.get("words", [])
            real_duration = asr_result.get("duration_ms", 0) / 1000.0

        # 使用词级时间戳切句（如果可用）
        if words:
            logger.info(f"使用词级时间戳切句: {len(words)} 词")
            items = split_sentences_with_timestamps(words, text)
        else:
            logger.info("无词级时间戳，使用比例分配")
            real_duration = _get_real_duration(str(tmp_path))
            if real_duration <= 0:
                real_duration = get_audio_duration(file_bytes, content_type)
            from services.subtitle import _fallback_proportional
            items = _fallback_proportional(text, int(real_duration * 1000))

        if not items:
            raise HTTPException(400, "未能切出任何句子")

        if duration is None or duration <= 0:
            duration = real_duration if real_duration > 0 else get_audio_duration(file_bytes, content_type)

        en_list = [it["en"] for it in items]
        logger.info(f"准备翻译 {len(en_list)} 句: {en_list[:3]}...")

        try:
            translations = await translate_sentences(en_list)
            logger.info(f"翻译成功，返回 {len(translations)} 条")
            # 检查前几条的翻译结果
            for i, tr in enumerate(translations[:3]):
                logger.info(f"  翻译[{i}]: zh='{tr.get('zh', '')[:50]}'")
        except Exception as e:
            logger.exception(f"翻译失败: {e}")
            translations = [{"en": s, "zh": ""} for s in en_list]

        for it, tr in zip(items, translations):
            it["zh"] = tr.get("zh", "")
            logger.debug(f"字幕赋值: en='{it['en'][:30]}' -> zh='{it.get('zh', '')[:30]}'")

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
            mp3_tmp = TEMP_DIR / (tmp_name.rsplit(".", 1)[0] + ".mp3")
            if mp3_tmp.exists() and mp3_tmp != tmp_path:
                mp3_tmp.unlink()
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


# ========== AI 助手 API ==========
from services.ai_service import chat, exam_chat, generate_exam_questions
from services.voice_service import voice_chat, synthesize_speech

class ChatRequest(BaseModel):
    message: str
    context: Optional[str] = None
    mode: str = "chat"  # "chat" or "exam"
    question: Optional[str] = None
    questionIndex: int = 0
    totalQuestions: int = 0
    voice: bool = False  # 是否同时返回语音


@app.post("/api/ai/chat")
async def ai_chat(req: ChatRequest):
    """AI 对话接口（支持语音回复）"""
    try:
        if req.mode == "exam" and req.question:
            result = await exam_chat(
                message=req.message,
                question=req.question,
                question_index=req.questionIndex,
                total_questions=req.totalQuestions,
            )
            # 如果请求语音，合成语音
            if req.voice and result.get("reply"):
                from services.voice_service import synthesize_speech
                try:
                    audio_bytes = await synthesize_speech(result["reply"])
                    import base64
                    result["audio_base64"] = base64.b64encode(audio_bytes).decode()
                    result["audio_mime"] = "audio/mp3"
                except Exception as e:
                    logger.warning(f"语音合成失败: {e}")
                    result["audio_base64"] = ""
                    result["audio_mime"] = "audio/mp3"
            return result
        else:
            reply = await chat(
                message=req.message,
                context=req.context,
            )
            result = {"reply": reply}
            # 如果请求语音，合成语音
            if req.voice:
                from services.voice_service import synthesize_speech
                try:
                    audio_bytes = await synthesize_speech(reply)
                    import base64
                    result["audio_base64"] = base64.b64encode(audio_bytes).decode()
                    result["audio_mime"] = "audio/mp3"
                except Exception as e:
                    logger.warning(f"语音合成失败: {e}")
                    result["audio_base64"] = ""
                    result["audio_mime"] = "audio/mp3"
            return result
    except Exception as e:
        logger.exception("AI chat failed")
        raise HTTPException(500, f"AI对话失败: {str(e)}")


class ExamGenerateRequest(BaseModel):
    subtitles: list[dict]
    count: int = 3


@app.post("/api/ai/generate-exam")
async def ai_generate_exam(req: ExamGenerateRequest):
    """基于字幕生成雅思口语试题"""
    try:
        questions = await generate_exam_questions(
            subtitles=req.subtitles,
            count=min(req.count, 5),  # 最多5题
        )
        return {"questions": questions}
    except Exception as e:
        logger.exception("Exam generation failed")
        raise HTTPException(500, f"试题生成失败: {str(e)}")


# ========== 语音对话 API ==========
@app.post("/api/ai/voice-chat")
async def ai_voice_chat(
    file: UploadFile = File(...),
    context: Optional[str] = Form(None),
):
    """
    语音对话接口：
    1. 接收用户语音（WAV/WEBM格式）
    2. Paraformer ASR 识别 -> 文字
    3. qwen-plus 生成回复 -> 文字
    4. qwen3-tts 合成语音 -> MP3
    5. 返回识别结果+AI回复+语音数据
    """
    try:
        # 读取音频文件
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(400, "音频文件为空")
        
        logger.info(f"接收语音: {file.filename}, size={len(audio_bytes)/1024:.1f}KB")
        
        # 调用语音对话服务
        result = await voice_chat(audio_bytes, context)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Voice chat failed")
        raise HTTPException(500, f"语音对话失败: {str(e)}")


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

# ========== 字幕生成 API ==========
class SubtitleGenerateRequest(BaseModel):
    video_url: str
    language: str = "en"


@app.post("/api/generate-subtitles")
async def generate_subtitles_api(req: SubtitleGenerateRequest):
    """为在线视频生成字幕"""
    video_url = req.video_url
    is_youtube = "youtube.com" in video_url or "youtu.be" in video_url
    
    # ========== YouTube 视频：直接获取官方字幕 ==========
    if is_youtube:
        logger.info(f"正在获取 YouTube 字幕: {video_url}")
        
        try:
            from services.youtube_subtitles import get_youtube_subtitles
            result = await get_youtube_subtitles(video_url)
            
            subtitles = result["subtitles"]
            
            if not subtitles:
                raise HTTPException(400, "该视频没有字幕。请尝试其他视频或手动上传字幕文件。")
            
            # 合并短句（YouTube 字幕可能很短，按句子合并）
            merged_subtitles = _merge_short_subtitles(subtitles)
            
            # 翻译
            en_list = [s["en"] for s in merged_subtitles]
            try:
                from services.translate import translate_sentences
                translations = await translate_sentences(en_list)
                for s, tr in zip(merged_subtitles, translations):
                    s["zh"] = tr.get("zh", "")
            except Exception as e:
                logger.warning(f"翻译失败: {e}")
            
            duration = merged_subtitles[-1]["end"] if merged_subtitles else 0
            
            logger.info(f"YouTube 字幕获取成功: {len(merged_subtitles)} 句")
            
            return {
                "subtitles": merged_subtitles,
                "duration": round(duration, 2),
                "raw_text": result["raw_text"],
                "source": "youtube_official",
                "is_auto_generated": result.get("is_auto_generated", False),
            }
            
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            logger.exception("YouTube 字幕获取失败")
            raise HTTPException(500, f"获取 YouTube 字幕失败: {str(e)}")
    
    # ========== 普通视频链接（MP4/WebM 等）：使用 AI 识别 ==========
    from services.online_video import process_online_video
    return await process_online_video(video_url, req.language)


def _merge_short_subtitles(subtitles: list, min_duration: float = 3.0) -> list:
    """合并短的 YouTube 字幕片段为完整句子"""
    if not subtitles:
        return []
    
    merged = []
    current = None
    
    for sub in subtitles:
        text = sub["en"].strip()
        if not text:
            continue
        
        # 如果是新句子开始（首字母大写），且已有累积内容，先保存
        if current and (text[0].isupper() or text.startswith(('"', "'"))) and current["en"]:
            # 检查是否太短
            duration = current["end"] - current["start"]
            if duration >= min_duration or text.endswith(('.', '!', '?')):
                merged.append(current)
                current = None
        
        if current is None:
            current = {
                "start": sub["start"],
                "end": sub["end"],
                "en": text,
                "zh": "",
            }
        else:
            current["end"] = sub["end"]
            # 添加空格或标点
            if current["en"] and not current["en"].endswith(' ') and not text.startswith(' '):
                current["en"] += " "
            current["en"] += text
    
    # 保存最后一句
    if current and current["en"]:
        merged.append(current)
    
    return merged


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
