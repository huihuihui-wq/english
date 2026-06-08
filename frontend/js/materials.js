// 内置素材库 + 每日更新 tab
const Materials = (() => {
  let grid, dailyGrid, sub;
  let currentTab = "library";

  async function init() {
    grid = document.getElementById("materialsGrid");
    dailyGrid = document.getElementById("dailyGrid");
    sub = document.getElementById("materialsSub");
    if (!grid) return;

    bindTabs();
    await loadLibrary();
    await loadDaily();
  }

  function bindTabs() {
    document.querySelectorAll(".mat-tab").forEach((tab) => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });
  }

  function switchTab(name) {
    currentTab = name;
    document.querySelectorAll(".mat-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    grid.hidden = name !== "library";
    dailyGrid.hidden = name !== "daily";
  }

  async function loadLibrary() {
    try {
      const resp = await fetch("/api/materials");
      const data = await resp.json();
      render(grid, data.materials || [], false);
      const daily = (data.materials || []).filter((m) => m.date);
      if (sub) {
        const dailyCount = daily.length;
        sub.textContent = `共 ${data.total} 个素材${dailyCount > 0 ? ` · 🆕 每日 ${dailyCount} 条` : ""} · 更新 ${data.updated || "—"}`;
      }
    } catch (e) {
      grid.innerHTML = `<div class="materials-empty">素材加载失败: ${e.message}</div>`;
    }
  }

  async function loadDaily() {
    // 每日素材也走 /api/materials，靠 item.date 区分
    try {
      const resp = await fetch("/api/materials?category=BBC%20News");
      const data = await resp.json();
      const items = (data.materials || []).filter((m) => m.date);
      if (items.length === 0) {
        // 保留默认 empty 提示
        return;
      }
      render(dailyGrid, items, true);
    } catch (e) {
      dailyGrid.innerHTML = `<div class="materials-empty">每日素材加载失败: ${e.message}</div>`;
    }
  }

  function render(container, items, isDaily) {
    if (!items.length) {
      container.innerHTML = `<div class="materials-empty">${isDaily ? "暂无每日更新。GitHub Actions 每天 03:00 UTC 抓取 BBC Learning English。" : "暂无可用素材"}</div>`;
      return;
    }
    container.innerHTML = "";
    items.forEach((m) => {
      const el = document.createElement("div");
      el.className = "material-item";
      el.dataset.id = m.id;
      el.innerHTML = `
        <div class="mat-icon" style="background:${m.color || "#4f8cff"}">${m.icon || m.id.slice(0, 2).toUpperCase()}</div>
        <div class="mat-title">${escapeHtml(m.title)}</div>
        <div class="mat-desc">${escapeHtml(m.description || "")}</div>
        <div class="mat-meta">
          <span class="mat-tag">${escapeHtml(m.category || "")}</span>
          <span class="mat-tag diff-${m.difficulty || "beginner"}">${difficultyLabel(m.difficulty)}</span>
          <span class="mat-tag">${m.speed || 1}x</span>
        </div>
        ${m.date ? `<div class="mat-date">📅 ${m.date}</div>` : ""}
        ${m.source ? `<div class="mat-source">来源: ${escapeHtml(m.source)}</div>` : ""}
        <div class="mat-loading">加载中…</div>
      `;
      el.addEventListener("click", () => select(el, m));
      container.appendChild(el);
    });
  }

  async function select(el, m) {
    if (el.classList.contains("loading")) return;
    el.classList.add("loading");
    console.log(`[素材] 加载: ${m.title} (${m.id})`);
    try {
      const resp = await fetch(`/api/materials/${m.id}/full`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${resp.status}`);
      }
      const data = await resp.json();

      const audioResp = await fetch(m.audio_url);
      if (!audioResp.ok) throw new Error(`音频下载失败: ${audioResp.status}`);
      const audioBlob = await audioResp.blob();
      const fileName = `${m.id}.mp3`;
      const file = new File([audioBlob], fileName, { type: "audio/mpeg" });

      const subs = (data.subtitles || []).map((s) => ({
        start: s.start,
        end: s.end,
        en: s.en,
        zh: s.zh || "",
      }));

      const fakeData = {
        duration: data.duration || (subs.length ? subs[subs.length - 1].end : 0),
        subtitles: subs,
        raw_text: subs.map((s) => s.en).join(" "),
      };

      window.dispatchEvent(
        new CustomEvent("transcribe:done", { detail: { file, data: fakeData } })
      );

      setTimeout(() => {
        document.getElementById("playerCard").scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);

      if (m.speed && window.Player && window.AppState) {
        const speedBtn = document.querySelector(`.speed-btn[data-rate="${m.speed}"]`);
        if (speedBtn) speedBtn.click();
      }

      console.log(`[素材] 加载完成: ${subs.length} 句字幕`);
    } catch (e) {
      alert(`素材加载失败: ${e.message}`);
      console.error(e);
    } finally {
      el.classList.remove("loading");
    }
  }

  function difficultyLabel(d) {
    return { beginner: "入门", intermediate: "中级", advanced: "高级" }[d] || d || "";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  return { init, load: loadLibrary };
})();

window.Materials = Materials;
