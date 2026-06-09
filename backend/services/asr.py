"""DashScope ASR 服务 - qwen3-asr-flash (带词级时间戳)"""
import os
import base64
import subprocess
import tempfile
import logging
import httpx

logger = logging.getLogger(__name__)

# DashScope base64 内联音频上限 ≈ 10MB（编码后 ~13MB）
MAX_INLINE_BYTES = 9 * 1024 * 1024


def _get_config():
    return {
        "api_key": os.getenv("DASHSCOPE_API_KEY", ""),
        "base_url": os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/api/v1"),
        "model": os.getenv("ASR_MODEL", "qwen3-asr-flash"),
    }


def extract_audio_to_mp3(file_bytes: bytes, source_ext: str) -> bytes:
    """用 ffmpeg 把任意音视频转 mp3 音频流，体积大幅缩小"""
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
            logger.error(f"ffmpeg failed: {result.stderr[:500]}")
            raise RuntimeError(f"ffmpeg 抽音失败: {result.stderr[:200]}")

        with open(out_path, "rb") as f:
            mp3_bytes = f.read()

        logger.info(f"抽音完成: {len(file_bytes)} → {len(mp3_bytes)} bytes")
        return mp3_bytes
    finally:
        for p in (src_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


async def transcribe_audio(file_bytes: bytes, filename: str, content_type: str) -> dict:
    """
    调用 DashScope qwen3-asr-flash，返回:
    {
      "text": "完整英文文本",
      "words": [{"text": "Hello", "begin_time": 0, "end_time": 500}, ...],
      "duration_ms": 12345
    }
    """
    cfg = _get_config()
    if not cfg["api_key"]:
        raise RuntimeError("DASHSCOPE_API_KEY 未配置")

    # 视频或大文件 → 先 ffmpeg 抽音压缩
    source_ext = (filename.rsplit(".", 1)[-1] if "." in filename else "mp4").lower()
    if content_type.startswith("video/") or len(file_bytes) > MAX_INLINE_BYTES:
        if content_type.startswith("video/") or source_ext in ("mp4", "mov", "avi", "mkv", "flv", "webm"):
            logger.info(f"检测到{'视频' if content_type.startswith('video/') else '大文件'}，ffmpeg 抽音")
            file_bytes = extract_audio_to_mp3(file_bytes, source_ext)
        else:
            raise RuntimeError(f"文件 {len(file_bytes)/1024/1024:.1f}MB 超过 9MB 限制（仅 mp3/wav/m4a 等已压缩音频）")

    if len(file_bytes) > MAX_INLINE_BYTES:
        raise RuntimeError(f"抽音后仍 {len(file_bytes)/1024/1024:.1f}MB > 9MB，请使用更短音频")

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
                "language": "en",
                "enable_itn": False,
            },
        },
    }

    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }

    url = f"{cfg['base_url']}/services/aigc/multimodal-generation/generation"
    logger.info(f"ASR request: model={cfg['model']}, size={len(file_bytes)} bytes")

    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(url, headers=headers, json=payload)

    if resp.status_code != 200:
        logger.error(f"ASR failed: {resp.status_code} {resp.text[:500]}")
        raise RuntimeError(f"ASR 调用失败: {resp.status_code} {resp.text[:300]}")

    result = resp.json()
    return _parse_response(result)


def _parse_response(resp: dict) -> dict:
    """解析 DashScope qwen3-asr-flash 响应，提取 text + words"""
    try:
        choices = resp["output"]["choices"]
        if not choices:
            raise RuntimeError("ASR 返回 choices 为空")
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
            raise RuntimeError(f"ASR 响应中未找到 text/words: {resp}")

        if not text and words:
            text = "".join(w["text"] for w in words)

        if words and not audio_duration_ms:
            audio_duration_ms = max((w["end_time"] for w in words), default=0)

        logger.info(f"ASR ok: {len(words)} words, {audio_duration_ms}ms")
        return {
            "text": text.strip(),
            "words": words,
            "duration_ms": audio_duration_ms,
        }
    except (KeyError, IndexError, TypeError) as e:
        logger.exception(f"ASR 响应解析失败: {e}")
        raise RuntimeError(f"ASR 响应解析失败: {e}; raw={str(resp)[:300]}")
