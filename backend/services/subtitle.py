"""Sentence splitting from ASR timestamps and VAD/classified segments."""
import logging
import re
from typing import List

logger = logging.getLogger(__name__)

ABBREVIATIONS = {"Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "St.", "vs.", "etc.", "e.g.", "i.e."}

_CJK_LANGS = {"zh", "ja"}

PLACEHOLDER_LABELS = {
    "music": "🎵 music",
    "applause": "👏 applause",
    "silence": "🤐 silence",
    "noise": "🤐 silence",
}


def _sentence_end_pattern(language: str) -> str:
    if language in _CJK_LANGS:
        return r"[。！？.!?]+|\.\.+|…+"
    return r"[.!?]+|\.\.+"


def _fallback_split_pattern(language: str) -> str:
    if language in _CJK_LANGS:
        return r"(?<=[。！？.!?])\s*"
    return r"(?<=[.!?])\s+"


def _normalize_word_for_match(word: str) -> str:
    """Normalize a word for case/punctuation-insensitive matching."""
    return re.sub(r"[^a-z0-9']+", "", word.lower()).strip()


def split_sentences_with_timestamps(words: list, text: str, language: str = "en") -> List[dict]:
    """Split timestamped words into sentences based on ASR punctuation.

    Allocates aligned words to sentences proportionally by each sentence's word
    count. This is robust to wav2vec2 tokenization quirks (missing spaces,
    misrecognized spellings, stripped punctuation).
    """
    if not words:
        return _fallback_proportional(text, language=language)

    protected = text or ""
    for abbr in ABBREVIATIONS:
        protected = protected.replace(abbr, abbr.replace(".", "<DOT>"))

    end_pattern = _sentence_end_pattern(language)
    sentence_texts = []
    cursor = 0
    for m in re.finditer(end_pattern, protected):
        sentence_texts.append(protected[cursor:m.end()].strip().replace("<DOT>", "."))
        cursor = m.end()
    if cursor < len(protected):
        tail = protected[cursor:].strip().replace("<DOT>", ".")
        if tail:
            sentence_texts.append(tail)

    if not sentence_texts:
        sentence_texts = [protected.strip().replace("<DOT>", ".")]

    sentence_texts = [s for s in sentence_texts if s.strip()]
    if not sentence_texts:
        return [{
            "start": words[0]["begin_time"],
            "end": words[-1]["end_time"],
            "en": text or "".join(w.get("text", "") for w in words),
            "dur": words[-1]["end_time"] - words[0]["begin_time"],
        }]

    # Allocate words proportionally by sentence word count
    sentence_word_counts = [
        len(re.findall(r"[A-Za-z0-9]+(?:['\-][A-Za-z0-9]+)*", s))
        for s in sentence_texts
    ]
    total_sent_words = max(1, sum(sentence_word_counts))
    total_words = len(words)

    sentences = []
    word_start = 0
    for idx, s in enumerate(sentence_texts):
        ratio = sentence_word_counts[idx] / total_sent_words
        num_words = max(1, round(ratio * total_words))
        # Ensure we don't run out of words before the last sentence
        if idx == len(sentence_texts) - 1:
            num_words = total_words - word_start
        else:
            num_words = min(num_words, total_words - word_start)
        if num_words <= 0:
            break
        sent_words = words[word_start:word_start + num_words]
        sentences.append({
            "start": sent_words[0]["begin_time"],
            "end": sent_words[-1]["end_time"],
            "en": s,
            "dur": sent_words[-1]["end_time"] - sent_words[0]["begin_time"],
        })
        word_start += num_words

    if not sentences:
        return [{
            "start": words[0]["begin_time"],
            "end": words[-1]["end_time"],
            "en": text or "".join(w.get("text", "") for w in words),
            "dur": words[-1]["end_time"] - words[0]["begin_time"],
        }]

    logger.info("Split: %d words -> %d sentences (%s)", len(words), len(sentences), language)
    return sentences


def _fallback_proportional(
    text: str,
    total_ms: int = 0,
    language: str = "en",
    non_speech_segments: List[dict] = None,
) -> List[dict]:
    """Fallback proportional allocation when no word timestamps are available."""
    if not text or not text.strip():
        # Even without text, emit placeholders for non-speech segments
        items = []
        if non_speech_segments:
            for ns in sorted(non_speech_segments, key=lambda x: x["start_ms"]):
                dur = ns["end_ms"] - ns["start_ms"]
                if dur >= 1000:
                    label = ns.get("label", "silence")
                    items.append({
                        "start": ns["start_ms"],
                        "end": ns["end_ms"],
                        "en": PLACEHOLDER_LABELS.get(label, PLACEHOLDER_LABELS["silence"]),
                        "dur": dur,
                        "is_placeholder": True,
                        "placeholder_type": label,
                    })
        return items

    split_pat = _fallback_split_pattern(language)
    parts = re.split(split_pat, text.strip())
    sentences = [p.strip().replace("<DOT>", ".") for p in parts if p.strip()]
    if not sentences:
        return []

    # Build usable windows by subtracting non-speech from total duration
    usable_windows = _subtract_intervals(
        [{"start": 0, "end": total_ms}],
        [{"start": ns["start_ms"], "end": ns["end_ms"]} for ns in (non_speech_segments or [])],
    )
    total_usable = sum(w["end"] - w["start"] for w in usable_windows)
    if total_usable <= 0:
        total_usable = total_ms
        usable_windows = [{"start": 0, "end": total_ms}]

    weights = [max(1, len(s)) for s in sentences]
    total_w = sum(weights)

    items = []

    # First add placeholders for non-speech segments
    if non_speech_segments:
        for ns in sorted(non_speech_segments, key=lambda x: x["start_ms"]):
            dur = ns["end_ms"] - ns["start_ms"]
            if dur >= 1000:
                label = ns.get("label", "silence")
                items.append({
                    "start": ns["start_ms"],
                    "end": ns["end_ms"],
                    "en": PLACEHOLDER_LABELS.get(label, PLACEHOLDER_LABELS["silence"]),
                    "dur": dur,
                    "is_placeholder": True,
                    "placeholder_type": label,
                })

    # Distribute sentences across usable windows
    sent_idx = 0
    for window in usable_windows:
        window_start = window["start"]
        window_end = window["end"]
        window_dur = window_end - window_start
        if window_dur <= 0 or sent_idx >= len(sentences):
            continue

        # Determine which sentences belong to this window based on proportion
        window_chars = sum(len(sentences[i]) for i in range(sent_idx, len(sentences)))
        cursor = window_start
        while sent_idx < len(sentences) and cursor < window_end:
            s = sentences[sent_idx]
            s_dur = window_dur * (len(s) / max(1, window_chars))
            s_dur = max(s_dur, 500)
            s_end = min(int(cursor + s_dur), int(window_end))
            if s_end <= cursor:
                break
            items.append({
                "start": int(cursor),
                "end": s_end,
                "en": s,
                "dur": s_end - int(cursor),
            })
            cursor = s_end
            sent_idx += 1

    items.sort(key=lambda x: x["start"])
    return items


def _split_text_to_sentences(text: str, language: str = "en") -> List[str]:
    if not text or not text.strip():
        return []
    split_pat = _fallback_split_pattern(language)
    parts = re.split(split_pat, text.strip())
    return [p.strip().replace("<DOT>", ".") for p in parts if p.strip()]


def _merge_intervals(intervals: list[dict]) -> list[dict]:
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


def _estimate_speech_duration(text: str, language: str = "en") -> int:
    if not text:
        return 0
    if language in ("zh", "ja", "ko"):
        return int(len(text) * 250)
    return int(len(text) * 77)


def insert_placeholders_for_word_gaps(
    items: list[dict],
    duration_ms: int = 0,
    min_gap_ms: int = 1000,
    classified_segments: List[dict] = None,
) -> List[dict]:
    """Insert placeholder items for non-speech gaps and classified non-speech segments.

    When classified_segments is provided, placeholders are labeled with the
    detected type (music/applause/silence). Gaps between word-based sentence
    items and explicitly classified non-speech segments both produce placeholders.
    """
    if not items:
        return items

    items_sorted = sorted(items, key=lambda x: x.get("start", 0))
    result: List[dict] = []

    def label_for_gap(start_ms: int, end_ms: int) -> tuple[str, str]:
        if not classified_segments:
            return "silence", PLACEHOLDER_LABELS["silence"]
        max_overlap = 0
        best_label = "silence"
        for seg in classified_segments:
            if seg["label"] == "speech":
                continue
            if seg["end_ms"] <= start_ms or seg["start_ms"] >= end_ms:
                continue
            overlap = min(seg["end_ms"], end_ms) - max(seg["start_ms"], start_ms)
            if overlap > max_overlap:
                max_overlap = overlap
                best_label = seg.get("label", "silence")
        return best_label, PLACEHOLDER_LABELS.get(best_label, PLACEHOLDER_LABELS["silence"])

    first_start = int(items_sorted[0].get("start", 0))
    if duration_ms > 0 and first_start >= min_gap_ms:
        label_type, label_text = label_for_gap(0, first_start)
        result.append({
            "start": 0,
            "end": first_start,
            "en": label_text,
            "dur": first_start,
            "is_placeholder": True,
            "placeholder_type": label_type,
        })

    for i, it in enumerate(items_sorted):
        result.append(it)
        nxt = items_sorted[i + 1] if i + 1 < len(items_sorted) else None
        if nxt is None:
            continue
        gap_start = int(it.get("end", 0))
        gap_end = int(nxt.get("start", 0))
        gap_dur = gap_end - gap_start
        if gap_dur >= min_gap_ms:
            label_type, label_text = label_for_gap(gap_start, gap_end)
            result.append({
                "start": gap_start,
                "end": gap_end,
                "en": label_text,
                "dur": gap_dur,
                "is_placeholder": True,
                "placeholder_type": label_type,
            })

    if duration_ms > 0:
        last_end = int(max((it.get("end", 0) for it in items_sorted), default=0))
        trailing = int(duration_ms) - last_end
        if trailing >= min_gap_ms:
            label_type, label_text = label_for_gap(last_end, int(duration_ms))
            result.append({
                "start": last_end,
                "end": int(duration_ms),
                "en": label_text,
                "dur": trailing,
                "is_placeholder": True,
                "placeholder_type": label_type,
            })

    # Force-insert placeholders for classified non-speech segments that overlap
    # existing items (e.g. wav2vec2 alignment may have filled music sections).
    if classified_segments:
        for seg in sorted(classified_segments, key=lambda x: x["start_ms"]):
            if seg["label"] == "speech":
                continue
            dur = seg["end_ms"] - seg["start_ms"]
            if dur < min_gap_ms:
                continue
            ph_start = int(seg["start_ms"])
            ph_end = int(seg["end_ms"])
            label_text = PLACEHOLDER_LABELS.get(seg["label"], PLACEHOLDER_LABELS["silence"])

            new_result: List[dict] = []
            for it in result:
                it_start = int(it.get("start", 0))
                it_end = int(it.get("end", 0))
                if it_end <= ph_start or it_start >= ph_end:
                    new_result.append(it)
                    continue
                # Item overlaps placeholder. Keep non-overlapping left/right parts.
                if it_start < ph_start:
                    left = dict(it)
                    left["end"] = ph_start
                    left["dur"] = ph_start - it_start
                    # Trim text roughly? For now keep full text; player can still show it.
                    new_result.append(left)
                if it_end > ph_end:
                    right = dict(it)
                    right["start"] = ph_end
                    right["dur"] = it_end - ph_end
                    new_result.append(right)
            new_result.append({
                "start": ph_start,
                "end": ph_end,
                "en": label_text,
                "dur": dur,
                "is_placeholder": True,
                "placeholder_type": seg["label"],
            })
            result = sorted(new_result, key=lambda x: x.get("start", 0))

    # Merge adjacent placeholders of the same type
    merged: List[dict] = []
    for it in result:
        if (
            merged
            and it.get("is_placeholder")
            and merged[-1].get("is_placeholder")
            and it.get("placeholder_type") == merged[-1].get("placeholder_type")
            and it["start"] <= merged[-1]["end"] + 100
        ):
            merged[-1]["end"] = it["end"]
            merged[-1]["dur"] = merged[-1]["end"] - merged[-1]["start"]
        else:
            merged.append(it)

    logger.info(
        "Inserted placeholders for word gaps: %d items -> %d (min_gap=%dms, dur=%dms)",
        len(items_sorted), len(merged), min_gap_ms, duration_ms,
    )

    return merged


def build_subtitles_from_speech_segments(
    text: str,
    speech_segments: list[dict],
    non_speech_segments: list[dict],
    language: str = "en",
    classified_segments: List[dict] = None,
) -> List[dict]:
    """Build subtitle items by mapping sentences to detected speech segments.

    Uses classified segments when available to label music/applause/silence.
    """
    sentences = _split_text_to_sentences(text, language)
    if not sentences and not speech_segments and not non_speech_segments:
        return []

    items = []
    placeholder_min_ms = 1000

    merged_speech = _merge_intervals([{"start": s["start_ms"], "end": s["end_ms"]} for s in speech_segments])
    merged_non_speech = _merge_intervals([{"start": s["start_ms"], "end": s["end_ms"]} for s in non_speech_segments])
    valid_non_speech = [s for s in merged_non_speech if s["end"] - s["start"] >= placeholder_min_ms]

    usable_windows = _subtract_intervals(merged_speech, valid_non_speech)
    total_usable = sum(w["end"] - w["start"] for w in usable_windows)

    total_text = "".join(sentences)
    estimated_ms = _estimate_speech_duration(total_text, language)

    logger.info("Speech build: %d windows, usable=%dms, text_est=%dms",
                len(usable_windows), total_usable, estimated_ms)

    # Add placeholders for VAD-detected non-speech with labels from classifier
    def label_for_ns(start_ms: int, end_ms: int) -> str:
        if not classified_segments:
            return "silence"
        max_overlap = 0
        best_label = "silence"
        for seg in classified_segments:
            if seg["end_ms"] <= start_ms or seg["start_ms"] >= end_ms:
                continue
            overlap = min(seg["end_ms"], end_ms) - max(seg["start_ms"], start_ms)
            if overlap > max_overlap:
                max_overlap = overlap
                best_label = seg.get("label", "silence")
        return best_label

    for ns in valid_non_speech:
        label = label_for_ns(ns["start"], ns["end"])
        items.append({
            "start": ns["start"],
            "end": ns["end"],
            "en": PLACEHOLDER_LABELS.get(label, PLACEHOLDER_LABELS["silence"]),
            "dur": ns["end"] - ns["start"],
            "is_placeholder": True,
            "placeholder_type": label,
        })

    # Distribute sentences across usable windows
    if sentences and usable_windows:
        seg_text_chars = max(1, sum(len(s) for s in sentences))
        sent_idx = 0

        # Heuristic: don't let VAD over-detection push real speech off the end.
        # Cap usable time at estimated speech * 1.5, but keep all windows available.
        if estimated_ms > 0 and total_usable > estimated_ms * 2.0:
            # VAD likely over-detected (music as speech). Still distribute, but
            # with a stretched total so sentences don't vanish.
            stretch_factor = min(1.5, estimated_ms * 2.0 / total_usable)
        else:
            stretch_factor = 1.0

        for window in usable_windows:
            window_dur = window["end"] - window["start"]
            window_share = window_dur * stretch_factor
            window_limit = window["start"] + window_share
            cursor = window["start"]

            while sent_idx < len(sentences) and cursor < window_limit:
                s = sentences[sent_idx]
                s_dur = estimated_ms * (len(s) / seg_text_chars) if estimated_ms > 0 else window_share * (len(s) / seg_text_chars)
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
                cursor = s_end
                sent_idx += 1

    items.sort(key=lambda x: x["start"])

    # Merge consecutive placeholders
    merged_items = []
    for it in items:
        if it.get("is_placeholder") and merged_items and merged_items[-1].get("is_placeholder"):
            merged_items[-1]["end"] = it["end"]
            merged_items[-1]["dur"] = it["end"] - merged_items[-1]["start"]
            # Prefer music/applause label over silence if merging
            if it.get("placeholder_type") in ("music", "applause"):
                merged_items[-1]["placeholder_type"] = it["placeholder_type"]
                merged_items[-1]["en"] = it["en"]
        else:
            merged_items.append(it)

    logger.info("VAD-based split: %d items (%s)", len(merged_items), language)
    return merged_items
