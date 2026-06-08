"""DashScope Fun-ASR 异步转写（带词级时间戳）"""
import os
import time
import logging
import httpx

logger = logging.getLogger(__name__)

SUBMIT_URL = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription"
QUERY_URL = "https://dashscope.aliyuncs.com/api/v1/tasks/"


def _get_config():
    return {
        "api_key": os.getenv("DASHSCOPE_API_KEY", ""),
    }


def _headers(cfg: dict):
    return {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
    }


async def transcribe_with_words(audio_url: str, language: str = "en") -> dict:
    """
    调用 DashScope fun-asr 异步转写，返回:
    {
      "text": "完整文本",
      "words": [{"text": "Hello", "begin_time": 760, "end_time": 1000}, ...],
      "duration_ms": 3834,
      "sentences": [...]
    }
    """
    cfg = _get_config()
    if not cfg["api_key"]:
        raise RuntimeError("DASHSCOPE_API_KEY 未配置")

    payload = {
        "model": "fun-asr",
        "input": {
            "file_urls": [audio_url]
        },
        "parameters": {
            "channel_id": [0],
            "language_hints": [language],
        }
    }

    logger.info(f"ASR submit: url={audio_url}")
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(SUBMIT_URL, headers=_headers(cfg), json=payload)

    if resp.status_code != 200:
        raise RuntimeError(f"ASR 提交失败: {resp.status_code} {resp.text[:300]}")

    task_id = resp.json()["output"]["task_id"]
    logger.info(f"ASR task_id={task_id}")

    # 轮询
    for attempt in range(120):
        await client.aclose()
        async with httpx.AsyncClient(timeout=30.0) as client:
            q = await client.get(f"{QUERY_URL}{task_id}", headers=_headers(cfg))
        data = q.json()
        status = data.get("output", {}).get("task_status", "").upper()
        logger.info(f"ASR poll [{attempt+1}]: {status}")

        if status == "SUCCEEDED":
            return _parse_funasr_result(data)
        elif status in ("FAILED", "UNKNOWN"):
            raise RuntimeError(f"ASR 任务失败: {data}")

        time.sleep(2)

    raise RuntimeError("ASR 任务超时")


def _parse_funasr_result(data: dict) -> dict:
    """解析 fun-asr 结果 JSON"""
    try:
        results = data["output"]["results"]
        if not results:
            raise RuntimeError("ASR 结果为空")

        result = results[0]
        if result["subtask_status"] != "SUCCEEDED":
            raise RuntimeError(f"ASR subtask 失败: {result}")

        import urllib.request
        url = result["transcription_url"]
        with urllib.request.urlopen(url, timeout=60) as resp:
            json_data = json.loads(resp.read().decode("utf-8"))

        transcripts = json_data.get("transcripts", [])
        if not transcripts:
            raise RuntimeError("ASR transcripts 为空")

        transcript = transcripts[0]
        text = transcript.get("text", "").strip()
        sentences = transcript.get("sentences", [])

        # 提取词级时间戳
        words = []
        for sent in sentences:
            for w in sent.get("words", []):
                words.append({
                    "text": w.get("text", "").strip(),
                    "begin_time": int(w.get("begin_time", 0)),
                    "end_time": int(w.get("end_time", 0)),
                })

        duration_ms = transcript.get("content_duration_in_milliseconds", 0)
        if not duration_ms and words:
            duration_ms = max((w["end_time"] for w in words), default=0)

        logger.info(f"ASR ok: {len(words)} words, {len(sentences)} sentences, {duration_ms}ms")
        return {
            "text": text,
            "words": words,
            "sentences": sentences,
            "duration_ms": duration_ms,
        }
    except Exception as e:
        logger.exception(f"ASR 结果解析失败: {e}")
        raise RuntimeError(f"ASR 结果解析失败: {e}")
