// Vocabulary / favorites tab — Grid Card Layout
const Vocab = (() => {
  let listEl, subEl, searchEl, statsEl, refreshBtn, exportBtn;
  let items = [];
  let filterText = "";
  let expandedCards = new Set(); // Track expanded cards

  function init() {
    listEl = document.getElementById("vocabList");
    subEl = document.getElementById("vocabSub");
    searchEl = document.getElementById("vocabSearch");
    statsEl = document.getElementById("vocabStats");
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
      if (statsEl) statsEl.innerHTML = "";
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
    renderStats(filtered);
    if (!filtered.length) {
      listEl.innerHTML = '<div class="vocab-empty">No words match your search.</div>';
      return;
    }
    listEl.innerHTML = filtered.map(cardHtml).join("");
    listEl.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", onAction);
    });
    listEl.querySelectorAll("[data-lookup-word]").forEach((el) => {
      el.addEventListener("click", onLookupClick);
    });
    // Restore expanded state
    expandedCards.forEach((word) => {
      const details = document.getElementById(`vc-details-${escapeId(word)}`);
      const btn = document.querySelector(`[data-expand-target="vc-details-${escapeId(word)}"]`);
      if (details && btn) {
        details.hidden = false;
        btn.textContent = "▴ Less";
        btn.classList.add("expanded");
      }
    });
  }

  function renderStats(words) {
    if (!statsEl) return;
    const posCount = {};
    words.forEach((w) => {
      const pos = w.pos || "unknown";
      posCount[pos] = (posCount[pos] || 0) + 1;
    });
    const posTags = Object.entries(posCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pos, count]) => `<span class="vocab-stat-tag">${escapeHtml(pos)} ${count}</span>`)
      .join("");
    statsEl.innerHTML = posTags;
  }

  function onLookupClick(ev) {
    ev.stopPropagation();
    const w = ev.currentTarget.dataset.lookupWord;
    if (!w) return;
    if (!window.WordLookup || typeof window.WordLookup.show !== "function") return;
    const fakeAnchor = document.createElement("span");
    fakeAnchor.className = "word";
    fakeAnchor.dataset.word = w;
    fakeAnchor.textContent = w;
    const rect = ev.currentTarget.getBoundingClientRect();
    Object.defineProperty(fakeAnchor, "getBoundingClientRect", {
      value: () => rect,
    });
    window.WordLookup.show(fakeAnchor, null);
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

  function escapeId(s) {
    return String(s).replace(/[^a-zA-Z0-9]/g, "-");
  }

  function cardHtml(w) {
    const safe = (s) => escapeHtml(s || "");
    const wordId = escapeId(w.word);
    const isExpanded = expandedCards.has(w.word);
    
    // Header
    const phonetic = w.phonetic ? `<span class="vc-phonetic">${safe(w.phonetic)}</span>` : "";
    const pos = w.pos ? `<span class="vc-pos">${safe(w.pos)}</span>` : "";
    
    // Meanings
    const lang = w.native_lang || "en";
    const langBadge = `<span class="vc-lang-badge">${safe(lang.toUpperCase())}</span>`;
    const native = w.meaning_native ? `<div class="vc-meaning vc-native">${safe(w.meaning_native)} ${langBadge}</div>` : "";
    const en = w.meaning_en ? `<div class="vc-meaning vc-en">${safe(w.meaning_en)}</div>` : "";
    
    // Example (compact)
    let exampleCompact = "";
    if (w.example && w.example.en) {
      exampleCompact = `<div class="vc-example-compact">"${safe(w.example.en.substring(0, 60))}${w.example.en.length > 60 ? '...' : ''}"</div>`;
    }
    
    // Word root / etymology (details section)
    const roots = w.roots || {};
    const family = Array.isArray(w.family) ? w.family : [];
    const related = Array.isArray(w.related) ? w.related : [];
    const etymologyNative = w.etymology_native || "";
    const etymologyEn = w.etymology_en || "";
    
    const rootChips = [];
    if (roots.prefix) rootChips.push(`<span class="vc-root-chip vc-root-prefix">${safe(roots.prefix)}</span>`);
    if (roots.root) rootChips.push(`<span class="vc-root-chip vc-root-base">${safe(roots.root)}</span>`);
    if (roots.suffix) rootChips.push(`<span class="vc-root-chip vc-root-suffix">${safe(roots.suffix)}</span>`);
    const hasRoots = rootChips.length > 0;
    const hasFamily = family.length > 0;
    const hasRelated = related.length > 0;
    const hasEtymology = !!(etymologyNative || etymologyEn);
    const hasDetails = hasRoots || hasFamily || hasRelated || hasEtymology || (w.example && w.example.en);
    
    let detailsHtml = "";
    if (hasDetails) {
      // Etymology
      if (hasEtymology) {
        const primary = lang !== "en" && etymologyNative ? etymologyNative : etymologyEn;
        const secondary = lang !== "en" && etymologyNative && etymologyEn
          ? `<div class="vc-ety-en">${safe(etymologyEn)}</div>`
          : "";
        detailsHtml += `<div class="vc-detail-section"><div class="vc-detail-title">📖 Etymology</div><div class="vc-ety-primary">${safe(primary)}</div>${secondary}</div>`;
      }
      
      // Word Roots
      if (hasRoots) {
        detailsHtml += `<div class="vc-detail-section"><div class="vc-detail-title">🌱 Word Roots</div><div class="vc-roots-row">${rootChips.join("")}</div></div>`;
      }
      
      // Family
      if (hasFamily) {
        detailsHtml += `<div class="vc-detail-section"><div class="vc-detail-title">👥 Word Family</div><div class="vc-family-row">${family.map((x) => `<span class="vc-family-chip" data-lookup-word="${safe(x)}" title="Look up '${safe(x)}'">${safe(x)}</span>`).join("")}</div></div>`;
      }
      
      // Related
      if (hasRelated) {
        detailsHtml += `<div class="vc-detail-section"><div class="vc-detail-title">🔗 Related Words</div><ul class="vc-related-list">${related.map((r) => {
          const w2 = safe(r.word || "");
          const pos2 = r.pos ? `<span class="vc-related-pos">${safe(r.pos)}</span>` : "";
          const gloss = r.gloss_en ? `<span class="vc-related-gloss">${safe(r.gloss_en)}</span>` : "";
          return `<li><span class="vc-related-word" data-lookup-word="${w2}">${w2}</span> ${pos2} ${gloss}</li>`;
        }).join("")}</ul></div>`;
      }
      
      // Full Example
      if (w.example && w.example.en) {
        const nativeEx = w.example.native ? `<div class="vc-ex-native">${safe(w.example.native)}</div>` : "";
        detailsHtml += `<div class="vc-detail-section"><div class="vc-detail-title">💬 Example</div><div class="vc-example-full"><div class="vc-ex-en">"${safe(w.example.en)}"</div>${nativeEx}</div></div>`;
      }
    }
    
    const added = formatDate(w.added_at);
    
    return `
      <div class="vocab-card" data-word="${safe(w.word)}" data-lang="${safe(lang)}">
        <div class="vocab-card-inner">
          <div class="vc-head">
            <span class="vc-word">${safe(w.word)}</span>
            ${phonetic}
            ${pos}
          </div>
          <div class="vc-meanings">${native}${en}</div>
          ${exampleCompact}
          <div class="vc-card-footer">
            <span class="vc-added">${added}</span>
            <div class="vc-actions">
              ${hasDetails ? `<button class="vc-expand-btn ${isExpanded ? 'expanded' : ''}" data-action="toggle-expand" data-expand-target="vc-details-${wordId}" data-word="${safe(w.word)}" title="Show details">${isExpanded ? '▴ Less' : '▾ More'}</button>` : ""}
              <button class="vc-icon-btn" data-action="speak" title="Pronounce">🔊</button>
              <button class="vc-icon-btn" data-action="remove" title="Remove">🗑</button>
            </div>
          </div>
        </div>
        ${hasDetails ? `<div class="vc-details" id="vc-details-${wordId}" ${isExpanded ? '' : 'hidden'}>${detailsHtml}</div>` : ""}
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
    const card = btn.closest(".vocab-card");
    const word = card?.dataset.word;
    const action = btn.dataset.action;
    if (!word) return;
    
    if (action === "toggle-expand") {
      const targetId = btn.dataset.expandTarget;
      const target = document.getElementById(targetId);
      if (target) {
        const isHidden = target.hasAttribute("hidden");
        if (isHidden) {
          target.removeAttribute("hidden");
          btn.textContent = "▴ Less";
          btn.classList.add("expanded");
          expandedCards.add(word);
        } else {
          target.setAttribute("hidden", "");
          btn.textContent = "▾ More";
          btn.classList.remove("expanded");
          expandedCards.delete(word);
        }
      }
      return;
    }
    
    if (action === "remove") {
      if (!confirm(`Remove "${word}" from your vocabulary?`)) return;
      try {
        const resp = await fetch(`/api/vocabulary/${encodeURIComponent(word)}`, { method: "DELETE" });
        if (resp.ok) {
          items = items.filter((w) => w.word.toLowerCase() !== word.toLowerCase());
          expandedCards.delete(word);
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
