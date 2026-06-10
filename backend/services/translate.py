"""Translation service using DashScope qwen-plus via OpenAI-compatible chat completions."""
import json
import logging
import re

import httpx

logger = logging.getLogger(__name__)

SUPPORTED_TARGET_LANGS = [
    {"id": "Chinese",             "name": "Chinese (Simplified)",  "field": "zh",    "native": "简体中文"},
    {"id": "Chinese-Traditional", "name": "Chinese (Traditional)", "field": "zh-TW", "native": "繁體中文"},
    {"id": "Japanese",            "name": "Japanese",              "field": "ja",    "native": "日本語"},
    {"id": "Korean",              "name": "Korean",                "field": "ko",    "native": "한국어"},
    {"id": "French",              "name": "French",                "field": "fr",    "native": "Français"},
    {"id": "German",              "name": "German",                "field": "de",    "native": "Deutsch"},
    {"id": "Spanish",             "name": "Spanish",               "field": "es",    "native": "Español"},
    {"id": "Portuguese",          "name": "Portuguese",            "field": "pt",    "native": "Português"},
    {"id": "Russian",             "name": "Russian",               "field": "ru",    "native": "Русский"},
    {"id": "Italian",             "name": "Italian",               "field": "it",    "native": "Italiano"},
]

_TARGET_LANG_MAP = {x["id"]: x for x in SUPPORTED_TARGET_LANGS}

_TARGET_LANG_NAMES = {
    "Chinese": "Chinese (Simplified)",
    "Chinese-Traditional": "Traditional Chinese (Taiwan/Hong Kong)",
    "Japanese": "Japanese",
    "Korean": "Korean",
    "French": "French",
    "German": "German",
    "Spanish": "Spanish",
    "Portuguese": "Portuguese",
    "Russian": "Russian",
    "Italian": "Italian",
}


def _build_system_prompt(target_lang: str, source_lang: str = "English") -> str:
    target_name = _TARGET_LANG_NAMES.get(target_lang, target_lang)
    source_name = {
        "en": "English", "zh": "Chinese", "ja": "Japanese", "ko": "Korean",
        "es": "Spanish", "fr": "French", "de": "German", "pt": "Portuguese",
        "ru": "Russian", "it": "Italian",
    }.get(source_lang.lower(), source_lang)
    target_field = _TARGET_LANG_MAP[target_lang]["field"]
    return (
        f"You are a professional {source_name}-to-{target_name} translator for a language learning shadowing app.\n"
        f"The user provides a JSON array of {source_name} sentences. You must return a JSON array with the SAME length and order.\n"
        f'Each item: {{"en": "<original sentence>", "{target_field}": "<natural {target_name} translation>"}}.\n\n'
        "Rules:\n"
        "- Keep sentence order and count EXACTLY matching the input.\n"
        f"- Translations must be natural, fluent {target_name}.\n"
        "- Keep proper nouns, brand names, and untranslatable terms when appropriate.\n"
        "- Output ONLY valid JSON. No explanations, no markdown fences."
    )


def _get_config():
    from services.config import get_setting
    return {
        "api_key": get_setting("DASHSCOPE_API_KEY", ""),
        "base_url": get_setting(
            "DASHSCOPE_COMPATIBLE_URL",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        ),
        "model": get_setting("TRANSLATE_MODEL", "qwen-plus"),
    }


async def translate_sentences(sentences: list[str], target_lang: str = "Chinese", source_lang: str = "English") -> list[dict]:
    """Translate sentences from source_lang to target_lang, returning [{en, <field>}, ...]."""
    if not sentences:
        return []

    target = _TARGET_LANG_MAP.get(target_lang)
    if not target:
        raise ValueError(f"Unsupported target language: {target_lang}. Available: {list(_TARGET_LANG_MAP.keys())}")

    cfg = _get_config()
    if not cfg["api_key"]:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured")

    endpoint = f"{cfg['base_url']}/chat/completions"

    user_payload = json.dumps(sentences, ensure_ascii=False)
    user_prompt = f"Translate this JSON array:\n{user_payload}\nReturn JSON array only."

    system_prompt = _build_system_prompt(target_lang, source_lang=source_lang)
    expected_field = target["field"]

    body = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }

    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }

    logger.info(
        "Translate request: %d sentences, model=%s, %s -> %s (field=%s)",
        len(sentences), cfg["model"], source_lang, target_lang, expected_field,
    )

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(endpoint, headers=headers, json=body)

    if resp.status_code != 200:
        logger.error("Translate failed: %s %s", resp.status_code, resp.text)
        raise RuntimeError(f"Translation failed: {resp.status_code} {resp.text[:300]}")

    result = resp.json()
    content = result["choices"][0]["message"]["content"]
    logger.info("Translate ok, raw_len=%d", len(content))

    return _parse_translation_response(content, sentences, expected_field, target_lang)


def _parse_translation_response(
    content: str,
    original_sentences: list[str],
    expected_field: str = "zh",
    target_lang: str = "Chinese",
) -> list[dict]:
    """Parse model output and gracefully handle markdown fences, dict wrappers, and missing fields."""
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
            return [{"en": s, expected_field: ""} for s in original_sentences]
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            return [{"en": s, expected_field: ""} for s in original_sentences]

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
        return [{"en": s, expected_field: ""} for s in original_sentences]

    candidate_keys = [expected_field, "translation", "text", "target", "t"]
    for v in _TARGET_LANG_MAP.values():
        candidate_keys.append(v["field"])

    out = []
    for i, en in enumerate(original_sentences):
        translated = ""
        if i < len(arr):
            item = arr[i]
            if isinstance(item, dict):
                for k in candidate_keys:
                    val = item.get(k)
                    if isinstance(val, str) and val.strip():
                        translated = val
                        break
                    if isinstance(val, (list, dict)) and val:
                        if isinstance(val, list) and len(val) > 0 and isinstance(val[0], str):
                            translated = val[0]
                            break
                        elif isinstance(val, dict):
                            for sub_v in val.values():
                                if isinstance(sub_v, str) and sub_v.strip():
                                    translated = sub_v
                                    break
                            if translated:
                                break
            elif isinstance(item, str):
                translated = item
        out.append({"en": en, expected_field: translated})

    return out
