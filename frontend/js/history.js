/** History panel - list / open / delete records */
const History = (() => {
  let listEl, subEl, refreshBtn;
  let items = [];
  let currentId = null;

  function init() {
    listEl = document.getElementById("historyList");
    subEl = document.getElementById("historySub");
    refreshBtn = document.getElementById("historyRefreshBtn");

    refreshBtn.addEventListener("click", load);

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.tab === "history") {
          load();
        }
      });
    });
  }

  async function load() {
    if (!listEl) return;
    subEl.textContent = "Loading…";
    listEl.innerHTML = `<div class="history-empty">Loading…</div>`;
    try {
      const resp = await fetch("/api/history");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      items = data.items || [];
      render();
    } catch (err) {
      subEl.textContent = "Load failed";
      listEl.innerHTML = `<div class="history-empty">❌ ${err.message}</div>`;
    }
  }

  /** Save/update a history record (called after transcription) */
  async function save({ type, title, source, size_bytes = 0, duration = 0, subtitles = [], raw_text = "", progress_seconds = 0 }) {
    try {
      const resp = await fetch("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, title, source, size_bytes, duration, subtitles, raw_text, progress_seconds }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      currentId = data.id;
      const histPanel = document.getElementById("tab-history");
      if (histPanel && !histPanel.classList.contains("hidden")) {
        load();
      }
      return data.id;
    } catch (e) {
      console.warn("[History.save] failed:", e);
      return null;
    }
  }

  function reportProgress(id, t) {
    if (window.HistoryReportProgress) window.HistoryReportProgress(id, t);
  }

  function render() {
    if (!items.length) {
      subEl.textContent = "No history yet. Upload or load a video to get started.";
      listEl.innerHTML = `<div class="history-empty">📂 No history records</div>`;
      return;
    }
    subEl.textContent = `${items.length} records`;

    listEl.innerHTML = "";
    items.forEach(item => {
      const card = document.createElement("div");
      card.className = "history-item";
      card.dataset.id = item.id;

      const typeLabel = {
        local: "📁 Local Upload",
        youtube: "▶️ YouTube",
        online_url: "🔗 Online Video",
      }[item.type] || "📄 Other";

      const progressPct = item.duration
        ? Math.min(100, Math.round((item.progress_seconds || 0) / item.duration * 100))
        : 0;

      card.innerHTML = `
        <div class="hi-icon">${typeEmoji(item.type)}</div>
        <div class="hi-body">
          <div class="hi-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
          <div class="hi-meta">
            <span class="hi-type">${typeLabel}</span>
            <span>·</span>
            <span>${formatDuration(item.duration)}</span>
            <span>·</span>
            <span>${item.subtitle_count || 0} sentences</span>
            <span>·</span>
            <span title="${escapeHtml(item.last_opened || "")}">${formatRelative(item.last_opened || item.created_at)}</span>
            ${item.open_count > 1 ? `<span>·</span><span>opened ${item.open_count} times</span>` : ""}
          </div>
          <div class="hi-progress">
            <div class="hi-progress-bar"><div class="hi-progress-fill" style="width:${progressPct}%"></div></div>
            <span class="hi-progress-text">${formatDuration(item.progress_seconds || 0)} / ${formatDuration(item.duration || 0)}</span>
          </div>
        </div>
        <div class="hi-actions">
          <button class="btn primary hi-open">${item.progress_seconds > 1 ? "▶ Resume" : "▶ Open"}</button>
          <button class="btn ghost hi-delete" title="Delete">✕</button>
        </div>
      `;

      card.querySelector(".hi-open").addEventListener("click", () => openItem(item));
      card.querySelector(".hi-delete").addEventListener("click", () => deleteItem(item));

      listEl.appendChild(card);
    });
  }

  function typeEmoji(type) {
    if (type === "youtube") return "📺";
    if (type === "online_url") return "🔗";
    return "🎬";
  }

  async function openItem(item) {
    currentId = item.id;
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle("active", b.dataset.tab === "shadow");
    });
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.toggle("hidden", p.id !== "tab-shadow");
    });

    try {
      const resp = await fetch(`/api/history/${item.id}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const rec = await resp.json();

      if (window.App && typeof window.App.activateTab === "function") {
        window.App.activateTab("shadow");
      }

      const sourceLang = (rec.subtitles && rec.subtitles[0] && rec.subtitles[0].source_lang) || rec.source_lang || "en";
      if (window.AppState) window.AppState.currentSourceLang = sourceLang;

      if (rec.type === "youtube") {
        if (window.Player && window.Player.loadVideo) {
          const url = `https://www.youtube.com/watch?v=${rec.source}`;
          Player.loadVideo(url, {
            subtitles: rec.subtitles || [],
            duration: rec.duration || 0,
            title: rec.title,
          });
          if (rec.progress_seconds > 1) {
            window.AppState.historyYouTubeRestore = rec.progress_seconds;
          }
        }
      } else if (rec.type === "online_url") {
        if (window.Player && window.Player.loadVideo) {
          Player.loadVideo(rec.source, {
            subtitles: rec.subtitles || [],
            duration: rec.duration || 0,
            title: rec.title,
          });
          setTimeout(() => {
            if (rec.progress_seconds > 1 && window.Player.seekTo) {
              Player.seekTo(rec.progress_seconds);
            }
          }, 500);
        }
      } else {
        alert(
          `Local file "${rec.title}" is no longer stored on the server (only subtitles and progress are kept).\n\n` +
          `Please re-select the original file, and the previous subtitles/progress will be restored automatically.`
        );
        if (window.App && window.App.reselectForHistory) {
          App.reselectForHistory(rec);
        } else {
          document.getElementById("reloadBtn").click();
        }
      }
    } catch (err) {
      alert("Failed to open history record: " + err.message);
    }
  }

  async function deleteItem(item) {
    if (!confirm(`Delete history record "${item.title}"?`)) return;
    try {
      const resp = await fetch(`/api/history/${item.id}`, { method: "DELETE" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      await load();
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  }

  function formatDuration(s) {
    if (!s || isNaN(s) || s < 0) return "00:00";
    s = Math.floor(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function formatRelative(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (isNaN(t)) return iso;
    const diff = (Date.now() - t) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(iso).toLocaleDateString("en-US");
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/\u0026/g, "\u0026amp;")
      .replace(/\u003c/g, "\u0026lt;")
      .replace(/\u003e/g, "\u0026gt;")
      .replace(/"/g, "\u0026quot;");
  }

  return {
    init, load, save, reportProgress,
    get currentId() { return currentId; },
    set currentId(v) { currentId = v; },
  };
})();

window.History = History;

/* Progress reporting (throttled) */
(function () {
  let lastReport = 0;
  let pendingId = null;
  let pendingT = 0;
  let timer = null;

  async function flush() {
    if (!pendingId) return;
    const id = pendingId, t = pendingT;
    pendingId = null; pendingT = 0;
    lastReport = Date.now();
    try {
      await fetch(`/api/history/${id}/progress`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progress_seconds: t }),
      });
    } catch (e) { /* silent */ }
  }

  window.HistoryReportProgress = function (id, t) {
    if (!id) return;
    pendingId = id;
    pendingT = t;
    if (timer) return;
    const sinceLast = Date.now() - lastReport;
    const wait = sinceLast >= 5000 ? 100 : 5000 - sinceLast;
    timer = setTimeout(() => { timer = null; flush(); }, wait);
  };

  window.addEventListener("beforeunload", () => {
    if (pendingId) {
      const id = pendingId, t = pendingT;
      try {
        navigator.sendBeacon(
          `/api/history/${id}/progress`,
          new Blob([JSON.stringify({ progress_seconds: t })], { type: "application/json" })
        );
      } catch (e) { /* silent */ }
    }
  });
})();
