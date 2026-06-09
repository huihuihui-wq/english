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
    voices: list  # [{id, name, desc, gender, language}]


# qwen3-tts-flash 非实时版支持的音色 (来自官方文档, 2026-06)
QWEN3_TTS_FLASH_VOICES = [
    {"id": "Cherry",      "name": "芊悦",       "desc": "阳光积极、亲切自然小姐姐",        "gender": "女", "language": "普通话"},
    {"id": "Serena",      "name": "苏瑶",       "desc": "温柔小姐姐",                     "gender": "女", "language": "普通话"},
    {"id": "Ethan",       "name": "晨煦",       "desc": "标准普通话，北方口音，阳光温暖",   "gender": "男", "language": "普通话"},
    {"id": "Chelsie",     "name": "千雪",       "desc": "二次元虚拟女友",                 "gender": "女", "language": "普通话"},
    {"id": "Momo",        "name": "茉兔",       "desc": "撒娇搞怪，逗你开心",              "gender": "女", "language": "普通话"},
    {"id": "Vivian",      "name": "十三",       "desc": "拽拽的、可爱的小暴躁",            "gender": "女", "language": "普通话"},
    {"id": "Moon",        "name": "月白",       "desc": "率性帅气的月白",                  "gender": "男", "language": "普通话"},
    {"id": "Maia",        "name": "四月",       "desc": "知性与温柔的碰撞",                "gender": "女", "language": "普通话"},
    {"id": "Kai",         "name": "凯",         "desc": "耳朵的一场SPA",                  "gender": "男", "language": "普通话"},
    {"id": "Nofish",      "name": "不吃鱼",     "desc": "不会翘舌音的设计师",              "gender": "男", "language": "普通话"},
    {"id": "Bella",       "name": "萌宝",       "desc": "喝酒不打醉拳的小萝莉",            "gender": "女", "language": "普通话"},
    {"id": "Jennifer",    "name": "詹妮弗",     "desc": "品牌级、电影质感般美语女声",       "gender": "女", "language": "普通话"},
    {"id": "Ryan",        "name": "甜茶",       "desc": "节奏拉满，戏感炸裂",              "gender": "男", "language": "普通话"},
    {"id": "Katerina",    "name": "卡捷琳娜",   "desc": "御姐音色，韵律回味十足",           "gender": "女", "language": "普通话"},
    {"id": "Aiden",       "name": "艾登",       "desc": "精通厨艺的美语大男孩",            "gender": "男", "language": "普通话"},
    {"id": "Eldric Sage", "name": "沧明子",     "desc": "沉稳睿智的老者",                  "gender": "男", "language": "普通话"},
    {"id": "Mia",         "name": "乖小妹",     "desc": "温顺如春水，乖巧如初雪",           "gender": "女", "language": "普通话"},
    {"id": "Mochi",       "name": "沙小弥",     "desc": "聪明伶俐的小大人",                "gender": "男", "language": "普通话"},
    {"id": "Bellona",     "name": "燕铮莺",     "desc": "声音洪亮，吐字清晰",              "gender": "女", "language": "普通话"},
    {"id": "Vincent",     "name": "田叔",       "desc": "独特的沙哑烟嗓",                  "gender": "男", "language": "普通话"},
    {"id": "Bunny",       "name": "萌小姬",     "desc": "萌属性爆棚的小萝莉",              "gender": "女", "language": "普通话"},
    {"id": "Neil",        "name": "阿闻",       "desc": "专业的新闻主持人",                "gender": "男", "language": "普通话"},
    {"id": "Elias",       "name": "墨讲师",     "desc": "学科严谨，叙事易理解",             "gender": "女", "language": "普通话"},
    {"id": "Arthur",      "name": "徐大爷",     "desc": "岁月浸泡过的质朴嗓音",            "gender": "男", "language": "普通话"},
    {"id": "Nini",        "name": "邻家妹妹",   "desc": "又软又黏的嗓音",                  "gender": "女", "language": "普通话"},
    {"id": "Seren",       "name": "小婉",       "desc": "温和舒缓，助眠",                  "gender": "女", "language": "普通话"},
    {"id": "Pip",         "name": "顽屁小孩",   "desc": "调皮捣蛋充满童真",                "gender": "男", "language": "普通话"},
    {"id": "Stella",      "name": "少女阿月",   "desc": "甜到发腻的迷糊少女",              "gender": "女", "language": "普通话"},
    {"id": "Bodega",      "name": "博德加",     "desc": "热情的西班牙大叔",                "gender": "男", "language": "普通话"},
    {"id": "Sonrisa",     "name": "索尼莎",     "desc": "热情开朗的拉美大姐",              "gender": "女", "language": "普通话"},
    {"id": "Alek",        "name": "阿列克",     "desc": "战斗民族的冷",                    "gender": "男", "language": "普通话"},
    {"id": "Dolce",       "name": "多尔切",     "desc": "慵懒的意大利大叔",                "gender": "男", "language": "普通话"},
    {"id": "Sohee",       "name": "素熙",       "desc": "温柔开朗的韩国欧尼",              "gender": "女", "language": "普通话"},
    {"id": "Ono Anna",    "name": "小野杏",     "desc": "鬼灵精怪的青梅竹马",              "gender": "女", "language": "普通话"},
    {"id": "Lenn",        "name": "莱恩",       "desc": "理性的德国青年",                  "gender": "男", "language": "普通话"},
    {"id": "Emilien",     "name": "埃米尔安",   "desc": "浪漫的法国大哥哥",                "gender": "男", "language": "普通话"},
    {"id": "Andre",       "name": "安德雷",     "desc": "声音磁性的沉稳男生",              "gender": "男", "language": "普通话"},
    {"id": "Radio Gol",   "name": "拉迪奥·戈尔", "desc": "足球诗人解说员",                  "gender": "男", "language": "普通话"},
    # 方言
    {"id": "Jada",        "name": "上海-阿珍",   "desc": "风风火火的沪上阿姐",              "gender": "女", "language": "上海话"},
    {"id": "Dylan",       "name": "北京-晓东",   "desc": "北京胡同里长大的少年",            "gender": "男", "language": "北京话"},
    {"id": "Li",          "name": "南京-老李",   "desc": "耐心的瑜伽老师",                  "gender": "男", "language": "南京话"},
    {"id": "Marcus",      "name": "陕西-秦川",   "desc": "面宽话短，心实声沉",              "gender": "男", "language": "陕西话"},
    {"id": "Roy",         "name": "闽南-阿杰",   "desc": "诙谐直爽的台湾哥仔",              "gender": "男", "language": "闽南语"},
    {"id": "Peter",       "name": "天津-李彼得", "desc": "天津相声专业捧哏",                "gender": "男", "language": "天津话"},
    {"id": "Sunny",       "name": "四川-晴儿",   "desc": "甜到心里的川妹子",                "gender": "女", "language": "四川话"},
    {"id": "Eric",        "name": "四川-程川",   "desc": "跳脱市井的成都男子",              "gender": "男", "language": "四川话"},
    {"id": "Rocky",       "name": "粤语-阿强",   "desc": "幽默风趣在线陪聊",                "gender": "男", "language": "粤语"},
    {"id": "Kiki",        "name": "粤语-阿清",   "desc": "甜美的港妹闺蜜",                  "gender": "女", "language": "粤语"},
]


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
        voices=QWEN3_TTS_FLASH_VOICES,
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
    """为在线视频生成字幕（默认仅返回英文，不自动翻译）"""
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

            # 注意：默认不自动翻译中文，由前端在用户勾选「显示中文」时
            # 通过 /api/translate-subtitles 触发翻译，避免无谓的 token 消耗。
            for s in merged_subtitles:
                s["zh"] = ""

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


class TranslateSubtitlesRequest(BaseModel):
    sentences: list[str]


@app.post("/api/translate-subtitles")
async def translate_subtitles_api(req: TranslateSubtitlesRequest):
    """
    翻译字幕：仅在用户主动勾选「显示中文」时调用。
    入参：英文句子数组；返回：与入参等长的 [{en, zh}, ...]。
    """
    sentences = [s for s in (req.sentences or []) if isinstance(s, str) and s.strip()]
    if not sentences:
        return {"translations": []}

    try:
        translations = await translate_sentences(sentences)
    except Exception as e:
        logger.exception("翻译失败")
        raise HTTPException(500, f"翻译失败: {e}")

    return {"translations": translations}


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


# ========== 历史记录 API ==========
import hashlib
from datetime import datetime

HISTORY_DIR = BASE_DIR / "data" / "history"
HISTORY_DIR.mkdir(parents=True, exist_ok=True)


def _now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _history_id(payload: dict) -> str:
    """根据记录内容生成稳定 ID（同文件/同 URL 永远拿到同一 ID）"""
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
        logger.warning(f"历史记录文件读取失败: {fp}")
        return None


def _write_history_file(record: dict) -> None:
    fp = HISTORY_DIR / f"{record['id']}.json"
    fp.write_text(
        json.dumps(record, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _list_history_files() -> list[dict]:
    items = []
    for fp in HISTORY_DIR.glob("*.json"):
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
            # 列表接口不返回字幕全文，节省流量
            lite = {k: v for k, v in data.items() if k not in ("subtitles", "raw_text")}
            lite["has_subtitles"] = bool(data.get("subtitles"))
            items.append(lite)
        except Exception:
            logger.warning(f"历史记录跳过损坏文件: {fp}")
    items.sort(key=lambda x: x.get("last_opened") or x.get("created_at") or "", reverse=True)
    return items


class HistoryCreateRequest(BaseModel):
    type: str  # local | youtube | online_url
    title: str
    source: str  # 文件名 / YouTube ID / 在线 URL
    size_bytes: int = 0
    duration: float = 0
    subtitles: list[dict] = []
    raw_text: str = ""
    progress_seconds: float = 0


class HistoryProgressRequest(BaseModel):
    progress_seconds: float


@app.get("/api/history")
async def list_history():
    """列出所有历史记录（不含字幕正文）"""
    return {"items": _list_history_files()}


@app.get("/api/history/{history_id}")
async def get_history(history_id: str):
    """获取单条历史记录（含字幕）"""
    rec = _read_history_file(history_id)
    if not rec:
        raise HTTPException(404, "历史记录不存在")
    return rec


@app.post("/api/history")
async def create_or_update_history(req: HistoryCreateRequest):
    """创建或更新历史记录。
    同一文件/URL 重复上传时，会保留最早记录、刷新字幕和 last_opened 进度。
    """
    if req.type not in ("local", "youtube", "online_url"):
        raise HTTPException(400, "type 必须是 local / youtube / online_url")

    hid = _history_id(req.model_dump())
    existing = _read_history_file(hid)
    now = _now_iso()
    if existing:
        # 合并：保留 created_at 和 open_count，刷新字幕和进度
        rec = existing
        rec["title"] = req.title or rec.get("title", "")
        rec["source"] = req.source or rec.get("source", "")
        rec["size_bytes"] = req.size_bytes or rec.get("size_bytes", 0)
        rec["duration"] = req.duration or rec.get("duration", 0)
        rec["subtitles"] = req.subtitles or rec.get("subtitles", [])
        rec["raw_text"] = req.raw_text or rec.get("raw_text", "")
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
            "created_at": now,
            "last_opened": now,
            "open_count": 1,
        }
    _write_history_file(rec)
    return {"id": hid, "open_count": rec["open_count"]}


@app.patch("/api/history/{history_id}/progress")
async def update_history_progress(history_id: str, req: HistoryProgressRequest):
    """仅更新观看进度（节流调用）"""
    rec = _read_history_file(history_id)
    if not rec:
        raise HTTPException(404, "历史记录不存在")
    rec["progress_seconds"] = max(0, float(req.progress_seconds))
    rec["last_opened"] = _now_iso()
    _write_history_file(rec)
    return {"id": history_id, "progress_seconds": rec["progress_seconds"]}


@app.delete("/api/history/{history_id}")
async def delete_history(history_id: str):
    fp = HISTORY_DIR / f"{history_id}.json"
    if not fp.exists():
        raise HTTPException(404, "历史记录不存在")
    fp.unlink()
    return {"id": history_id, "deleted": True}


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
