"""Sentence splitting from word-level ASR timestamps."""
import re
import logging
from typing import List

logger = logging.getLogger(__name__)

ABBREVIATIONS = {"Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "St.", "vs.", "etc.", "e.g.", "i.e."}

# Language groups that commonly use full-width sentence terminators
_CJK_LANGS = {"zh", "ja"}


def _sentence_end_pattern(language: str) -> str:
    if language in _CJK_LANGS:
        # Include both full-width CJK terminators and western ones as fallback
        return r"[。！？.!?]+|\.\.\.+|…+"
    return r"[.!?]+|\.\.\.+"


def _fallback_split_pattern(language: str) -> str:
    if language in _CJK_LANGS:
        return r"(?<=[。！？.!?])\s*"
    return r"(?<=[.!?])\s+"


def split_sentences_with_timestamps(words: list, text: str, language: str = "en") -> List[dict]:
    """Split timestamped words into sentences based on punctuation.

    Returns [{start, end, en, dur}, ...] in milliseconds.
    """
    if not words:
        return _fallback_proportional(text, language=language)

    protected = text or ""
    for abbr in ABBREVIATIONS:
        protected = protected.replace(abbr, abbr.replace(".", "<DOT>"))

    end_pattern = _sentence_end_pattern(language)
    end_positions = []
    for m in re.finditer(end_pattern, protected):
        end_positions.append(m.end())

    if not end_positions:
        full_text = "".join(w["text"] for w in words)
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
        return _fallback_proportional(text, language=language)

    logger.info("Split: %d words -> %d sentences (%s)", len(words), len(sentences), language)
    return sentences


def _fallback_proportional(text: str, total_ms: int = 0, language: str = "en") -> List[dict]:
    """Fallback proportional allocation when no word timestamps are available."""
    if not text or not text.strip():
        return []
    split_pat = _fallback_split_pattern(language)
    parts = re.split(split_pat, text.strip())
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


def _split_text_to_sentences(text: str, language: str = "en") -> List[str]:
    """Split text into sentences using language-aware punctuation."""
    if not text or not text.strip():
        return []
    split_pat = _fallback_split_pattern(language)
    parts = re.split(split_pat, text.strip())
    return [p.strip().replace("<DOT>", ".") for p in parts if p.strip()]


def _find_best_segment_for_sentence(sentence: str, speech_segments: list[dict], used_chars: list[int]) -> int:
    """Find the speech segment that best fits this sentence.

    Prefers segments with fewer allocated sentences and similar duration/char ratio.
    """
    if not speech_segments:
        return -1

    best_idx = 0
    best_score = -1

    for i, seg in enumerate(speech_segments):
        seg_dur = seg["end_ms"] - seg["start_ms"]
        if seg_dur <= 0:
            continue

        # Prefer segments with less allocated content
        usage_ratio = used_chars[i] / max(1, seg_dur)
        score = 1.0 / (usage_ratio + 0.1)

        if score > best_score:
            best_score = score
            best_idx = i

    return best_idx


def build_subtitles_from_speech_segments(
    text: str,
    speech_segments: list[dict],
    non_speech_segments: list[dict],
    language: str = "en",
    placeholder_label: str = "...",
) -> List[dict]:
    """Build subtitle items by mapping sentences to detected speech segments.

    Non-speech segments longer than the threshold become placeholder subtitles.
    Returns [{start, end, en, dur, is_placeholder?}, ...] in milliseconds.
    """
    sentences = _split_text_to_sentences(text, language)
    if not sentences and not speech_segments and not non_speech_segments:
        return []

    items = []
    placeholder_min_ms = 2000  # Increased from 1500 to avoid fragmenting on short pauses

    # Strategy: assign whole sentences to the best-fitting speech segment
    # Track how much text we've assigned to each segment
    used_chars = [0] * len(speech_segments)
    segment_sentences = [[] for _ in speech_segments]

    for sentence in sentences:
        seg_idx = _find_best_segment_for_sentence(sentence, speech_segments, used_chars)
        if seg_idx >= 0:
            segment_sentences[seg_idx].append(sentence)
            used_chars[seg_idx] += len(sentence)
        else:
            # No speech segments, append to last or create new
            if segment_sentences:
                segment_sentences[-1].append(sentence)
                used_chars[-1] += len(sentence)

    # Build subtitle items from each segment's assigned sentences
    for i, seg in enumerate(speech_segments):
        seg_sentences = segment_sentences[i]
        if not seg_sentences:
            continue

        seg_dur = seg["end_ms"] - seg["start_ms"]
        seg_text_chars = max(1, sum(len(s) for s in seg_sentences))
        cursor = seg["start_ms"]

        for s in seg_sentences:
            # Distribute time proportionally by character count within this segment
            s_dur = seg_dur * (len(s) / seg_text_chars)
            s_dur = max(s_dur, 1000)  # Minimum 1 second per sentence
            items.append({
                "start": int(cursor),
                "end": int(min(cursor + s_dur, seg["end_ms"])),
                "en": s,
                "dur": int(s_dur),
            })
            cursor += s_dur

    # Handle any leftover sentences that weren't assigned
    unassigned = []
    for seg_list in segment_sentences[len(speech_segments):]:
        unassigned.extend(seg_list)

    for sentence in unassigned:
        if items:
            last_end = items[-1]["end"]
            items.append({
                "start": last_end,
                "end": last_end + 2000,
                "en": sentence,
                "dur": 2000,
            })
        else:
            items.append({
                "start": 0,
                "end": 2000,
                "en": sentence,
                "dur": 2000,
            })

    # Placeholder entries for music / long silence.
    for ns in non_speech_segments:
        ns_dur = ns["end_ms"] - ns["start_ms"]
        if ns_dur >= placeholder_min_ms:
            items.append({
                "start": ns["start_ms"],
                "end": ns["end_ms"],
                "en": placeholder_label,
                "dur": ns_dur,
                "is_placeholder": True,
            })

    items.sort(key=lambda x: x["start"])
    logger.info("VAD-based split: %d speech segs, %d non-speech segs -> %d items (%s)",
                len(speech_segments), len(non_speech_segments), len(items), language)
    return items
