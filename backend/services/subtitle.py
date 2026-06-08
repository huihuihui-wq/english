"""字幕切句 - 基于词级时间戳按标点组合成句子"""
import re
import logging
from typing import List

logger = logging.getLogger(__name__)

SENTENCE_END_PUNCT = ".!?,;:"
ABBREVIATIONS = {"Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "St.", "vs.", "etc.", "e.g.", "i.e."}


def split_sentences_with_timestamps(words: list, text: str) -> List[dict]:
    """
    将带时间戳的 words[] 数组按标点切分为句子。
    句子的 start = 首个词的 begin_time
    句子的 end = 末个词的 end_time

    返回 [{start, end, en, dur}, ...]，时间单位毫秒。
    """
    if not words:
        return _fallback_proportional(text)

    protected = text or ""
    for abbr in ABBREVIATIONS:
        protected = protected.replace(abbr, abbr.replace(".", "<DOT>"))

    end_positions = []
    for m in re.finditer(r"[.!?]+|\.{3,}", protected):
        end_positions.append(m.end())

    if not end_positions:
        full_text = "".join(w["text"] for w in words)
        total_chars = sum(len(w["text"]) for w in words) or 1
        total_dur = max((w["end_time"] for w in words), default=0)
        return [{
            "start": words[0]["begin_time"],
            "end": words[-1]["end_time"],
            "en": full_text,
            "dur": words[-1]["end_time"] - words[0]["begin_time"],
        }]

    char_to_word_idx = []
    cursor = 0
    for i, w in enumerate(words):
        word_text = w["text"]
        for _ in word_text:
            if cursor < len(protected):
                char_to_word_idx.append(i)
                cursor += 1

    sentences = []
    last_word_idx = 0
    text_cursor = 0

    for end_pos in end_positions:
        if end_pos > len(char_to_word_idx):
            target_word_idx = len(words) - 1
        else:
            target_word_idx = char_to_word_idx[end_pos - 1]

        sent_words = words[last_word_idx: target_word_idx + 1]
        if sent_words:
            sent_text = "".join(w["text"] for w in sent_words)
            sentences.append({
                "start": sent_words[0]["begin_time"],
                "end": sent_words[-1]["end_time"],
                "en": sent_text,
            })
        last_word_idx = target_word_idx + 1

    if last_word_idx < len(words):
        sent_words = words[last_word_idx:]
        if sent_words:
            sentences.append({
                "start": sent_words[0]["begin_time"],
                "end": sent_words[-1]["end_time"],
                "en": "".join(w["text"] for w in sent_words),
            })

    for s in sentences:
        s["dur"] = s["end"] - s["start"]

    if not sentences:
        return _fallback_proportional(text)

    logger.info(f"切分: {len(words)} words → {len(sentences)} sentences")
    return sentences


def _fallback_proportional(text: str, total_ms: int = 0) -> List[dict]:
    """无词级时间戳时回退到比例分配"""
    if not text or not text.strip():
        return []
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    sentences = [p.strip().replace("<DOT>", ".") for p in parts if p.strip()]
    if not sentences:
        return []
    weights = [max(1, len(s)) for s in sentences]
    total_w = sum(weights)
    cursor = 0
    result = []
    for s, w in zip(sentences, weights):
        dur = total_ms * (w / total_w)
        result.append({
            "start": cursor,
            "end": cursor + dur,
            "en": s,
            "dur": dur,
        })
        cursor += dur
    return result
