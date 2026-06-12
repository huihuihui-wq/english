// Main app - wires up all modules
const App = (() => {
  const settings = window.Storage.load();
  window.AppState = { settings };

  function init() {
    Uploader.init();
    if (window.LinkHandler) LinkHandler.init();
    Player.init();
    if (window.History) History.init();
    if (window.TTSTab) TTSTab.init();
    if (window.Vocab) Vocab.init();
    bindControls();
    applySettings();
    initQuotaWidget();
    initNativeLangSelector();
  }

  async function initNativeLangSelector() {
    const sel = document.getElementById("nativeLangSel");
    if (!sel) return;
    // Auto-detect on first run, but respect existing setting
    if (!settings.nativeLang || settings.nativeLang === "en") {
      const detected = window.NativeLang.detect();
      if (detected && detected !== settings.nativeLang) {
        settings.nativeLang = detected;
        Storage.save(settings);
        window.NativeLang.set(detected, { persistBackend: false });
      }
    }
    const langs = await window.NativeLang.load();
    sel.innerHTML = langs
      .map((l) => `<option value="${l.id}">${l.native || l.name}</option>`)
      .join("");
    sel.value = window.NativeLang.current();
    sel.addEventListener("change", (e) => {
      window.NativeLang.set(e.target.value);
    });
    window.NativeLang.onChange((lang) => {
      if (sel.value !== lang) sel.value = lang;
      if (window.Vocab && document.getElementById("tab-vocab") &&
          !document.getElementById("tab-vocab").classList.contains("hidden")) {
        window.Vocab.load();
      }
      if (window.showToast) {
        window.showToast(
          `🌐 Dictionary language: ${lang}`,
          "info",
          1800
        );
      }
    });
  }

  function applySettings() {
    setActiveSpeed(settings.speed);
    const transSel = document.getElementById("showTranslation");
    if (transSel && settings.targetLang) transSel.value = settings.targetLang;
  }

  function initQuotaWidget() {
    const btn = document.getElementById("quotaBtn");
    if (btn) {
      btn.classList.remove("hidden");
    }
  }

  window.updateQuotaWidget = function (quota) {
    // Quota display removed - button links directly to console instead
    // Kept as no-op to avoid breaking existing callers
  };

  function bindControls() {
    document.getElementById("speedGroup").addEventListener("click", (e) => {
      const btn = e.target.closest(".speed-btn");
      if (!btn) return;
      const rate = parseFloat(btn.dataset.rate);
      settings.speed = rate;
      Storage.save(settings);
      setActiveSpeed(rate);
      Player.setRate(rate);
    });

    async function ensureSubtitleTranslations(targetLang) {
      const subs = Player.getSubtitlesCopy ? Player.getSubtitlesCopy() : Player.getSubtitles() || [];
      if (!subs || subs.length === 0) {
        Player.reRenderSubtitles();
        showToast("⚠️ No subtitles to translate. Upload and transcribe a file first.", "warn", 3000);
        return;
      }

      const FIELD_MAP = {
        "Chinese": "zh", "Chinese-Traditional": "zh-TW",
        "Japanese": "ja", "Korean": "ko",
        "French": "fr", "German": "de", "Spanish": "es",
        "Portuguese": "pt", "Russian": "ru", "Italian": "it",
      };
      const field = FIELD_MAP[targetLang] || "zh";

      const needTranslate = subs
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => !s[field] || !String(s[field]).trim());

      const sel = document.getElementById("showTranslation");
      const targetName = sel?.selectedOptions[0]?.textContent || targetLang;

      if (sel) sel.disabled = true;

      if (needTranslate.length === 0) {
        if (window.Player && Player.setTranslationField) Player.setTranslationField(field);
        settings.targetLang = targetLang;
        Storage.save(settings);
        Player.reRenderSubtitles();
        showToast(`✅ ${subs.length} sentences translated to ${targetName}`, "success", 2500);
        if (sel) sel.disabled = false;
        return;
      }

      const sentences = needTranslate.map(({ s }) => s.en);
      const t0 = performance.now();
      const statusEl = document.getElementById("subtitleStatus");

      showProgress({
        title: "🌐 Translating",
        stage: "Preparing",
        detail: `Preparing to translate ${sentences.length} sentences into ${targetName}…`,
        percent: 5,
      });
      if (statusEl) {
        statusEl.textContent = `🌐 Translating (${sentences.length} sentences) → ${targetName}…`;
        statusEl.className = "subtitle-status loading";
      }

      let fakePercent = 5;
      const fakeTimer = setInterval(() => {
        if (fakePercent < 78) {
          fakePercent = Math.min(78, fakePercent + Math.random() * 8 + 3);
          showProgress({ percent: fakePercent });
        }
      }, 350);

      showProgress({ stage: "Calling translation model", detail: `Requesting DashScope translation for ${sentences.length} sentences…` });
      let resp;
      try {
        const sourceLang = subs[0]?.source_lang || window.AppState?.currentSourceLang || "en";
        resp = await fetch("/api/translate-subtitles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sentences, target_lang: targetLang, source_lang: sourceLang }),
        });
      } catch (netErr) {
        clearInterval(fakeTimer);
        hideProgress();
        showToast(`❌ Network error: ${netErr.message}`, "error", 5000);
        if (sel) sel.disabled = false;
        return;
      }

      if (!resp.ok) {
        clearInterval(fakeTimer);
        hideProgress();
        const err = await resp.json().catch(() => ({}));
        showToast(`❌ Translation failed: ${err.detail || `HTTP ${resp.status}`}`, "error", 5000);
        if (statusEl) {
          statusEl.textContent = `❌ Translation failed: ${err.detail || `HTTP ${resp.status}`}`;
          statusEl.className = "subtitle-status error";
        }
        if (sel) { sel.value = ""; settings.targetLang = ""; Storage.save(settings); }
        Player.reRenderSubtitles();
        if (sel) sel.disabled = false;
        return;
      }

      const data = await resp.json();
      const actualField = data.field || field;
      const translations = (data.translations || []).map((t) => {
        if (!t || typeof t !== "object") return "";
        const val = t[actualField];
        return typeof val === "string" ? val : "";
      });

      if (translations.length !== needTranslate.length) {
        console.warn(`[Translation] Response count mismatch ${translations.length} vs ${needTranslate.length}`);
      }
      const validTranslations = translations.filter((t) => t && t.trim()).length;
      if (validTranslations === 0) {
        clearInterval(fakeTimer);
        hideProgress();
        showToast(`❌ Translation service returned empty results, please retry later`, "error", 5000);
        if (sel) sel.disabled = false;
        return;
      }

      showProgress({ stage: "Writing subtitles", detail: `Updating ${validTranslations} subtitles…`, percent: 88 });
      if (window.Player && Player.setTranslationField) {
        Player.setTranslationField(actualField);
      }
      translations.forEach((text, k) => {
        const idx = needTranslate[k].i;
        if (Player.setSubtitleField) {
          Player.setSubtitleField(idx, actualField, text);
        } else if (Player.setSubtitleZh && actualField === "zh") {
          Player.setSubtitleZh(idx, text);
        } else {
          const allSubs = Player.getSubtitles();
          if (allSubs && allSubs[idx]) allSubs[idx][actualField] = text;
        }
      });

      const historyId = window.History && window.History.currentId;
      if (historyId) {
        try {
          await fetch(`/api/history/${historyId}/translations`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              field: actualField,
              target_lang: targetLang,
              translations,
            }),
          });
        } catch (e) {
          console.warn("[Translation] Failed to persist translations to history:", e);
        }
      }

      if (data.quota) {
        updateQuotaWidget(data.quota);
      }

      settings.targetLang = targetLang;
      Storage.save(settings);
      if (window.AppState) window.AppState.currentTranslationField = actualField;
      Player.reRenderSubtitles();

      clearInterval(fakeTimer);
      const cost = ((performance.now() - t0) / 1000).toFixed(1);
      showProgress({
        percent: 100,
        title: "✅ Translation complete",
        stage: "Done",
        detail: `${validTranslations}/${sentences.length} sentences translated to ${targetName} · ${cost}s`,
        duration: 1800,
      });
      showToast(
        `✅ Translation complete: ${validTranslations} sentences into ${targetName} (${cost}s)`,
        "success",
        3500
      );
      if (statusEl) {
        statusEl.textContent = `✅ Translated ${validTranslations}/${sentences.length} sentences into ${targetName} (${cost}s)`;
        statusEl.className = "subtitle-status success";
        setTimeout(() => {
          if (statusEl.textContent.startsWith("✅ Translated")) {
            statusEl.textContent = "";
            statusEl.className = "subtitle-status";
          }
        }, 5000);
      }
      console.log(`[Translation] Done: field=${actualField}, valid=${validTranslations}/${sentences.length}, time=${cost}s`);
      if (sel) sel.disabled = false;
    }

    async function loadTranslationTargets() {
      const sel = document.getElementById("showTranslation");
      if (!sel) return;
      try {
        const resp = await fetch("/api/translate/info");
        if (!resp.ok) return;
        const data = await resp.json();
        const langs = data.target_langs || [];
        const current = settings.targetLang || data.default || "";
        sel.innerHTML = '<option value="">No translation</option>' +
          langs.map((l) => {
            const id = (l && l.id) || l;
            const name = (l && l.name) || id;
            return `<option value="${id}" ${id === current ? "selected" : ""}>${name}</option>`;
          }).join("");
      } catch (e) {
        console.warn("[loadTranslationTargets] Failed to load", e);
      }
    }
    loadTranslationTargets();

    const showTransEl = document.getElementById("showTranslation");
    if (showTransEl) {
      showTransEl.addEventListener("change", async (e) => {
        const targetLang = e.target.value;
        settings.targetLang = targetLang;
        Storage.save(settings);

        if (targetLang) {
          await ensureSubtitleTranslations(targetLang);
        } else {
          if (window.Player && Player.setTranslationField) Player.setTranslationField("");
          Player.reRenderSubtitles();
        }
      });
    }

    document.getElementById("reloadBtn").addEventListener("click", () => {
      Player.pause();
      document.body.classList.remove("playing");
      document.getElementById("uploader").scrollIntoView({ behavior: "smooth" });
      document.getElementById("fileInput").click();
    });

    window.addEventListener("transcribe:done", (e) => {
      const { file, data } = e.detail;
      const firstSub = (data?.subtitles && data.subtitles[0]) || {};
      if (window.AppState) window.AppState.currentSourceLang = firstSub.source_lang || "en";
      Player.loadFile(file, data);
      Player.setRate(settings.speed);
      updateAlignmentBadge(data);
    });

    window.addEventListener("link:subtitles-loaded", (e) => {
      const data = e.detail || {};
      if (data) updateAlignmentBadge(data);
    });

    function updateAlignmentBadge(data) {
      const badge = document.getElementById("alignmentBadge");
      if (!badge) return;
      if (data.aligned) {
        badge.hidden = false;
        const isWav2Vec2 = data.alignment_source === "wav2vec2-ctc";
        badge.textContent = isWav2Vec2 ? "🎙️ wav2vec2 对齐" : "✓ 已对齐";
        badge.className = "alignment-badge aligned";
        badge.title = data.alignment_source
          ? `对齐源: ${data.alignment_source}\n词级时间戳由本地 CTC 模型生成`
          : "已对齐";
      } else {
        badge.hidden = true;
      }
    }

    document.getElementById("subtitleList").addEventListener("click", (e) => {
      const li = e.target.closest(".sub-item");
      if (!li) return;
      const idx = parseInt(li.dataset.idx, 10);
      Player.jumpToSentence(idx);
    });

    const mainTabs = document.getElementById("mainTabs");
    if (mainTabs) {
      mainTabs.addEventListener("click", (e) => {
        const btn = e.target.closest(".tab-btn");
        if (!btn) {
          console.log("[Tab] Clicked outside a tab button");
          return;
        }
        const tab = btn.dataset.tab;
        console.log(`[Tab] Switching to: ${tab}`);
        activateTab(tab);
      });
    } else {
      console.error("[Tab] #mainTabs element not found!");
    }

    document.addEventListener("keydown", onKey);
  }

  function activateTab(tabName) {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("hidden", panel.id !== "tab-" + tabName);
    });
    document.body.classList.toggle("tab-ai-active", tabName === "ai");
    if (tabName === "vocab" && window.Vocab && typeof window.Vocab.load === "function") {
      window.Vocab.load();
    }
    if (tabName === "ai" && window.AIAssistant && typeof window.AIAssistant.openPanel === "function") {
      window.AIAssistant.openPanel();
    }
  }

  function setActiveSpeed(rate) {
    document.querySelectorAll(".speed-btn").forEach((b) => {
      b.classList.toggle("active", parseFloat(b.dataset.rate) === rate);
    });
  }

  function onKey(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (!document.getElementById("video").src) return;
    switch (e.key) {
      case " ":
        e.preventDefault();
        Player.togglePlay();
        break;
      case "ArrowLeft":
        e.preventDefault();
        Player.goPrev();
        break;
      case "ArrowRight":
        e.preventDefault();
        Player.goNext();
        break;
      case "r":
      case "R":
        e.preventDefault();
        Player.replayCurrent();
        break;
      case "1": setSpeed(0.5); break;
      case "2": setSpeed(0.75); break;
      case "3": setSpeed(1); break;
      case "4": setSpeed(1.25); break;
      case "5": setSpeed(1.5); break;
      case "6": setSpeed(2); break;
      case "0": setSpeed(1); break;
    }
  }

  function setSpeed(r) {
    settings.speed = r;
    Player.setRate(r);
    setActiveSpeed(r);
    Storage.save(settings);
  }

  let pendingHistoryRecord = null;
  let reselectHandler = null;

  function reselectForHistory(rec) {
    pendingHistoryRecord = rec;
    const input = document.getElementById("fileInput");
    if (!input) return;
    if (reselectHandler) {
      input.removeEventListener("change", reselectHandler);
    }
    reselectHandler = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.name !== rec.source || f.size !== rec.size_bytes) {
        const ok = confirm(
          `Selected file does not match the history record (expected: ${rec.source}, ${(rec.size_bytes/1024/1024).toFixed(2)}MB).\n\n` +
          `Use it anyway and reuse the historical subtitles?`
        );
        if (!ok) {
          input.value = "";
          return;
        }
      }
      const data = {
        subtitles: rec.subtitles || [],
        duration: rec.duration || 0,
        raw_text: rec.raw_text || "",
      };
      Player.loadFile(f, data);
      if (rec.progress_seconds && rec.progress_seconds > 1) {
        setTimeout(() => Player.seekTo(rec.progress_seconds), 300);
      }
      if (window.History) {
        try { window.History.currentId = rec.id; } catch (e) {}
      }
      input.removeEventListener("change", reselectHandler);
      reselectHandler = null;
      pendingHistoryRecord = null;
      input.value = "";
    };
    input.addEventListener("change", reselectHandler);
    input.click();
  }

  return { init, reselectForHistory, activateTab };
})();

document.addEventListener("DOMContentLoaded", App.init);
window.App = App;

function showProgress({ title, stage, detail, percent, duration }) {
  let el = document.getElementById("global-progress");
  if (!el) {
    el = document.createElement("div");
    el.id = "global-progress";
    el.innerHTML = `
      <div class="gp-card">
        <div class="gp-header">
          <span class="gp-title"></span>
          <span class="gp-percent"></span>
        </div>
        <div class="gp-stage"></div>
        <div class="gp-bar"><div class="gp-fill"></div></div>
        <div class="gp-detail"></div>
      </div>
    `;
    document.body.appendChild(el);
  }
  el.style.display = "block";
  if (title != null) el.querySelector(".gp-title").textContent = title;
  if (stage != null) el.querySelector(".gp-stage").textContent = stage;
  if (detail != null) el.querySelector(".gp-detail").textContent = detail;
  if (percent != null) {
    el.querySelector(".gp-percent").textContent = Math.round(percent) + "%";
    el.querySelector(".gp-fill").style.width = Math.min(100, Math.max(0, percent)) + "%";
  }
  if (duration) {
    setTimeout(() => hideProgress(), duration);
  }
}

function hideProgress() {
  const el = document.getElementById("global-progress");
  if (el) el.style.display = "none";
}

function showToast(message, type = "info", duration = 3000) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 350);
  }, duration);
}
