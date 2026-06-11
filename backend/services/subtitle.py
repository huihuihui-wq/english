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


def _estimate_speech_duration(text: str, language: str = "en") -> int:
    """Estimate how long it takes to speak this text, in milliseconds."""
    if not text:
        return 0
    if language in ("zh", "ja", "ko"):
        return int(len(text) * 250)
    return int(len(text) * 77)


def _merge_intervals(intervals: list[dict]) -> list[dict]:
    """Merge overlapping or adjacent intervals."""
    if not intervals:
        return []
    sorted_intervals = sorted(intervals, key=lambda x: x["start"])
    merged = [sorted_intervals[0].copy()]
    for current in sorted_intervals[1:]:
        last = merged[-1]
        if current["start"] <= last["end"]:
            last["end"] = max(last["end"], current["end"])
        else:
            merged.append(current.copy())
    return merged


def _subtract_intervals(total: list[dict], to_remove: list[dict]) -> list[dict]:
    """Remove 'to_remove' intervals from 'total' intervals."""
    if not to_remove:
        return [seg.copy() for seg in total]

    result = []
    remove_idx = 0

    for seg in total:
        seg_start = seg["start"]
        seg_end = seg["end"]
        cursor = seg_start

        while remove_idx < len(to_remove) and to_remove[remove_idx]["end"] <= seg_start:
            remove_idx += 1

        while cursor < seg_end and remove_idx < len(to_remove):
            rem = to_remove[remove_idx]
            if rem["start"] >= seg_end:
                break

            if rem["start"] > cursor:
                result.append({"start": cursor, "end": min(rem["start"], seg_end)})

            cursor = max(cursor, rem["end"])
            if rem["end"] <= seg_end:
                remove_idx += 1
            else:
                break

        if cursor < seg_end:
            result.append({"start": cursor, "end": seg_end})

    return result


def build_subtitles_from_speech_segments(
    text: str,
    speech_segments: list[dict],
    non_speech_segments: list[dict],
    language: str = "en",
    placeholder_label: str = "...",
) -> List[dict]:
    """Build subtitle items by mapping sentences to detected speech segments.

    Strategy:
    1. Merge speech segments and subtract known non-speech placeholders.
    2. Estimate total speech duration from text length.
    3. If VAD over-detected speech (e.g. background music), truncate usable time
       and add internal gap placeholders.
    4. Distribute sentences proportionally across all usable windows.
    """
    sentences = _split_text_to_sentences(text, language)
    if not sentences and not speech_segments and not non_speech_segments:
        return []

    items = []
    placeholder_min_ms = 1500

    # Merge all speech segments
    merged_speech = _merge_intervals([{"start": s["start_ms"], "end": s["end_ms"]} for s in speech_segments])

    # Merge non-speech segments
    merged_non_speech = _merge_intervals([{"start": s["start_ms"], "end": s["end_ms"]} for s in non_speech_segments])
    valid_non_speech = [s for s in merged_non_speech if s["end"] - s["start"] >= placeholder_min_ms]

    # Usable windows = speech minus known non-speech
    usable_windows = _subtract_intervals(merged_speech, valid_non_speech)
    total_usable = sum(w["end"] - w["start"] for w in usable_windows)

    total_text = "".join(sentences)
    estimated_ms = _estimate_speech_duration(total_text, language)

    logger.info("Speech build: %d windows, usable=%dms, text_est=%dms",
                len(usable_windows), total_usable, estimated_ms)

    # Detect internal gaps: if usable time is much longer than estimated speech
    SPEECH_RATIO_THRESHOLD = 0.55
    MAX_STRETCH = 1.25

    if estimated_ms > 0 and total_usable > 0 and estimated_ms < total_usable * SPEECH_RATIO_THRESHOLD:
        target_usable = min(int(estimated_ms * MAX_STRETCH), total_usable)
        has_gaps = True
        logger.info("Truncating: %dms -> %dms (gap=%dms)", total_usable, target_usable, total_usable - target_usable)
    else:
        target_usable = total_usable
        has_gaps = False

    # Add placeholders for VAD-detected non-speech
    for ns in valid_non_speech:
        items.append({
            "start": ns["start"],
            "end": ns["end"],
            "en": placeholder_label,
            "dur": ns["end"] - ns["start"],
            "is_placeholder": True,
        })

    # Distribute sentences across usable windows
    if sentences and usable_windows and target_usable > 0:
        seg_text_chars = max(1, sum(len(s) for s in sentences))
        total_allocated = 0
        sent_idx = 0

        for window in usable_windows:
            window_dur = window["end"] - window["start"]
            # How much of target_usable does this window get?
            window_share = target_usable * (window_dur / total_usable) if total_usable > 0 else 0
            window_limit = window["start"] + min(window_share, window_dur)
            cursor = window["start"]

            while sent_idx < len(sentences) and cursor < window_limit:
                s = sentences[sent_idx]
                s_dur = target_usable * (len(s) / seg_text_chars)
                s_dur = max(s_dur, 800)
                s_end = min(int(cursor + s_dur), int(window_limit))

                if s_end <= cursor:
                    break

                items.append({
                    "start": int(cursor),
                    "end": s_end,
                    "en": s,
                    "dur": s_end - int(cursor),
                })
                total_allocated += (s_end - cursor)
                cursor = s_end
                sent_idx += 1

        # Add placeholder for unused usable time
        if has_gaps and total_allocated < target_usable:
            last_window = usable_windows[-1]
            unused_start = last_window["start"] + min(target_usable * (last_window["end"] - last_window["start"]) / total_usable, last_window["end"] - last_window["start"])
            unused_start = int(unused_start)
            if unused_start < last_window["end"]:
                gap_dur = last_window["end"] - unused_start
                if gap_dur >= placeholder_min_ms:
                    items.append({
                        "start": unused_start,
                        "end": last_window["end"],
                        "en": placeholder_label,
                        "dur": gap_dur,
                        "is_placeholder": True,
                    })

    items.sort(key=lambda x: x["start"])

    # Merge consecutive placeholders
    merged_items = []
    for it in items:
        if it.get("is_placeholder") and merged_items and merged_items[-1].get("is_placeholder"):
            merged_items[-1]["end"] = it["end"]
            merged_items[-1]["dur"] = it["end"] - merged_items[-1]["start"]
        else:
            merged_items.append(it)

    logger.info("VAD-based split: %d items (%s)", len(merged_items), language)
    return merged_items
