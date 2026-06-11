// Vocabulary / favorites tab
const Vocab = (() => {
  let listEl, subEl, searchEl, refreshBtn, exportBtn;
  let items = [];
  let filterText = "";

  function init() {
    listEl = document.getElementById("vocabList");
    subEl = document.getElementById("vocabSub");
    searchEl = document.getElementById("vocabSearch");
    refreshBtn = document.getElementById("vocabRefreshBtn");
    exportBtn = document.getElementById("vocabExportBtn");

    if (searchEl) {
      searchEl.addEventListener("input", (e) => {
        filterText = e.target.value.trim().toLowerCase();
        renderList();
      });
    }
    if (refreshBtn) refreshBtn.addEventListener("click", load);
    if (exportBtn) exportBtn.addEventListener("click", exportJson);

    window.addEventListener("vocab:changed", load);
  }

  async function load() {
    if (!listEl) return;
    if (subEl) subEl.textContent = "Loading…";
    try {
      const resp = await fetch("/api/vocabulary");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      items = data.items || [];
      renderList();
    } catch (err) {
      if (subEl) subEl.textContent = `❌ ${err.message || err}`;
    }
  }

  function renderList() {
    if (!listEl) return;
    if (!items.length) {
      listEl.innerHTML = '<div class="vocab-empty">No saved words yet. Click any word in a subtitle to look it up and save.</div>';
      if (subEl) subEl.textContent = `0 words`;
      return;
    }
    const filtered = filterText
      ? items.filter((w) => matches(w, filterText))
      : items.slice();
    if (subEl) {
      subEl.textContent = filterText
        ? `${filtered.length} / ${items.length} words`
        : `${items.length} words`;
    }
    if (!filtered.length) {
      listEl.innerHTML = '<div class="vocab-empty">No words match your search.</div>';
      return;
    }
    listEl.innerHTML = filtered.map(cardHtml).join("");
    listEl.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", onAction);
    });
  }

  function matches(w, q) {
    return (
      (w.word || "").toLowerCase().includes(q) ||
      (w.meaning_native || "").toLowerCase().includes(q) ||
      (w.meaning_en || "").toLowerCase().includes(q) ||
      (w.phonetic || "").toLowerCase().includes(q) ||
      (w.pos || "").toLowerCase().includes(q) ||
      (w.native_lang || "").toLowerCase().includes(q)
    );
  }

  function cardHtml(w) {
    const safe = (s) => escapeHtml(s || "");
    const phonetic = w.phonetic ? `<span class="vc-phonetic">${safe(w.phonetic)}</span>` : "";
    const pos = w.pos ? `<span class="vc-pos">${safe(w.pos)}</span>` : "";
    const lang = w.native_lang || "en";
    const langBadge = `<span class="vc-lang-badge" data-lang="${safe(lang)}">${safe(lang.toUpperCase())}</span>`;
    const native = w.meaning_native ? `<div class="vc-meaning vc-native">${safe(w.meaning_native)} ${langBadge}</div>` : "";
    const en = w.meaning_en ? `<div class="vc-meaning vc-en">${safe(w.meaning_en)}</div>` : "";
    let example = "";
    if (w.example && w.example.en) {
      const nativeEx = w.example.native ? `<div class="vc-ex-native">${safe(w.example.native)}</div>` : "";
      example = `<div class="vc-example"><div class="vc-ex-en">"${safe(w.example.en)}"</div>${nativeEx}</div>`;
    }
    const added = formatDate(w.added_at);
    return `
      <div class="vocab-item" data-word="${safe(w.word)}" data-lang="${safe(lang)}">
        <div class="vc-head">
          <span class="vc-word">${safe(w.word)}</span>
          ${phonetic}
          ${pos}
          <span class="vc-spacer"></span>
          <button class="vc-icon" data-action="speak" title="Pronounce">🔊</button>
          <button class="vc-icon" data-action="remove" title="Remove">🗑</button>
        </div>
        <div class="vc-meanings">${native}${en}</div>
        ${example}
        <div class="vc-foot">
          <span class="vc-added">added ${added}</span>
        </div>
      </div>`;
  }

  function formatDate(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      const now = new Date();
      const diff = (now - d) / 1000;
      if (diff < 60) return "just now";
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
      if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
      return d.toISOString().slice(0, 10);
    } catch (e) {
      return iso;
    }
  }

  async function onAction(e) {
    const btn = e.currentTarget;
    const card = btn.closest(".vocab-item");
    const word = card?.dataset.word;
    const action = btn.dataset.action;
    if (!word) return;
    if (action === "remove") {
      if (!confirm(`Remove "${word}" from your vocabulary?`)) return;
      try {
        const resp = await fetch(`/api/vocabulary/${encodeURIComponent(word)}`, { method: "DELETE" });
        if (resp.ok) {
          items = items.filter((w) => w.word.toLowerCase() !== word.toLowerCase());
          renderList();
          showToast(`Removed "${word}"`, "info", 1800);
        } else {
          const data = await resp.json().catch(() => ({}));
          showToast(`❌ ${data.detail || resp.status}`, "error", 3000);
        }
      } catch (err) {
        showToast(`❌ ${err.message || err}`, "error", 3000);
      }
    } else if (action === "speak") {
      try {
        const resp = await fetch(`/api/word/tts?word=${encodeURIComponent(word)}&voice=Cherry&language_type=English`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.addEventListener("ended", () => URL.revokeObjectURL(url));
        audio.addEventListener("error", () => URL.revokeObjectURL(url));
        await audio.play();
      } catch (err) {
        showToast(`🔇 TTS failed: ${err.message || err}`, "error", 3000);
      }
    }
  }

  function exportJson() {
    if (!items.length) {
      showToast("No words to export.", "info", 1800);
      return;
    }
    const blob = new Blob([JSON.stringify({ version: 1, words: items }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().slice(0, 10);
    a.download = `vocabulary-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 200);
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
      console.log(`[Vocab] ${msg}`);
    }
  }

  return { init, load };
})();

window.Vocab = Vocab;
document.addEventListener("DOMContentLoaded", Vocab.init);
