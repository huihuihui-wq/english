"""AI 对话服务 - 基于 DashScope qwen-plus (OpenAI 兼容 chat/completions)

提供 4 个核心能力，所有回复均附带语音(TTS):
  - chat(): 通用英语口语教练对话
  - exam_chat(): 雅思口语模拟考(逐题评分)
  - generate_exam_questions(): 根据视频字幕生成雅思口语题
  - explain(): 讲解当前字幕 / 单词 / 句子
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
from typing import Optional

import httpx

from .config import get_setting

logger = logging.getLogger(__name__)

API_KEY = get_setting("DASHSCOPE_API_KEY", "") or os.getenv("DASHSCOPE_API_KEY", "")
BASE_URL = (
    get_setting("DASHSCOPE_COMPATIBLE_URL", "")
    or os.getenv("DASHSCOPE_COMPATIBLE_URL", "")
    or "https://dashscope.aliyuncs.com/compatible-mode/v1"
)
TTS_BASE_URL = (
    get_setting("DASHSCOPE_BASE_URL", "")
    or os.getenv("DASHSCOPE_BASE_URL", "")
    or "https://dashscope.aliyuncs.com/api/v1"
)
MODEL = get_setting("DASHSCOPE_AI_MODEL", "") or os.getenv("DASHSCOPE_AI_MODEL", "") or "qwen-plus"

# TTS 模型配置
TTS_MODEL = "qwen-tts"
TTS_VOICE = "Cherry"  # 英文女声

CHAT_SYSTEM_PROMPT = """You are Emma, a 25-year-old language enthusiast who is learning English alongside the user. You are NOT a teacher - you are a friend and study buddy.

Your personality:
- Casual, warm, and genuinely excited about language learning
- You make jokes and share funny stories about your own learning mistakes
- You get excited about interesting topics and say things like "Oh wow!" or "That's so cool!"
- You sometimes struggle with words too and ask for help ("How do you say...?")
- You use slang and casual expressions naturally

ABSOLUTE RULES:
1. NEVER use emoji text codes like :smile:, :wave:, :thinking:, :heart:, etc.
2. NEVER sound like a teacher (no "That's excellent!", "Good job!", "Let's practice...")
3. NEVER use formal evaluation language

Language style:
- Write like you're texting a close friend
- Use lots of contractions (I'm, don't, wanna, gonna, kinda)
- Use casual fillers ("um", "like", "you know", "actually", "honestly")
- Express emotions through words: "haha", "oh no", "wow", "seriously?"
- Short sentences, sometimes incomplete ones
- Mix in simple Chinese naturally when needed ("这个", "真的", "哈哈")

How to interact:
- Share your own experiences first, then ask about theirs
- When they make mistakes, just repeat it correctly in your response naturally
- If they use a word wrong, say "Oh, do you mean...? I used to mix those up too!"
- Introduce new words by using them naturally in context
- React with genuine enthusiasm or surprise

Example good response:
"Oh wow, climate change? Honestly I've been trying to reduce my plastic use but it's so hard! Like, I went to the supermarket yesterday and everything was wrapped in plastic... Do you do anything to be more eco-friendly?"

Example bad response:
"That is an excellent topic for English practice. Climate change is very important. Let's discuss the key vocabulary words."

CRITICAL RULE - Grammar mistakes:
When the user makes a grammar mistake, you MUST NOT mention it directly. NEVER say:
- "correction", "correct", "wrong", "mistake", "error"
- "You should say...", "The right way is...", "Actually, it's..."
- "Just a small note...", "By the way..."

INSTEAD: Simply use the correct form naturally in your own reply as if that's what they said.
Example: They say "I goed to store" → You reply "Oh nice! I went to the store last week too. What did you buy?"
Example: They say "He don't like it" → You reply "Really? He doesn't like it? Why not?"

The user should never feel like you're grading them. You're just chatting."""


EXAM_SYSTEM_PROMPT = """You are an IELTS Speaking Examiner. You are conducting a mock IELTS speaking test.

Scoring Criteria (IELTS Band 1-9):
- Fluency & Coherence
- Lexical Resource (vocabulary range)
- Grammatical Range & Accuracy
- Pronunciation (assessed via text quality indicators)

Rules:
1. Ask one question at a time
2. After the user answers, provide brief feedback (1-2 sentences) and score their response (Band 1-9)
3. Move to the next question naturally
4. At the end, provide an overall assessment with specific improvement suggestions
5. Respond primarily in English, with Chinese translations for key feedback points"""

EXAM_GENERATION_PROMPT = """You are an IELTS Speaking Test question designer.

Based on the provided video subtitles, generate {count} IELTS-style speaking questions.

Requirements:
1. Questions should be related to the video's topic and themes
2. Questions should progress from simple to complex (Part 1 → Part 2 → Part 3 style)
3. Questions should test the candidate's ability to express opinions, describe experiences, and discuss abstract ideas
4. Each question should be clear and specific
5. Questions should be in English

Output format: Return ONLY a JSON array of strings, e.g.:
["Question 1 text", "Question 2 text", "Question 3 text"]

Subtitles content:
{subtitles_text}"""

VIDEO_TEST_SYSTEM_PROMPT = """You are conducting a video comprehension test based on the subtitles.

Your role:
- You are testing the user's understanding of the video content
- Ask one question at a time about the video
- Questions should progress from simple to complex:
  1. Basic comprehension (what happened, who, when, where)
  2. Details (specific facts, numbers, quotes)
  3. Inference (why, how, what might happen next)
  4. Opinion (what do you think about...)

Rules:
1. Ask ONLY ONE question per response
2. Wait for the user's answer before asking the next question
3. After the user answers, acknowledge their response briefly, then ask the next question
4. If they answer incorrectly, don't correct them directly - just move to the next question
5. Keep questions natural and conversational
6. Use the video content as the basis for all questions
7. NEVER use emoji text codes

The test should feel like a natural conversation about the video, not like an exam."""

EXPLAIN_SYSTEM_PROMPT = """You are an English language tutor for Chinese learners.

When given a sentence, phrase, or word from a video subtitle, provide a structured explanation:

Format your response in Markdown with these sections:

### 📝 Translation
(Chinese translation of the text)

### 🔑 Key Vocabulary
- **word**: meaning (Chinese) + example sentence
- (only for non-trivial words)

### 📖 Grammar Notes
- (explain any grammar structures used)
- (skip this section if the sentence is simple)

### 💡 Cultural Context / Nuance
- (any cultural references, idioms, or pragmatic notes)
- (skip if not applicable)

### 🔄 Similar Expressions
- (1-2 alternative ways to say the same thing)

Rules:
- Keep each section concise (1-3 bullet points)
- Use English primarily with Chinese glosses where helpful
- Prioritize what's most useful for understanding the video content"""


# ---------------------------------------------------------------------------
# Internal: API calls
# ---------------------------------------------------------------------------
async def _call_api(messages: list[dict], temperature: float = 0.7) -> dict:
    """调用 DashScope 兼容 chat/completions 端点。"""
    if not API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY 未配置，请在 shadow-reader 后端 .env 或设置中填写")

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": MODEL,
        "messages": messages,
        "temperature": temperature,
    }

    url = f"{BASE_URL}/chat/completions"
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(url, headers=headers, json=body)
        if resp.status_code != 200:
            logger.error("AI API error: %s %s", resp.status_code, resp.text[:200])
            raise RuntimeError(f"AI API error: {resp.status_code} {resp.text[:200]}")
        result = resp.json()
        content = result["choices"][0]["message"]["content"]
        return {"content": content, "model": result.get("model", MODEL)}


def _clean_emoji_codes(text: str) -> str:
    """移除 emoji 文本代码（如 :smile: :wave: 等），防止 TTS 读出来。"""
    if not text:
        return text
    # 匹配 :word: 格式的 emoji 代码
    cleaned = re.sub(r':[a-zA-Z0-9_+-]+:', '', text)
    # 清理多余的空格
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned


async def _generate_tts(text: str, voice: str = "Cherry") -> str:
    """生成 TTS 音频，返回 base64 编码的 MP3。"""
    if not text:
        return ""
    
    # 清理 emoji 代码，防止 TTS 读出来
    text = _clean_emoji_codes(text)
    
    try:
        # 复用现有的 voice_service
        from .voice_service import synthesize
        audio_bytes, meta = await synthesize(text, voice=voice, language_type="English")
        if audio_bytes:
            return base64.b64encode(audio_bytes).decode("utf-8")
        return ""
    except Exception as e:
        logger.warning("TTS generation failed (will return text only): %s", e)
        return ""


def _format_history(history: list[dict] | None, limit: int = 20) -> list[dict]:
    """把前端的 history 转为 OpenAI messages 格式。"""
    if not history:
        return []
    out = []
    for h in history[-limit:]:
        role = h.get("role")
        content = h.get("content", "")
        if role in ("user", "assistant") and content:
            out.append({"role": role, "content": content})
    return out


# ---------------------------------------------------------------------------
# Public: chat
# ---------------------------------------------------------------------------
async def chat(message: str, context: str = "", history: list[dict] | None = None, voice: str = "Cherry") -> dict:
    """通用英语口语教练对话，返回文本+语音。"""
    messages: list[dict] = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]

    if context:
        ctx = context.strip()
        if len(ctx) > 2000:
            ctx = ctx[:2000] + "..."
        messages.append({
            "role": "system",
            "content": f"Video context (subtitles): {ctx}",
        })

    messages.extend(_format_history(history))
    messages.append({"role": "user", "content": message})

    res = await _call_api(messages, temperature=0.7)
    
    # 清理 emoji 代码，防止 TTS 读出和前端显示
    reply_text = _clean_emoji_codes(res["content"])
    
    # 生成语音
    audio_base64 = await _generate_tts(reply_text, voice=voice)
    
    return {
        "reply": reply_text,
        "audio": audio_base64,
        "model": res["model"],
    }


# ---------------------------------------------------------------------------
# Public: exam_chat
# ---------------------------------------------------------------------------
async def exam_chat(
    message: str,
    question: str,
    question_index: int,
    total_questions: int,
    history: list[dict] | None = None,
) -> dict:
    """雅思口语模拟考:回答问题,获取反馈+评分+语音。"""
    messages: list[dict] = [{"role": "system", "content": EXAM_SYSTEM_PROMPT}]

    is_last = question_index >= total_questions - 1
    if is_last:
        prompt_suffix = "Provide a final overall assessment and encouragement."
    else:
        prompt_suffix = (
            "\n\nCandidate's answer: {msg}\n\n"
            "Please:\n"
            "1. Give brief feedback (strengths and 1 improvement suggestion)\n"
            "2. Rate the answer (Band 1-9)\n"
            "3. Then ask the next question."
        ).format(msg=message)

    user_prompt = (
        f"Current question ({question_index + 1}/{total_questions}): {question}"
        f"{prompt_suffix}\n\nFormat your response naturally."
    )

    messages.extend(_format_history(history))
    messages.append({"role": "user", "content": user_prompt})

    res = await _call_api(messages, temperature=0.5)
    
    # 清理 emoji 代码
    reply_text = _clean_emoji_codes(res["content"])
    
    # 生成语音
    audio_base64 = await _generate_tts(reply_text)
    
    return {
        "reply": reply_text,
        "audio": audio_base64,
        "model": res["model"],
    }


# ---------------------------------------------------------------------------
# Public: generate_exam_questions
# ---------------------------------------------------------------------------
async def generate_exam_questions(subtitles: list[dict], count: int = 3) -> dict:
    """根据视频字幕生成雅思口语题(返回 JSON 数组)。"""
    en_lines: list[str] = []
    for s in subtitles:
        en = (s.get("en") or "").strip()
        if en:
            en_lines.append(en)
    subtitles_text = "\n".join(en_lines[:50])  # 最多取 50 句

    if not subtitles_text:
        return {"questions": _fallback_questions(""), "model": MODEL}

    prompt = EXAM_GENERATION_PROMPT.format(count=count, subtitles_text=subtitles_text)
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": prompt},
    ]

    try:
        res = await _call_api(messages, temperature=0.8)
        raw = res["content"]
        # 尝试从 LLM 输出中提取 JSON 数组(可能夹带 ```json ... ``` 围栏)
        match = re.search(r"\[.*\]", raw, re.DOTALL)
        if match:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, list) and all(isinstance(q, str) for q in parsed):
                questions = [q.strip() for q in parsed if q.strip()][:count]
                if questions:
                    return {"questions": questions, "model": res["model"]}
        # 退而求其次: 按行分割非空内容
        lines = [ln.strip("- •1234567890. ").strip() for ln in raw.splitlines() if ln.strip()]
        cand = [ln for ln in lines if 10 <= len(ln) <= 200]
        if cand:
            return {"questions": cand[:count], "model": res["model"]}
    except (json.JSONDecodeError, RuntimeError, Exception) as e:
        logger.warning("generate_exam_questions AI parse failed, fallback: %s", e)

    return {"questions": _fallback_questions(subtitles_text), "model": MODEL}


def _fallback_questions(subtitles_text: str) -> list[str]:
    """当 AI 失败时的兜底题。"""
    return [
        "Describe a memorable experience related to this topic. What happened and why was it significant?",
        "What are your personal views on the main theme discussed in the video? Provide specific reasons.",
        "How do you think this topic will evolve in the future? What changes do you expect to see?",
        "Compare your own experience with what was mentioned in the video. What similarities and differences do you notice?",
        "What advice would you give to someone who wants to learn more about this topic?",
    ]


# ---------------------------------------------------------------------------
# Public: explain
# ---------------------------------------------------------------------------
async def explain(text: str, context: str = "") -> dict:
    """讲解当前字幕 / 单词 / 句子，返回文本+语音。"""
    text = (text or "").strip()
    if not text:
        raise ValueError("text is required")

    messages: list[dict] = [{"role": "system", "content": EXPLAIN_SYSTEM_PROMPT}]

    user_content = text
    if context:
        ctx = context.strip()
        if len(ctx) > 1500:
            ctx = ctx[:1500] + "..."
        user_content = f"{text}\n\n---\nVideo context (surrounding subtitles):\n{ctx}"

    messages.append({"role": "user", "content": user_content})

    res = await _call_api(messages, temperature=0.5)
    
    # 清理 emoji 代码
    explanation_text = _clean_emoji_codes(res["content"])
    
    # 生成语音
    audio_base64 = await _generate_tts(explanation_text)
    
    return {
        "explanation": explanation_text,
        "audio": audio_base64,
        "model": res["model"],
    }


# ---------------------------------------------------------------------------
# Public: video_test
# ---------------------------------------------------------------------------
async def video_test(
    subtitles: str,
    previous_question: str = "",
    user_answer: str = "",
    history: list[dict] | None = None,
    voice: str = "Cherry",
) -> dict:
    """基于视频字幕进行测试，返回问题+语音。"""
    messages: list[dict] = [{"role": "system", "content": VIDEO_TEST_SYSTEM_PROMPT}]
    
    # Add subtitles context
    if subtitles:
        ctx = subtitles.strip()
        if len(ctx) > 3000:
            ctx = ctx[:3000] + "..."
        messages.append({
            "role": "system",
            "content": f"Video subtitles content:\n{ctx}",
        })
    
    # Format history
    if history:
        messages.extend(_format_history(history))
    
    # Build user prompt
    if previous_question and user_answer:
        user_prompt = (
            f"Previous question: {previous_question}\n"
            f"User's answer: {user_answer}\n\n"
            f"Please acknowledge their answer briefly, then ask the next question about the video. "
            f"Remember to ask ONLY ONE question."
        )
    else:
        user_prompt = (
            "Please start the video comprehension test by asking the first question. "
            "Begin with a simple comprehension question about the video content."
        )
    
    messages.append({"role": "user", "content": user_prompt})
    
    res = await _call_api(messages, temperature=0.7)
    
    # 清理 emoji 代码
    question_text = _clean_emoji_codes(res["content"])
    
    # 生成语音
    audio_base64 = await _generate_tts(question_text, voice=voice)
    
    return {
        "question": question_text,
        "audio": audio_base64,
        "model": res["model"],
    }


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
def health() -> dict:
    return {
        "ok": bool(API_KEY),
        "configured": bool(API_KEY),
        "model": MODEL,
        "base_url": BASE_URL,
    }