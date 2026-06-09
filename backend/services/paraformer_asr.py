"""Paraformer ASR 服务 - 提供剪映级别的精准字幕识别

支持词级时间戳，毫秒级精度。
"""
import os
import json
import logging
import tempfile
import subprocess
import httpx
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ========== 配置 ==========
API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
PARAFORMER_MODEL = "paraformer-v2"

# OSS 配置（可选，用于本地文件上传）
OSS_ACCESS_KEY = os.getenv("OSS_ACCESS_KEY_ID", "")
OSS_SECRET_KEY = os.getenv("OSS_ACCESS_KEY_SECRET", "")
OSS_BUCKET = os.getenv("OSS_BUCKET_NAME", "")
OSS_ENDPOINT = os.getenv("OSS_ENDPOINT", "oss-cn-beijing.aliyuncs.com")


def _ensure_ffmpeg():
    """检查 ffmpeg 是否可用"""
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        return True
    except Exception:
        return False


def extract_audio(file_bytes: bytes, source_ext: str) -> bytes:
    """提取音频为 MP3 格式"""
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
            raise RuntimeError(f"ffmpeg 失败: {result.stderr[:200]}")

        with open(out_path, "rb") as f:
            return f.read()
    finally:
        for p in (src_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def upload_to_oss(file_bytes: bytes, filename: str) -> str:
    """上传文件到阿里云 OSS，返回公网 URL"""
    if not all([OSS_ACCESS_KEY, OSS_SECRET_KEY, OSS_BUCKET]):
        raise RuntimeError(
            "OSS 未配置。请在 .env 中设置:\n"
            "OSS_ACCESS_KEY_ID=你的AccessKey\n"
            "OSS_ACCESS_KEY_SECRET=你的Secret\n"
            "OSS_BUCKET_NAME=你的Bucket名\n"
            "OSS_ENDPOINT=oss-cn-beijing.aliyuncs.com"
        )

    import oss2

    auth = oss2.Auth(OSS_ACCESS_KEY, OSS_SECRET_KEY)
    bucket = oss2.Bucket(auth, OSS_ENDPOINT, OSS_BUCKET)

    # 生成临时文件名
    import uuid
    key = f"shadow-reader/temp/{uuid.uuid4().hex}_{filename}"

    # 上传
    bucket.put_object(key, file_bytes)

    # 生成临时URL（1小时有效）
    url = bucket.sign_url("GET", key, 3600)
    logger.info(f"OSS 上传成功: {key}")

    return url, key


def delete_from_oss(object_key: str):
    """从 OSS 删除文件"""
    if not all([OSS_ACCESS_KEY, OSS_SECRET_KEY, OSS_BUCKET]):
        return

    try:
        import oss2
        auth = oss2.Auth(OSS_ACCESS_KEY, OSS_SECRET_KEY)
        bucket = oss2.Bucket(auth, OSS_ENDPOINT, OSS_BUCKET)
        bucket.delete_object(object_key)
        logger.info(f"OSS 删除成功: {object_key}")
    except Exception as e:
        logger.warning(f"OSS 删除失败: {e}")


async def transcribe_with_paraformer(audio_url: str, language: str = "en") -> dict:
    """
    使用 Paraformer 识别音频，返回词级时间戳。

    Args:
        audio_url: 公网可访问的音频 URL
        language: 语言代码 (en, zh, ja, etc.)

    Returns:
        {
            "text": "完整文本",
            "words": [{"text": "Hello", "begin_time": 100, "end_time": 500}, ...],
            "sentences": [{"text": "Hello world.", "begin_time": 100, "end_time": 1200, "words": [...]}, ...],
            "duration_ms": 12345
        }
    """
    if not API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY 未配置")

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
    }

    # 提交任务
    payload = {
        "model": PARAFORMER_MODEL,
        "input": {
            "file_urls": [audio_url]
        },
        "parameters": {
            "channel_id": [0],
            "language_hints": [language],
            "timestamp_alignment_enabled": True,  # 启用时间戳校准
            "disfluency_removal_enabled": False,
        }
    }

    submit_url = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription"

    logger.info(f"Paraformer ASR 提交任务: {audio_url}")

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(submit_url, headers=headers, json=payload)

    if resp.status_code != 200:
        error_text = resp.text[:500]
        logger.error(f"Paraformer 提交失败: {resp.status_code} {error_text}")
        raise RuntimeError(f"ASR 提交失败: {resp.status_code} {error_text}")

    result = resp.json()
    task_id = result["output"]["task_id"]
    logger.info(f"Paraformer 任务ID: {task_id}")

    # 轮询查询结果
    query_url = f"https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"
    max_retries = 120  # 最多等待 120 * 2 = 240 秒
    retry_interval = 2

    for i in range(max_retries):
        await __import__("asyncio").sleep(retry_interval)

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(query_url, headers=headers)

        if resp.status_code != 200:
            continue

        result = resp.json()
        status = result["output"]["task_status"]

        if status == "SUCCEEDED":
            # 获取识别结果 URL
            results = result["output"].get("results", [])
            if not results or results[0].get("subtask_status") != "SUCCEEDED":
                raise RuntimeError("ASR 任务失败")

            transcription_url = results[0].get("transcription_url")
            if not transcription_url:
                raise RuntimeError("未获取到识别结果 URL")

            # 下载识别结果
            async with httpx.AsyncClient(timeout=30.0) as client:
                result_resp = await client.get(transcription_url)

            if result_resp.status_code != 200:
                raise RuntimeError(f"下载识别结果失败: {result_resp.status_code}")

            transcription_data = result_resp.json()
            return _parse_paraformer_result(transcription_data)

        elif status == "FAILED":
            error_msg = result.get("output", {}).get("results", [{}])[0].get("message", "未知错误")
            raise RuntimeError(f"ASR 任务失败: {error_msg}")

        # 继续等待
        logger.info(f"Paraformer 任务状态: {status}, 等待中... ({i+1}/{max_retries})")

    raise RuntimeError("ASR 任务超时，请稍后重试")


def _parse_paraformer_result(data: dict) -> dict:
    """解析 Paraformer 识别结果"""
    transcripts = data.get("transcripts", [])
    if not transcripts:
        raise RuntimeError("识别结果为空")

    transcript = transcripts[0]
    sentences_data = transcript.get("sentences", [])

    all_words = []
    sentences = []
    full_text = ""

    for sent in sentences_data:
        sent_text = sent.get("text", "")
        sent_begin = sent.get("begin_time", 0)
        sent_end = sent.get("end_time", 0)
        sent_words = []

        for w in sent.get("words", []):
            word_info = {
                "text": w.get("text", ""),
                "begin_time": w.get("begin_time", 0),
                "end_time": w.get("end_time", 0),
                "punctuation": w.get("punctuation", ""),
            }
            all_words.append(word_info)
            sent_words.append(word_info)

        sentences.append({
            "text": sent_text,
            "begin_time": sent_begin,
            "end_time": sent_end,
            "words": sent_words,
        })

        if full_text:
            full_text += " "
        full_text += sent_text

    duration_ms = transcript.get("content_duration_in_milliseconds", 0)
    if not duration_ms and all_words:
        duration_ms = max(w["end_time"] for w in all_words)

    logger.info(f"Paraformer 识别完成: {len(all_words)} 词, {len(sentences)} 句, {duration_ms}ms")

    return {
        "text": full_text.strip(),
        "words": all_words,
        "sentences": sentences,
        "duration_ms": duration_ms,
    }


async def transcribe_local_file(file_bytes: bytes, filename: str, content_type: str, language: str = "en") -> dict:
    """
    识别本地文件，自动上传到 OSS 获取公网 URL。

    流程:
    1. 提取音频（如果是视频）
    2. 上传到 OSS
    3. 调用 Paraformer 识别
    4. 删除 OSS 文件
    """
    # 提取音频
    source_ext = (filename.rsplit(".", 1)[-1] if "." in filename else "mp4").lower()
    if content_type.startswith("video/") or source_ext in ("mp4", "mov", "avi", "mkv", "flv", "webm"):
        logger.info("视频文件，提取音频...")
        file_bytes = extract_audio(file_bytes, source_ext)
        filename = "audio.mp3"

    # 上传 OSS
    oss_url = None
    oss_key = None
    try:
        logger.info("上传音频到 OSS...")
        oss_url, oss_key = upload_to_oss(file_bytes, filename)

        # 识别
        result = await transcribe_with_paraformer(oss_url, language)
        return result

    finally:
        # 清理 OSS
        if oss_key:
            delete_from_oss(oss_key)


async def transcribe_online_video(video_url: str, language: str = "en") -> dict:
    """
    识别在线视频，自动下载音频后上传识别。

    支持 YouTube 和普通视频链接。
    """
    import subprocess

    # 创建临时目录
    temp_dir = tempfile.mkdtemp(prefix="video_")
    audio_path = os.path.join(temp_dir, "audio.mp3")

    try:
        # 使用 yt-dlp 下载音频
        logger.info(f"下载视频音频: {video_url}")
        cmd = [
            "yt-dlp",
            "--no-check-certificates",
            "--no-warnings",
            "-f", "bestaudio[ext=m4a]/bestaudio/best",
            "-o", audio_path,
            "--extract-audio",
            "--audio-format", "mp3",
            "--audio-quality", "64k",
            video_url,
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        if result.returncode != 0:
            raise RuntimeError(f"视频下载失败: {result.stderr[:300]}")

        # 检查文件
        if not os.path.exists(audio_path):
            possible_files = [f for f in os.listdir(temp_dir) if f.endswith((".mp3", ".m4a", ".webm"))]
            if possible_files:
                audio_path = os.path.join(temp_dir, possible_files[0])
            else:
                raise RuntimeError("音频提取失败")

        # 读取并识别
        with open(audio_path, "rb") as f:
            audio_bytes = f.read()

        return await transcribe_local_file(audio_bytes, "audio.mp3", "audio/mpeg", language)

    finally:
        # 清理临时文件
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)


def get_oss_config_status() -> dict:
    """获取 OSS 配置状态"""
    return {
        "configured": all([OSS_ACCESS_KEY, OSS_SECRET_KEY, OSS_BUCKET]),
        "bucket": OSS_BUCKET,
        "endpoint": OSS_ENDPOINT,
    }
