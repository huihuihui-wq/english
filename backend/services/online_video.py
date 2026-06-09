"""在线视频处理服务 - 下载并识别字幕"""
import os
import time
import logging
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

# 临时目录
import tempfile
TEMP_DIR = Path(tempfile.mkdtemp(prefix="shadow_online_"))

MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "200"))


async def process_online_video(video_url: str, language: str = "en") -> dict:
    """
    处理在线视频链接，下载并生成字幕。
    
    流程:
    1. 下载视频/音频
    2. ffmpeg 抽音
    3. 尝试 Paraformer（如果 OSS 配置）
    4. 否则回退到 qwen3-asr-flash
    5. 切句并翻译
    """
    logger.info(f"正在处理在线视频: {video_url}")
    
    import httpx
    from fastapi import HTTPException
    
    # 下载视频/音频文件
    try:
        logger.info("正在下载视频...")
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            response = await client.get(video_url)
            response.raise_for_status()
            file_bytes = response.content
    except Exception as e:
        logger.error(f"下载视频失败: {e}")
        raise HTTPException(400, f"无法下载视频: {str(e)}\n请检查链接是否有效，或尝试直接上传文件。")
    
    if not file_bytes:
        raise HTTPException(400, "下载的文件为空")
    
    size_mb = len(file_bytes) / 1024 / 1024
    if size_mb > MAX_UPLOAD_MB:
        raise HTTPException(413, f"视频超过 {MAX_UPLOAD_MB}MB 限制 ({size_mb:.1f}MB)")
    
    logger.info(f"下载完成: {size_mb:.2f}MB")
    
    # 保存到临时文件
    tmp_name = f"online_{int(time.time())}.mp4"
    tmp_path = TEMP_DIR / tmp_name
    tmp_path.write_bytes(file_bytes)
    
    mp3_path = None
    
    try:
        # 提取音频
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
            raise RuntimeError("ffmpeg 抽音失败")
        
        logger.info(f"抽音完成: {mp3_path.stat().st_size} bytes")
        
        # 尝试 Paraformer（如果 OSS 已配置）
        from services.paraformer_asr import get_oss_config_status, transcribe_local_file
        
        oss_status = get_oss_config_status()
        words = []
        text = ""
        real_duration = 0
        
        if oss_status["configured"]:
            logger.info("OSS 已配置，使用 Paraformer 精准识别...")
            try:
                mp3_bytes = mp3_path.read_bytes()
                paraformer_result = await transcribe_local_file(
                    mp3_bytes, mp3_name, "audio/mpeg", language=language
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
            asr_result = await asr_flash(mp3_bytes, mp3_name, "audio/mpeg")
            text = asr_result.get("text", "").strip()
            words = asr_result.get("words", [])
            real_duration = asr_result.get("duration_ms", 0) / 1000.0
        
        # 使用词级时间戳切句（如果可用）
        if words:
            logger.info(f"使用词级时间戳切句: {len(words)} 词")
            from services.subtitle import split_sentences_with_timestamps
            items = split_sentences_with_timestamps(words, text)
        else:
            logger.info("无词级时间戳，使用比例分配")
            from services.audio_duration import get_audio_duration
            real_duration = get_audio_duration(file_bytes, "video/mp4")
            from services.subtitle import _fallback_proportional
            items = _fallback_proportional(text, int(real_duration * 1000))
        
        if not items:
            raise HTTPException(400, "未能切出任何句子")
        
        # 翻译
        en_list = [it["en"] for it in items]
        try:
            from services.translate import translate_sentences
            translations = await translate_sentences(en_list)
            for it, tr in zip(items, translations):
                it["zh"] = tr.get("zh", "")
        except Exception as e:
            logger.warning(f"翻译失败: {e}")
            for it in items:
                it["zh"] = ""
        
        duration = real_duration if real_duration > 0 else items[-1]["end"] / 1000.0
        
        subtitles = [
            {
                "start": round(it["start"] / 1000.0, 3),
                "end": round(it["end"] / 1000.0, 3),
                "en": it["en"],
                "zh": it["zh"],
            }
            for it in items
        ]
        
        logger.info(f"在线视频字幕生成成功: {len(subtitles)} 句")
        
        return {
            "subtitles": subtitles,
            "duration": round(duration, 2),
            "raw_text": text,
            "source": "ai_recognition",
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("字幕生成失败")
        raise HTTPException(500, f"字幕生成失败: {str(e)}")
    finally:
        # 清理临时文件
        try:
            if tmp_path.exists():
                tmp_path.unlink()
            if mp3_path and mp3_path.exists():
                mp3_path.unlink()
        except:
            pass
