"""Lightweight English word tokenization & lemmatization.

Goals:
  - Split a subtitle string into clickable word tokens and punctuation.
  - Map inflected forms back to a base form for dictionary lookup.
  - No external NLP dependencies (no NLTK / spaCy).

This is intentionally simple — coverage is good for common subtitles
but won't beat a real lemmatizer. When in doubt we just return the
lower-cased original word.
"""
from __future__ import annotations

import re
from typing import List, Tuple

# Common irregular verb / noun mappings
_IRREGULAR: dict[str, str] = {
    "ran": "run", "running": "run", "runs": "run",
    "went": "go", "gone": "go", "going": "go", "goes": "go",
    "had": "have", "has": "have", "having": "have",
    "did": "do", "done": "do", "doing": "do", "does": "do",
    "was": "be", "were": "be", "been": "be", "being": "be", "am": "be", "is": "are",
    "said": "say", "saying": "say", "says": "say",
    "made": "make", "making": "make", "makes": "make",
    "took": "take", "taken": "take", "taking": "take", "takes": "take",
    "came": "come", "coming": "come", "comes": "come",
    "saw": "see", "seen": "see", "seeing": "see", "sees": "see",
    "got": "get", "gotten": "get", "getting": "get", "gets": "get",
    "gave": "give", "given": "give", "giving": "give", "gives": "give",
    "knew": "know", "known": "know", "knowing": "know", "knows": "know",
    "thought": "think", "thinking": "think", "thinks": "think",
    "told": "tell", "telling": "tell", "tells": "tell",
    "felt": "feel", "feeling": "feel", "feels": "feel",
    "found": "find", "finding": "find", "finds": "find",
    "kept": "keep", "keeping": "keep", "keeps": "keep",
    "left": "leave", "leaving": "leave", "leaves": "leave",
    "lost": "lose", "losing": "lose", "loses": "lose",
    "brought": "bring", "bringing": "bring", "brings": "bring",
    "bought": "buy", "buying": "buy", "buys": "buy",
    "caught": "catch", "catching": "catch", "catches": "catch",
    "taught": "teach", "teaching": "teach", "teaches": "teach",
    "wrote": "write", "written": "write", "writing": "write", "writes": "write",
    "spoke": "speak", "spoken": "speak", "speaking": "speak", "speaks": "speak",
    "broke": "break", "broken": "break", "breaking": "break", "breaks": "break",
    "chose": "choose", "chosen": "choose", "choosing": "choose", "chooses": "choose",
    "drove": "drive", "driven": "drive", "driving": "drive", "drives": "drive",
    "ate": "eat", "eaten": "eat", "eating": "eat", "eats": "eat",
    "fell": "fall", "fallen": "fall", "falling": "fall", "falls": "fall",
    "grew": "grow", "grown": "grow", "growing": "grow", "grows": "grow",
    "children": "child", "men": "man", "women": "woman",
    "people": "person", "feet": "foot", "teeth": "tooth", "mice": "mouse",
    "better": "good", "best": "good", "worse": "bad", "worst": "bad",
    "more": "much", "most": "much", "less": "little", "least": "little",
    "i'm": "i am", "don't": "do not", "doesn't": "does not", "didn't": "did not",
    "won't": "will not", "wouldn't": "would not", "shouldn't": "should not",
    "couldn't": "could not", "can't": "can not", "cannot": "can not",
    "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
    "haven't": "have not", "hasn't": "have not", "hadn't": "had not",
    "they're": "they are", "we're": "we are", "you're": "you are",
    "it's": "it is", "that's": "that is", "there's": "there is",
    "i've": "i have", "you've": "you have", "we've": "we have", "they've": "they have",
    "i'll": "i will", "you'll": "you will", "we'll": "we will", "they'll": "they will",
    "lying": "lie", "lyingly": "lie", "tied": "tie", "tier": "tie", "dies": "die", "died": "die",
}

# Token regex: words include letters, optional internal apostrophes/hyphens,
# contractions are split intentionally so each part can be looked up.
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*|[0-9]+|[^A-Za-z0-9\s]+|\s+", re.UNICODE)


def tokenize(text: str) -> List[Tuple[str, str]]:
    """Split text into (kind, text) tokens.

    kind is one of: "word", "space", "punct", "number".
    """
    out: List[Tuple[str, str]] = []
    for m in _TOKEN_RE.finditer(text or ""):
        s = m.group(0)
        if s.isspace():
            out.append(("space", s))
        elif s.isalpha() or ("'" in s and any(c.isalpha() for c in s)) or (s.count("-") and any(c.isalpha() for c in s)):
            out.append(("word", s))
        elif s.isdigit():
            out.append(("number", s))
        else:
            out.append(("punct", s))
    return out


def normalize_for_lookup(token: str) -> str:
    """Lowercase and strip leading/trailing punctuation/apostrophes."""
    return token.strip().lower().strip("'\u2019\"")


def lemma(word: str) -> str:
    """Return a base/dictionary form for lookup. Always lowercase."""
    w = normalize_for_lookup(word)
    if not w:
        return w
    if w in _IRREGULAR:
        base = _IRREGULAR[w]
        # contraction expansions stay multi-word — use first token
        return base.split()[0]
    # Suffix rules (apply longest first)
    if w.endswith("ies") and len(w) > 4 and w[-4] not in "aeiou":
        return w[:-3] + "y"
    if w.endswith("ied") and len(w) > 3:
        return w[:-3] + "y"
    if w.endswith("ying") and len(w) > 5:
        return w[:-4] + "y"
    if w.endswith("ing") and len(w) > 5 and w[-4] not in "aeiou":
        stem = w[:-3]
        if stem.endswith(stem[-1]) and len(stem) > 2:
            stem = stem[:-1]
        return stem
    if w.endswith("ed") and len(w) > 4 and w[-3] not in "aeiou":
        stem = w[:-2]
        if stem.endswith(stem[-1]) and len(stem) > 2:
            stem = stem[:-1]
        if stem.endswith("i"):
            return stem[:-1] + "y"
        return stem
    if w.endswith(("ches", "shes", "sses", "xes", "zes")) and len(w) > 4:
        return w[:-2]
    if w.endswith("oes") and len(w) > 3:
        return w[:-2]
    if w.endswith("es") and len(w) > 4 and w[-3] in ("s", "x", "z", "o"):
        return w[:-1]
    if w.endswith("s") and len(w) > 3 and not w.endswith("ss"):
        return w[:-1]
    if w.endswith("'s") and len(w) > 3:
        return w[:-2]
    return w


def is_english_word(token: str) -> bool:
    w = normalize_for_lookup(token)
    if not w:
        return False
    # Must start with a letter; allow letters/digits/'-/'_/"'" in body.
    if not w[0].isalpha():
        return False
    return bool(re.fullmatch(r"[a-z][a-z0-9'\-_]*", w))
