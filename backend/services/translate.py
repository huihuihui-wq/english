"""Hunyuan-MT-7B 翻译服务 - 通过 SiliconFlow Chat Completions"""
import os
import json
import re
import logging
import httpx

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a professional English-to-Chinese (Simplified) translator for a language learning shadowing app.
The user provides a JSON array of English sentences. You must return a JSON array with the SAME length and order.
Each item: {"en": "<original english>", "zh": "<natural simplified Chinese translation>"}.

Rules:
- Keep sentence order and count EXACTLY matching the input.
- Translations must be natural, fluent Simplified Chinese.
- Keep proper nouns, brand names, and English terms when appropriate.
- Output ONLY valid JSON. No explanations, no markdown fences."""


def _get_config():
    return {
        "api_key": os.getenv("SILICONFLOW_API_KEY", ""),
        "base_url": os.getenv("SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1"),
        "model": os.getenv("TRANSLATE_MODEL", "tencent/Hunyuan-MT-7B"),
    }


async def translate_sentences(sentences: list[str]) -> list[dict]:
    """
    将英文句子数组翻译为 [{en, zh}, ...]
    """
    if not sentences:
        return []

    cfg = _get_config()
    if not cfg["api_key"]:
        raise RuntimeError("SILICONFLOW_API_KEY 未配置")

    endpoint = f"{cfg['base_url']}/chat/completions"

    user_payload = json.dumps(sentences, ensure_ascii=False)
    user_prompt = f"Translate this JSON array:\n{user_payload}\nReturn JSON array only."

    body = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }

    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }

    logger.info(f"Translate request: {len(sentences)} sentences, model={cfg['model']}")

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(endpoint, headers=headers, json=body)

    if resp.status_code != 200:
        logger.error(f"Translate failed: {resp.status_code} {resp.text}")
        raise RuntimeError(f"翻译失败: {resp.status_code} {resp.text[:300]}")

    result = resp.json()
    content = result["choices"][0]["message"]["content"]
    logger.info(f"Translate ok, raw_len={len(content)}")

    return _parse_translation_response(content, sentences)


def _parse_translation_response(content: str, original_sentences: list[str]) -> list[dict]:
    """
    解析模型输出，容错处理：
    - 去除 markdown 围栏
    - 若模型返回 dict 包裹数组，提取数组
    - 若数量不匹配，按原文回填中文
    """
    text = content.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    text = text.strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if not match:
            logger.warning("Translate response is not valid JSON, falling back")
            return [{"en": s, "zh": ""} for s in original_sentences]
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            return [{"en": s, "zh": ""} for s in original_sentences]

    arr = None
    if isinstance(parsed, list):
        arr = parsed
    elif isinstance(parsed, dict):
        for key in ("translations", "result", "data", "sentences", "items"):
            if key in parsed and isinstance(parsed[key], list):
                arr = parsed[key]
                break
        if arr is None:
            for v in parsed.values():
                if isinstance(v, list):
                    arr = v
                    break

    if not arr:
        return [{"en": s, "zh": ""} for s in original_sentences]

    out = []
    for i, en in enumerate(original_sentences):
        zh = ""
        if i < len(arr):
            item = arr[i]
            if isinstance(item, dict):
                zh = item.get("zh") or item.get("translation") or item.get("cn") or ""
            elif isinstance(item, str):
                zh = item
        out.append({"en": en, "zh": zh})

    return out
