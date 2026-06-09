/** 历史记录面板 - 列出/打开/删除历史 */
const History = (() => {
  let listEl, subEl, refreshBtn;
  let items = [];
  let currentId = null;

  function init() {
    listEl = document.getElementById("historyList");
    subEl = document.getElementById("historySub");
    refreshBtn = document.getElementById("historyRefreshBtn");

    refreshBtn.addEventListener("click", load);

    // 监听 tab 切换
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener("click", (e) => {
        if (btn.dataset.tab === "history") {
          load();
        }
      });
    });
  }

  async function load() {
    if (!listEl) return;
    subEl.textContent = "正在加载…";
    listEl.innerHTML = `<div class="history-empty">加载中…</div>`;
    try {
      const resp = await fetch("/api/history");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      items = data.items || [];
      render();
    } catch (err) {
      subEl.textContent = "加载失败";
      listEl.innerHTML = `<div class="history-empty">❌ ${err.message}</div>`;
    }
  }

  /** 保存/更新一条历史记录（转写完成后调用） */
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
      return data.id;
    } catch (e) {
      console.warn("[History.save] 失败:", e);
      return null;
    }
  }

  /** 即时上报进度（节流，详见 HistoryReportProgress） */
  function reportProgress(id, t) {
    if (window.HistoryReportProgress) window.HistoryReportProgress(id, t);
  }

  function render() {
    if (!items.length) {
      subEl.textContent = "还没有历史记录。上传视频或加载在线视频后会自动出现在这里。";
      listEl.innerHTML = `<div class="history-empty">📂 暂无历史记录</div>`;
      return;
    }
    subEl.textContent = `共 ${items.length} 条记录`;

    listEl.innerHTML = "";
    items.forEach(item => {
      const card = document.createElement("div");
      card.className = "history-item";
      card.dataset.id = item.id;

      const typeLabel = {
        local: "📁 本地上传",
        youtube: "▶️ YouTube",
        online_url: "🔗 在线视频",
      }[item.type] || "📄 其他";

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
            <span>${item.subtitle_count || 0} 句</span>
            <span>·</span>
            <span title="${escapeHtml(item.last_opened || "")}">${formatRelative(item.last_opened || item.created_at)}</span>
            ${item.open_count > 1 ? `<span>·</span><span>打开 ${item.open_count} 次</span>` : ""}
          </div>
          <div class="hi-progress">
            <div class="hi-progress-bar"><div class="hi-progress-fill" style="width:${progressPct}%"></div></div>
            <span class="hi-progress-text">${formatDuration(item.progress_seconds || 0)} / ${formatDuration(item.duration || 0)}</span>
          </div>
        </div>
        <div class="hi-actions">
          <button class="btn primary hi-open">${item.progress_seconds > 1 ? "▶ 继续" : "▶ 打开"}</button>
          <button class="btn ghost hi-delete" title="删除">✕</button>
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
    // 切换到影子跟读 tab
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

      // 分发加载
      if (rec.type === "youtube") {
        // 在线 YouTube 链接：直接用 Player.loadVideo 加载
        if (window.Player && window.Player.loadVideo) {
          const url = `https://www.youtube.com/watch?v=${rec.source}`;
          Player.loadVideo(url, {
            subtitles: rec.subtitles || [],
            duration: rec.duration || 0,
            title: rec.title,
          });
          // 恢复进度
          if (rec.progress_seconds > 1) {
            // YouTube iframe 不能用 currentTime 直接跳，但先记录
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
        // 本地文件：原始文件不会保留在服务器。需要用户重新选择文件。
        // 但可以先把字幕和进度信息预先填入页面。
        alert(
          `本地文件 "${rec.title}" 已被清理（仅保留字幕与进度）。\n\n` +
          `请重新选择该文件，系统会自动应用上次的字幕与进度。`
        );
        // 触发重选
        if (window.App && window.App.reselectForHistory) {
          App.reselectForHistory(rec);
        } else {
          document.getElementById("reloadBtn").click();
        }
      }
    } catch (err) {
      alert("打开历史记录失败: " + err.message);
    }
  }

  async function deleteItem(item) {
    if (!confirm(`确认删除历史记录 "${item.title}" ？`)) return;
    try {
      const resp = await fetch(`/api/history/${item.id}`, { method: "DELETE" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      await load();
    } catch (err) {
      alert("删除失败: " + err.message);
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
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
    return new Date(iso).toLocaleDateString("zh-CN");
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  return {
    init, load, save, reportProgress,
    get currentId() { return currentId; },
    set currentId(v) { currentId = v; },
  };
})();

window.History = History;

/* ========== 进度上报（节流） ========== */
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
    } catch (e) { /* 静默 */ }
  }

  // 暴露给外部：节流上报
  window.HistoryReportProgress = function (id, t) {
    if (!id) return;
    pendingId = id;
    pendingT = t;
    if (timer) return;
    const sinceLast = Date.now() - lastReport;
    const wait = sinceLast >= 5000 ? 100 : 5000 - sinceLast;
    timer = setTimeout(() => { timer = null; flush(); }, wait);
  };

  // 关闭/卸载前 flush
  window.addEventListener("beforeunload", () => {
    if (pendingId) {
      const id = pendingId, t = pendingT;
      try {
        navigator.sendBeacon(
          `/api/history/${id}/progress`,
          new Blob([JSON.stringify({ progress_seconds: t })], { type: "application/json" })
        );
      } catch (e) { /* 静默 */ }
    }
  });
})();

