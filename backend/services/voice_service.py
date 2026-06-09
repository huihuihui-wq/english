"""语音对话服务 - TTS 引擎: 阿里云百炼 qwen3-tts-flash (非实时, HTTP 同步)

替代了此前的 qwen3-tts-instruct-flash-realtime, 使用更新更简洁的 qwen3-tts-flash。
非流式调用, 适合 AI 对话回复这种"段落级"合成。

API 形态: dashscope.MultiModalConversation.call(model="qwen3-tts-flash", text, voice, language_type, stream=False)
返回: response.output.audio.url (24h 有效, 后端下载后转 base64 给前端)
"""
import os
import base64
import json
import logging
import asyncio
import io
import hashlib
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
DASHSCOPE_BASE_URL = os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/api/v1")

# TTS 默认参数
TTS_MODEL = os.getenv("TTS_MODEL", "qwen3-tts-flash")
TTS_VOICE = os.getenv("TTS_VOICE", "Cherry")  # 系统默认女声
TTS_LANGUAGE = os.getenv("TTS_LANGUAGE", "Chinese")

# 缓存: 避免重复合成相同文本 (在 AI 对话场景里常出现相同回复)
TTS_CACHE_DIR = Path(os.getenv("TTS_CACHE_DIR", str(Path(__file__).resolve().parent.parent / ".tts_cache")))
TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
TTS_CACHE_TTL = int(os.getenv("TTS_CACHE_TTL_HOURS", "168")) * 3600  # 默认 7 天


def _cache_key(text: str, voice: str, model: str) -> str:
    raw = f"{model}|{voice}|{text.strip()}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _cache_get(key: str) -> Optional[bytes]:
    p = TTS_CACHE_DIR / f"{key}.wav"
    if not p.exists():
        return None
    if time.time() - p.stat().st_mtime > TTS_CACHE_TTL:
        try:
            p.unlink()
        except Exception:
            pass
        return None
    try:
        return p.read_bytes()
    except Exception:
        return None


def _cache_put(key: str, audio_bytes: bytes) -> None:
    p = TTS_CACHE_DIR / f"{key}.wav"
    try:
        p.write_bytes(audio_bytes)
    except Exception as e:
        logger.warning(f"缓存写入失败: {e}")


# ========== 1. Paraformer ASR 语音识别 ==========

async def transcribe_with_paraformer(audio_bytes: bytes, filename: str = "audio.wav") -> str:
    """使用 Paraformer-8k-v1 将语音转为文字"""
    if not DASHSCOPE_API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY 未配置")
    import httpx

    max_size = 9 * 1024 * 1024
    if len(audio_bytes) > max_size:
        raise RuntimeError(f"音频文件过大: {len(audio_bytes)/1024/1024:.1f}MB > 9MB")

    b64 = base64.b64encode(audio_bytes).decode()
    data_uri = f"data:audio/wav;base64,{b64}"
    headers = {
        "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "paraformer-8k-v1",
        "input": {"messages": [{"role": "user", "content": [{"audio": data_uri}]}]},
        "parameters": {"result_format": "message", "asr_options": {"language": "auto", "enable_itn": True}},
    }
    url = f"{DASHSCOPE_BASE_URL}/services/aigc/multimodal-generation/generation"
    logger.info(f"Paraformer ASR 请求: size={len(audio_bytes)} bytes")
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code != 200:
        raise RuntimeError(f"语音识别失败: {resp.status_code}")
    result = resp.json()
    choices = result["output"]["choices"]
    if not choices:
        raise RuntimeError("ASR返回为空")
    message = choices[0]["message"]
    text = ""
    if isinstance(message, dict):
        if "text" in message:
            text = message["text"]
        elif "content" in message and isinstance(message["content"], list):
            for item in message["content"]:
                if isinstance(item, dict) and "text" in item:
                    text = item["text"]; break
    return text.strip()


# ========== 2. qwen-plus 对话生成 ==========

CHAT_SYSTEM_PROMPT = """You are an English speaking coach for Chinese learners.
Your goal is to help users practice English conversation naturally.

Rules:
1. Respond primarily in English, but use simple Chinese for difficult concepts
2. Be encouraging and patient
3. Correct grammar mistakes gently
4. Keep responses concise (2-4 sentences normally, longer for detailed feedback)
5. Adapt to the user's English level
6. When video context is provided, reference it naturally"""

async def generate_chat_response(message: str, context: Optional[str] = None) -> str:
    if not DASHSCOPE_API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY 未配置")
    import httpx
    headers = {"Authorization": f"Bearer {DASHSCOPE_API_KEY}", "Content-Type": "application/json"}
    messages = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]
    if context:
        messages.append({"role": "system", "content": f"Video context: {context[:2000]}"})
    messages.append({"role": "user", "content": message})
    payload = {"model": "qwen-plus", "messages": messages, "temperature": 0.7}
    url = f"{DASHSCOPE_BASE_URL}/services/aigc/text-generation/generation"
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code != 200:
        raise RuntimeError(f"对话生成失败: {resp.status_code}")
    return resp.json()["output"]["text"].strip()


# ========== 3. qwen3-tts-flash 语音合成 (主入口) ==========

def _wav_to_mp3_bytes(wav_bytes: bytes) -> bytes:
    """wav 字节 -> mp3 字节, 失败回退直接返回 wav。"""
    try:
        from pydub import AudioSegment
        audio = AudioSegment.from_wav(io.BytesIO(wav_bytes))
        buf = io.BytesIO()
        audio.export(buf, format="mp3", bitrate="64k")
        return buf.getvalue()
    except Exception as e:
        logger.warning(f"wav->mp3 转换失败, 返回原 wav: {e}")
        return wav_bytes


async def _qwen3_tts_synthesize(text: str, voice: str = TTS_VOICE) -> bytes:
    """
    直接用 httpx 调 DashScope HTTP API, 绕开 SDK 兼容性问题。
    接口: POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
    """
    if not DASHSCOPE_API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY 未配置, 无法调用 qwen3-tts-flash")
    if not text or not text.strip():
        return b""

    # 优先命中磁盘缓存
    key = _cache_key(text, voice, TTS_MODEL)
    cached = _cache_get(key)
    if cached is not None:
        logger.info(f"[TTS] 命中缓存: key={key[:8]}, size={len(cached)}")
        return cached

    import httpx
    url = f"{DASHSCOPE_BASE_URL.rstrip('/')}/services/aigc/multimodal-generation/generation"
    headers = {
        "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": TTS_MODEL,
        "input": {
            "text": text,
            "voice": voice,
            "language_type": TTS_LANGUAGE,
        },
    }
    # 调试: 打印 body 字节, 确认编码
    body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    logger.info(f"[TTS] body bytes len={len(body_bytes)}, first 80: {body_bytes[:80]!r}")
    logger.info(f"[TTS] body text (first 100): {payload['input']['text'][:100]!r}")

    t0 = time.time()
    logger.info(f"[TTS] POST {url} model={TTS_MODEL} voice={voice} text_len={len(text)}")
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, headers=headers, json=payload)
    logger.info(f"[TTS] 响应: status={r.status_code}, cost={time.time()-t0:.2f}s")

    if r.status_code != 200:
        logger.error(f"[TTS] HTTP {r.status_code}: {r.text[:500]}")
        raise RuntimeError(f"TTS HTTP {r.status_code}: {r.text[:300]}")

    result = r.json()
    output = result.get("output") or {}
    audio_obj = output.get("audio") if isinstance(output, dict) else None
    if not audio_obj or not audio_obj.get("url"):
        # 错误响应结构
        raise RuntimeError(f"TTS 输出为空: code={result.get('code')}, message={result.get('message')}")

    audio_url = audio_obj["url"]
    logger.info(f"[TTS] 下载音频: {audio_url[:100]}...")
    async with httpx.AsyncClient(timeout=60.0) as client:
        rr = await client.get(audio_url)
    if rr.status_code != 200:
        raise RuntimeError(f"下载 TTS 音频失败: {rr.status_code}")
    audio_bytes = rr.content
    logger.info(f"[TTS] 下载完成: {len(audio_bytes)} bytes, 总耗时 {time.time()-t0:.2f}s")

    # 写缓存
    _cache_put(key, audio_bytes)
    return audio_bytes


async def synthesize_speech(text: str, voice: str = TTS_VOICE) -> bytes:
    """
    合成语音主入口. 保持原接口签名不变, 前端无需修改.
    默认模型: qwen3-tts-flash (可由 TTS_MODEL 环境变量覆盖)
    """
    if not text or not text.strip():
        return b""
    if not DASHSCOPE_API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY 未配置, 无法合成语音")
    return await _qwen3_tts_synthesize(text, voice=voice)


# ========== 4. 完整语音对话流程 ==========

async def voice_chat(audio_bytes: bytes, context: Optional[str] = None) -> dict:
    """完整语音对话: ASR -> AI -> TTS"""
    logger.info("=== 语音对话流程开始 ===")
    try:
        user_text = await transcribe_with_paraformer(audio_bytes)
    except Exception as e:
        logger.warning(f"ASR 失败: {e}")
        user_text = ""
    if not user_text:
        return {
            "user_text": "", "ai_text": "抱歉，我没有听清你说的话，请再说一遍。",
            "audio_base64": "", "audio_mime": "audio/mp3",
        }
    logger.info(f"用户说: {user_text}")
    try:
        ai_text = await generate_chat_response(user_text, context)
    except Exception as e:
        logger.warning(f"AI 失败: {e}")
        return {
            "user_text": user_text, "ai_text": "抱歉，AI 回复失败。",
            "audio_base64": "", "audio_mime": "audio/mp3",
        }
    logger.info(f"AI回复: {ai_text}")
    try:
        audio_bytes = await synthesize_speech(ai_text)
        audio_b64 = base64.b64encode(audio_bytes).decode()
    except Exception as e:
        logger.error(f"TTS 失败: {e}")
        audio_b64 = ""
    return {
        "user_text": user_text, "ai_text": ai_text,
        "audio_base64": audio_b64, "audio_mime": "audio/mp3",
    }
