// Word lookup popover controller
// - Renders a singleton popover near the clicked word
// - Fetches /api/word/lookup (with debounce / cache)
// - Plays TTS via /api/word/tts
// - Save / unsave via /api/vocabulary
const WordLookup = (() => {
  let popover, elWord, elPhonetic, elPos, elBody, elSource, btnSave, btnSpeak, btnClose, btnRefresh;
  let audioEl = null;
  let currentReq = 0; // sequence guard
  let inFlightToken = null; // word currently being looked up
  const lookupCache = new Map(); // word -> entry
  let current = null; // { word, entry, sourceSentence, anchor }

  function init() {
    popover = document.getElementById("wordPopover");
    elWord = document.getElementById("wpWord");
    elPhonetic = document.getElementById("wpPhonetic");
    elPos = document.getElementById("wpPos");
    elBody = document.getElementById("wpBody");
    elSource = document.getElementById("wpSource");
    btnSave = document.getElementById("wpSave");
    btnSpeak = document.getElementById("wpSpeak");
    btnClose = document.getElementById("wpClose");
    btnRefresh = document.getElementById("wpRefresh");

    btnClose.addEventListener("click", hide);
    btnSave.addEventListener("click", toggleSave);
    btnSpeak.addEventListener("click", speak);
    btnRefresh.addEventListener("click", () => {
      if (!current) return;
      lookupCache.delete(current.word.toLowerCase());
      fetchEntry(current.word, /*force*/ true);
    });

    document.addEventListener("click", (e) => {
      if (!popover || popover.hidden) return;
      if (e.target.closest("#wordPopover")) return;
      if (e.target.closest(".word")) return; // let player.js handle re-open
      hide();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && popover && !popover.hidden) {
        hide();
      }
    });

    window.addEventListener("resize", () => {
      if (!popover.hidden) positionPopover();
    });
    window.addEventListener("scroll", () => {
      if (!popover.hidden) positionPopover();
    }, true);

    if (window.NativeLang && typeof window.NativeLang.onChange === "function") {
      window.NativeLang.onChange(() => {
        lookupCache.clear();
        if (!popover.hidden) hide();
      });
    }
  }

  function show(anchorEl, sentence) {
    const word = (anchorEl.dataset.word || "").trim();
    if (!word) return;
    current = { word, entry: null, sourceSentence: sentence, anchor: anchorEl };
    document.querySelectorAll(".word.is-active").forEach((el) => el.classList.remove("is-active"));
    anchorEl.classList.add("is-active");

    elWord.textContent = word;
    elPhonetic.textContent = "";
    elPos.textContent = "";
    elSource.textContent = "";
    btnSave.textContent = "☆ Save";
    btnSave.classList.remove("saved");
    elBody.innerHTML = `
      <div class="wp-skeleton">
        <div class="wp-skel-line"></div>
        <div class="wp-skel-line short"></div>
        <div class="wp-skel-line"></div>
      </div>`;

    popover.hidden = false;
    popover.classList.remove("bottom-sheet");
    positionPopover();

    const key = word.toLowerCase();
    const cached = lookupCache.get(key);
    if (cached && cached.native_lang === currentNativeLang()) {
      renderEntry(cached);
    } else {
      // Invalidate stale cache when language switched
      if (cached) lookupCache.delete(key);
      fetchEntry(word, false);
    }
  }

  function currentNativeLang() {
    return (window.NativeLang && window.NativeLang.current) ? window.NativeLang.current() : "en";
  }

  function hide() {
    if (!popover) return;
    popover.hidden = true;
    document.querySelectorAll(".word.is-active").forEach((el) => el.classList.remove("is-active"));
    if (audioEl) {
      audioEl.pause();
      audioEl = null;
    }
    current = null;
  }

  function positionPopover() {
    if (!current || !current.anchor) return;
    const rect = current.anchor.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;

    // Mobile: bottom sheet
    if (vw <= 768) {
      popover.classList.add("bottom-sheet");
      popover.style.left = "0px";
      popover.style.top = "0px";
      return;
    }
    popover.classList.remove("bottom-sheet");

    let top = rect.bottom + margin;
    let left = rect.left + rect.width / 2 - popRect.width / 2;
    // If overflowing bottom, flip above
    if (top + popRect.height > vh - 12) {
      top = rect.top - popRect.height - margin;
    }
    // Clamp vertically
    top = Math.max(12, Math.min(vh - popRect.height - 12, top));
    // Clamp horizontally
    left = Math.max(12, Math.min(vw - popRect.width - 12, left));
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  async function fetchEntry(word, forceRefresh) {
    const token = ++currentReq;
    inFlightToken = word.toLowerCase();
    try {
      const lang = currentNativeLang();
      const params = new URLSearchParams({ word, lang });
      if (forceRefresh) params.set("force_refresh", "true");
      const resp = await fetch(`/api/word/lookup?${params.toString()}`);
      if (token !== currentReq) return; // newer request superseded
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      lookupCache.set(word.toLowerCase(), data);
      if (current && current.word === word) {
        renderEntry(data);
      }
    } catch (err) {
      if (token !== currentReq) return;
      renderError(err.message || String(err));
    }
  }

  function renderEntry(entry) {
    if (!current) return;
    current.entry = entry;
    elWord.textContent = entry.word || current.word;
    elPhonetic.textContent = entry.phonetic || "";
    elPos.textContent = entry.pos || "";
    elSource.textContent = formatSource(entry.source) + (entry.native_lang && entry.native_lang !== "en" ? ` · ${entry.native_lang}` : "");
    btnRefresh.style.display = entry.source && entry.source.startsWith("llm:") ? "" : "none";
    updateSaveButton(entry.saved);

    const nativeLang = entry.native_lang || "en";
    const isNativeEn = nativeLang === "en";
    const meaningNative = entry.meaning_native || "";
    const meaningEn = entry.meaning_en || "";

    const parts = [];
    if (meaningNative) {
      parts.push(`<div class="wp-meaning wp-meaning-native">${escapeHtml(meaningNative)}</div>`);
    }
    if (!isNativeEn && meaningEn) {
      parts.push(`<div class="wp-meaning wp-meaning-en">${escapeHtml(meaningEn)}</div>`);
    }
    if (Array.isArray(entry.examples) && entry.examples.length) {
      const items = entry.examples
        .filter((e) => e && e.en)
        .map((e) => {
          const native = !isNativeEn && e[nativeLang] ? `<div class="wp-ex-native">${escapeHtml(e[nativeLang])}</div>` : "";
          return `<li><div class="wp-ex-en">${escapeHtml(e.en)}</div>${native}</li>`;
        })
        .join("");
      if (items) parts.push(`<ul class="wp-examples">${items}</ul>`);
    }
    if (!parts.length) {
      parts.push('<div class="wp-empty">No definition found.</div>');
    }
    elBody.innerHTML = parts.join("");
  }

  function renderError(msg) {
    elBody.innerHTML = `
      <div class="wp-error">
        <div>⚠️ ${escapeHtml(msg)}</div>
        <button class="wp-btn ghost" id="wpRetry">Retry</button>
      </div>`;
    const retry = document.getElementById("wpRetry");
    if (retry) retry.addEventListener("click", () => current && fetchEntry(current.word, true));
  }

  function formatSource(src) {
    if (!src) return "";
    if (src === "cache:memory") return "⚡ cache";
    if (src === "cache:disk") return "💾 cached";
    if (src === "api:free-dict") return "📘 free-dict";
    if (src === "llm:qwen-plus") return "🤖 qwen-plus";
    return src;
  }

  function updateSaveButton(saved) {
    if (saved) {
      btnSave.textContent = "★ Saved";
      btnSave.classList.add("saved");
    } else {
      btnSave.textContent = "☆ Save";
      btnSave.classList.remove("saved");
    }
  }

  async function toggleSave() {
    if (!current || !current.entry) {
      // Try to fetch first if we don't have an entry
      await fetchEntry(current?.word || "", false);
      if (!current || !current.entry) return;
    }
    const e = current.entry;
    const wasSaved = !!e.saved;
    if (wasSaved) {
      // Unsave
      const w = encodeURIComponent(e.word);
      const resp = await fetch(`/api/vocabulary/${w}`, { method: "DELETE" });
      if (resp.ok) {
        e.saved = false;
        updateSaveButton(false);
        showToast("Removed from vocabulary", "info", 1800);
        window.dispatchEvent(new CustomEvent("vocab:changed"));
      } else {
        const data = await resp.json().catch(() => ({}));
        showToast(`❌ ${data.detail || resp.status}`, "error", 3000);
      }
    } else {
      // Save
      const lang = e.native_lang || currentNativeLang();
      const firstEx = Array.isArray(e.examples) && e.examples.length ? e.examples[0] : null;
      const exampleOut = firstEx
        ? { en: firstEx.en, native: lang !== "en" ? (firstEx[lang] || "") : "" }
        : null;
      const body = {
        word: e.word,
        lemma: e.lemma || e.word,
        phonetic: e.phonetic || "",
        pos: e.pos || "",
        meaning_en: e.meaning_en || "",
        meaning_native: e.meaning_native || "",
        native_lang: lang,
        example: exampleOut,
        source_history_id: window.History && window.History.currentId ? window.History.currentId : null,
      };
      const resp = await fetch("/api/vocabulary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        e.saved = true;
        updateSaveButton(true);
        showToast(`✅ "${e.word}" saved`, "success", 2000);
        window.dispatchEvent(new CustomEvent("vocab:changed"));
      } else {
        const data = await resp.json().catch(() => ({}));
        showToast(`❌ ${data.detail || resp.status}`, "error", 3000);
      }
    }
  }

  async function speak() {
    if (!current) return;
    const word = current.entry?.word || current.word;
    btnSpeak.classList.add("loading");
    try {
      const url = `/api/word/tts?word=${encodeURIComponent(word)}&voice=Cherry&language_type=English`;
      const resp = await fetch(url);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      if (audioEl) {
        audioEl.pause();
      }
      audioEl = new Audio(blobUrl);
      audioEl.addEventListener("ended", () => URL.revokeObjectURL(blobUrl));
      audioEl.addEventListener("error", () => URL.revokeObjectURL(blobUrl));
      await audioEl.play();
    } catch (err) {
      showToast(`🔇 TTS failed: ${err.message || err}`, "error", 3000);
    } finally {
      btnSpeak.classList.remove("loading");
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showToast(msg, type, dur) {
    if (typeof window.showToast === "function") {
      window.showToast(msg, type, dur);
    } else {
      console.log(`[WordLookup] ${msg}`);
    }
  }

  return { init, show, hide };
})();

window.WordLookup = WordLookup;
document.addEventListener("DOMContentLoaded", WordLookup.init);
