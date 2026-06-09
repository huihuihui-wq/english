"""AI 对话服务 - 基于 qwen-plus (DashScope)"""
import os
import json
import logging
import httpx
from typing import Optional

logger = logging.getLogger(__name__)

API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
MODEL = "qwen-plus"

# ========== 系统提示词 ==========
CHAT_SYSTEM_PROMPT = """You are an English speaking coach for Chinese learners. 
Your goal is to help users practice English conversation naturally.

Rules:
1. Respond in English primarily, but you may use simple Chinese explanations when necessary
2. Be encouraging and patient
3. Correct grammar mistakes gently
4. Keep responses concise (2-4 sentences for chat, longer for feedback)
5. Adapt your language level to the user's proficiency
6. When given video context, reference the content naturally in conversation

Current context: The user has been practicing shadow reading with an English video."""

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


def _call_api(messages: list, temperature: float = 0.7) -> str:
    """调用 DashScope qwen-plus"""
    if not API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY 未配置")

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }

    body = {
        "model": MODEL,
        "messages": messages,
        "temperature": temperature,
    }

    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(
                f"{BASE_URL}/chat/completions",
                headers=headers,
                json=body,
            )

        if resp.status_code != 200:
            logger.error(f"AI API error: {resp.status_code} {resp.text[:500]}")
            raise RuntimeError(f"AI API error: {resp.status_code}")

        result = resp.json()
        return result["choices"][0]["message"]["content"].strip()

    except Exception as e:
        logger.exception("AI API call failed")
        raise RuntimeError(f"AI服务调用失败: {str(e)}")


async def chat(message: str, context: Optional[str] = None, history: Optional[list] = None) -> str:
    """自由对话"""
    messages = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]

    if context:
        messages.append({
            "role": "system",
            "content": f"Video context (subtitles): {context[:2000]}"
        })

    if history:
        messages.extend(history)

    messages.append({"role": "user", "content": message})

    return _call_api(messages, temperature=0.7)


async def exam_chat(
    message: str,
    question: str,
    question_index: int,
    total_questions: int,
    history: Optional[list] = None,
) -> dict:
    """雅思模考对话"""
    messages = [{"role": "system", "content": EXAM_SYSTEM_PROMPT}]

    if history:
        messages.extend(history)

    # 构建提示
    prompt = f"""Current question ({question_index + 1}/{total_questions}): {question}

Candidate's answer: {message}

Please:
1. Give brief feedback (strengths and 1 improvement suggestion)
2. Rate the answer (Band 1-9)
3. {'Then ask the next question.' if question_index < total_questions - 1 else 'Provide a final overall assessment and encouragement.'}

Format your response naturally."""

    messages.append({"role": "user", "content": prompt})

    response = _call_api(messages, temperature=0.5)

    result = {"reply": response}

    # 判断是否有下一题
    if question_index < total_questions - 1:
        result["nextQuestion"] = True
    else:
        result["feedback"] = response

    return result


async def generate_exam_questions(subtitles: list, count: int = 3) -> list:
    """基于字幕生成雅思口语试题"""
    # 提取字幕文本
    subtitles_text = "\n".join([
        f"[{s.get('start', 0):.1f}s] {s.get('en', '')}"
        for s in subtitles[:50]  # 限制长度
    ])

    prompt = EXAM_GENERATION_PROMPT.format(
        count=count,
        subtitles_text=subtitles_text[:3000]
    )

    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": prompt}
    ]

    response = _call_api(messages, temperature=0.8)

    # 解析 JSON
    try:
        # 尝试直接解析
        questions = json.loads(response)
    except json.JSONDecodeError:
        # 尝试提取 JSON 部分
        import re
        match = re.search(r'\[.*\]', response, re.DOTALL)
        if match:
            try:
                questions = json.loads(match.group(0))
            except json.JSONDecodeError:
                questions = _fallback_questions(subtitles_text, count)
        else:
            questions = _fallback_questions(subtitles_text, count)

    # 确保是列表
    if not isinstance(questions, list):
        questions = _fallback_questions(subtitles_text, count)

    # 限制数量
    questions = questions[:count]

    return questions


def _fallback_questions(subtitles_text: str, count: int) -> list:
    """后备题目生成"""
    default_questions = [
        "Describe a memorable experience related to this topic. What happened and why was it significant?",
        "What are your personal views on the main theme discussed in the video? Provide specific reasons.",
        "How do you think this topic will evolve in the future? What changes do you expect to see?",
        "Compare your own experience with what was mentioned in the video. What similarities and differences do you notice?",
        "What advice would you give to someone who wants to learn more about this topic?",
    ]
    return default_questions[:count]
