// Settings panel - API key input and quota configuration
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  let currentHasKey = false;
  let currentMasked = "";
  let apiKeyVisible = false;

  function open() {
    const modal = $("settingsModal");
    if (!modal) return;
    modal.hidden = false;
    loadAndFill();
  }
  function close() {
    const modal = $("settingsModal");
    if (modal) modal.hidden = true;
  }

  function updateStatusCard(status, title, desc) {
    const card = $("apiKeyStatusCard");
    const icon = $("apiKeyStatusIcon");
    const t = $("apiKeyStatusTitle");
    const d = $("apiKeyStatusDesc");
    const label = $("apiKeyLabel");
    const input = $("cfgApiKey");
    const hint = $("apiKeyHint");

    if (card) {
      card.className = "api-key-status-card status-" + status;
    }
    if (icon) icon.textContent = status === "ok" ? "✅" : status === "missing" ? "⚠️" : "⏳";
    if (t) t.textContent = title;
    if (d) d.textContent = desc;

    if (label) {
      label.textContent = currentHasKey
        ? `DashScope API Key (configured: ${currentMasked})`
        : "DashScope API Key";
    }
    if (input) {
      input.placeholder = currentHasKey
        ? "Enter a new key to replace the current one…"
        : "sk-xxxxxxxxxxxxxxxxxxxxxxxx";
    }
    if (hint) {
      hint.innerHTML = currentHasKey
        ? `💡 The backend already has a saved key. Enter a new value to overwrite it, or click "Clear key" to remove it.`
        : `💡 No key? Get one at the <a href="https://bailian.console.aliyun.com/" target="_blank" rel="noopener">DashScope console</a>.<br>An API key is required for AI transcription and translation.`;
    }
  }

  async function loadAndFill() {
    updateStatusCard("checking", "Checking…", "Verifying API key configuration");
    showStatus("", "info");

    try {
      const r = await fetch("/api/config");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      currentHasKey = !!data.has_api_key;
      currentMasked = data.DASHSCOPE_API_KEY || "";

      if (currentHasKey) {
        updateStatusCard(
          "ok",
          "API Key configured",
          `${currentMasked} · AI features available`
        );
      } else {
        updateStatusCard(
          "missing",
          "API Key not configured",
          "AI transcription and translation require an API key to work"
        );
      }
      fillForm(data);
    } catch (e) {
      updateStatusCard("missing", "Check failed", e.message);
      showStatus("Failed to load config: " + e.message, "error");
    }
  }

  function fillForm(data) {
    const input = $("cfgApiKey");
    if (currentHasKey && currentMasked) {
      input.value = currentMasked;
      input.dataset.masked = "1";
    } else {
      input.value = "";
      delete input.dataset.masked;
    }
    // Normalize server "Chinese" / "Japanese" / etc. -> our dropdown codes
    const dictLang = normalizeDictLang(data?.DICT_LANG);
    const dictLangSel = $("cfgDictLang");
    if (dictLangSel) dictLangSel.value = dictLang;
    const translateSel = $("cfgTranslateModel");
    if (translateSel) translateSel.value = data?.TRANSLATE_MODEL || "qwen-turbo";
    const wordSel = $("cfgWordModel");
    if (wordSel) wordSel.value = data?.WORD_LLM_MODEL || "qwen-flash";

    const asrSel = $("cfgAsrModel");
    if (asrSel) asrSel.value = data?.ASR_MODEL || "qwen3-asr-flash";

    // Subtitle offset (client-side setting, persisted via window.Storage)
    const offsetSlider = $("cfgSubtitleOffset");
    const offsetValue = $("cfgSubtitleOffsetValue");
    if (offsetSlider) {
      const cur = (window.AppState && window.AppState.settings && parseFloat(window.AppState.settings.subtitleOffset)) || 0;
      offsetSlider.value = String(cur);
      if (offsetValue) offsetValue.textContent = `${cur >= 0 ? '+' : ''}${cur.toFixed(1)}s`;
      offsetSlider.oninput = () => {
        const v = parseFloat(offsetSlider.value);
        if (offsetValue) offsetValue.textContent = `${v >= 0 ? '+' : ''}${v.toFixed(1)}s`;
        if (window.AppState && window.AppState.settings) {
          window.AppState.settings.subtitleOffset = v;
        }
        if (window.Storage) {
          const s = window.Storage.load();
          s.subtitleOffset = v;
          window.Storage.save(s);
        }
      };
    }

    // Cloud word-level timestamps indicator (no local model needed)
    initAsrModelControl(data);

    // Defer cost fetch so DOM is settled
    setTimeout(refreshCostEstimate, 0);
  }

  async function initAsrModelControl(data) {
    const asrSel = $("cfgAsrModel");
    const statusEl = $("cfgAlignerStatus");
    if (!asrSel || !statusEl) return;

    statusEl.className = "aligner-status ok";
    statusEl.textContent = "☁️ Enabled";

    asrSel.onchange = async () => {
      const v = asrSel.value;
      try {
        const r = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ASR_MODEL: v }),
        });
        if (r.ok) {
          showStatus("ASR model updated: " + v, "success", 1800);
        } else {
          showStatus("Failed to save ASR model", "error");
        }
      } catch (e) {
        showStatus("Failed to save ASR model: " + e.message, "error");
      }
    };
  }

  // Server stores target languages as display names ("Chinese", "Japanese", ...).
  // Settings UI uses 2-letter codes; map between them.
  const DICT_LANG_DISPLAY_TO_CODE = {
    "English": "en", "Chinese": "zh", "Japanese": "ja", "Korean": "ko",
    "French": "fr", "German": "de", "Spanish": "es", "Portuguese": "pt",
    "Russian": "ru", "Italian": "it",
  };
  function normalizeDictLang(v) {
    if (!v) return "en";
    if (/^[a-z]{2}$/.test(v)) return v;
    return DICT_LANG_DISPLAY_TO_CODE[v] || "en";
  }

  async function save() {
    const input = $("cfgApiKey");
    const isMasked = input.dataset.masked === "1";
    const rawValue = input.value.trim();
    const newKey = isMasked ? "" : rawValue;
    const dictLang = $("cfgDictLang")?.value || "en";
    const translateModel = $("cfgTranslateModel")?.value || "qwen-turbo";
    const wordModel = $("cfgWordModel")?.value || "qwen-flash";
    const asrModel = $("cfgAsrModel")?.value || "qwen3-asr-flash";
    let savedAny = false;

    try {
      const dr = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          DICT_LANG: dictLang,
          TRANSLATE_MODEL: translateModel,
          WORD_LLM_MODEL: wordModel,
          ASR_MODEL: asrModel,
        }),
      });
      if (dr.ok) {
        savedAny = true;
        const j = await dr.json();
        fillForm(j);
      }
    } catch (e) {
      console.warn("[Settings] Failed to save settings:", e);
    }

    if (!newKey) {
      if (currentHasKey) {
        if (savedAny) {
          showStatus("✅ Settings saved", "success");
        } else {
          showStatus("ℹ️ No new key entered. Existing config remains unchanged.", "info");
        }
        // Reflect dict lang change in the topbar selector too
        if (window.NativeLang && window.NativeLang.set) {
          window.NativeLang.set(dictLang, { persistBackend: false });
        }
        return;
      }
      showStatus("⚠️ Please enter an API key", "error");
      $("cfgApiKey").focus();
      return;
    }

    if (!newKey.startsWith("sk-")) {
      if (!confirm("API keys usually start with 'sk-'. Submit anyway?")) return;
    }

    showStatus("Saving…", "info");
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          DASHSCOPE_API_KEY: newKey,
          DICT_LANG: dictLang,
          TRANSLATE_MODEL: translateModel,
          WORD_LLM_MODEL: wordModel,
          ASR_MODEL: asrModel,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);

      currentHasKey = j.has_api_key;
      currentMasked = j.DASHSCOPE_API_KEY || "";

      if (j.has_api_key) {
        updateStatusCard("ok", "API Key configured", `${currentMasked} · AI features available`);
        showStatus("✅ API key and settings saved", "success");
      } else {
        updateStatusCard("missing", "Key still not detected after save", "Please check the key");
        showStatus("❌ Save failed, please retry", "error");
      }
      const savedInput = $("cfgApiKey");
      if (j.has_api_key && currentMasked) {
        savedInput.value = currentMasked;
        savedInput.dataset.masked = "1";
      } else {
        savedInput.value = "";
        delete savedInput.dataset.masked;
      }
      fillForm(j);
      notifyKeyStatus(j.has_api_key);
      await checkAndBanner();
    } catch (e) {
      showStatus("❌ Save failed: " + e.message, "error");
    }
  }

  async function clearKey() {
    if (!currentHasKey) {
      showStatus("ℹ️ No API key is currently configured", "info");
      return;
    }
    if (!confirm("Clear the API key?\n\nAI transcription and translation will stop working.")) {
      return;
    }
    showStatus("Clearing…", "info");
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ DASHSCOPE_API_KEY: "" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);

      currentHasKey = false;
      currentMasked = "";
      updateStatusCard("missing", "API Key not configured", "AI transcription and translation require an API key");
      showStatus("✅ API key cleared", "success");
      const clearedInput = $("cfgApiKey");
      clearedInput.value = "";
      delete clearedInput.dataset.masked;
      fillForm({});
      notifyKeyStatus(false);
      await checkAndBanner();
    } catch (e) {
      showStatus("❌ Clear failed: " + e.message, "error");
    }
  }

  async function testConnection() {
    const inputKey = $("cfgApiKey").value.trim();

    if (!currentHasKey && !inputKey) {
      showStatus("⚠️ Please enter an API key first", "error");
      $("cfgApiKey").focus();
      return;
    }

    if (inputKey && !currentHasKey) {
      const shouldSave = confirm("An unsaved API key is detected in the input.\n\nSave it before testing? (Otherwise the previously saved key will be used.)");
      if (shouldSave) {
        await save();
        return;
      }
    }

    showStatus("Testing TTS…", "info");
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello, your DashScope API key is working.", voice: "Cherry", language_type: "English" }),
      });
      if (r.status === 200) {
        const size = parseInt(r.headers.get("X-Audio-Size") || "0");
        showStatus(`✅ Connection successful! TTS returned ${(size / 1024).toFixed(1)}KB audio.`, "success");
      } else {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
    } catch (e) {
      showStatus("❌ Test failed: " + e.message, "error");
    }
  }

  function showStatus(text, type) {
    const el = $("settingsStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "settings-status visible " + (type || "info");
  }

  function notifyKeyStatus(hasKey) {
    if (window.App && typeof window.App.onApiKeyStatusChange === "function") {
      window.App.onApiKeyStatusChange(hasKey);
    }
  }

  async function checkAndBanner() {
    try {
      const r = await fetch("/api/config");
      if (!r.ok) return;
      const j = await r.json();
      const hasKey = !!j.has_api_key;
      currentHasKey = hasKey;
      currentMasked = j.DASHSCOPE_API_KEY || "";

      const btn = $("settingsBtn");
      if (btn) {
        btn.classList.toggle("api-key-missing", !hasKey);
        btn.title = hasKey
          ? `Settings (configured: ${currentMasked})`
          : "⚠️ API key missing - click to configure";
      }

      if (!hasKey) {
        showGlobalBanner();
      } else {
        const existing = document.getElementById("apiKeyBanner");
        if (existing) existing.remove();
      }
      return hasKey;
    } catch (e) {
      console.warn("[Settings] Failed to check API key status:", e);
    }
  }

  function showGlobalBanner() {
    if (document.getElementById("apiKeyBanner")) return;
    const banner = document.createElement("div");
    banner.id = "apiKeyBanner";
    banner.className = "global-banner";
    banner.innerHTML = `
      <span>⚠️ No API key detected. AI transcription and translation are unavailable.</span>
      <button id="apiKeyBannerBtn">⚙️ Configure now</button>
      <button class="dismiss" id="apiKeyBannerDismiss" title="Dismiss">✕</button>
    `;
    const tabbar = document.getElementById("mainTabs");
    if (tabbar && tabbar.parentNode) {
      tabbar.parentNode.insertBefore(banner, tabbar);
    } else {
      document.body.insertBefore(banner, document.body.firstChild);
    }
    $("apiKeyBannerBtn").addEventListener("click", open);
    $("apiKeyBannerDismiss").addEventListener("click", () => banner.remove());
  }

  async function refreshCostEstimate() {
    const dailyEl = $("costDaily");
    const plusEl = $("costPlus");
    const saveEl = $("costSave");
    const cacheEl = $("costCache");
    if (!dailyEl) return;
    dailyEl.textContent = "…";
    try {
      const r = await fetch("/api/cost/estimate");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const cur = d.current_setup || {};
      const base = d.baseline_qwen_plus || {};
      const sv = d.savings || {};
      const tc = d.trans_cache || {};
      dailyEl.textContent = `¥${(cur.daily_cost_cny || 0).toFixed(4)}`;
      plusEl.textContent = `¥${(base.daily_cost_cny || 0).toFixed(4)}`;
      saveEl.textContent = `¥${(sv.daily_cny || 0).toFixed(4)}/day  (${(sv.speedup_x || 1).toFixed(1)}x faster, ${(sv.daily_latency_s || 0).toFixed(1)}s saved)`;
      cacheEl.textContent = `${tc.disk_files || 0} cached sentences · ${(d.cumulative_savings_from_cache_cny || 0).toFixed(2)} CNY saved cumulatively`;
    } catch (e) {
      dailyEl.textContent = "—";
      if (plusEl) plusEl.textContent = "—";
      if (saveEl) saveEl.textContent = "—";
      if (cacheEl) cacheEl.textContent = `(${e.message})`;
    }
  }

  async function clearTransCache() {
    if (!confirm("Clear the subtitle translation cache?\n\nThis forces all subtitles to be re-translated on next request. Useful if you want to switch model and re-evaluate quality.")) return;
    try {
      const r = await fetch("/api/cache/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "trans" }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      showStatus(`✅ Cleared ${data.cleared.trans} cached sentences`, "success");
      refreshCostEstimate();
    } catch (e) {
      showStatus("❌ Clear failed: " + e.message, "error");
    }
  }

  function init() {
    const btn = $("settingsBtn");
    if (btn) btn.addEventListener("click", open);
    const closeBtn = $("settingsClose");
    if (closeBtn) closeBtn.addEventListener("click", close);
    const saveBtn = $("settingsSaveBtn");
    if (saveBtn) saveBtn.addEventListener("click", save);
    const clearBtn = $("settingsClearBtn");
    if (clearBtn) clearBtn.addEventListener("click", clearKey);
    const testBtn = $("settingsTestBtn");
    if (testBtn) testBtn.addEventListener("click", testConnection);
    const toggle = $("cfgApiKeyToggle");
    if (toggle) {
      toggle.addEventListener("click", () => {
        apiKeyVisible = !apiKeyVisible;
        $("cfgApiKey").type = apiKeyVisible ? "text" : "password";
        toggle.textContent = apiKeyVisible ? "🙈" : "👁";
      });
    }
    const modal = $("settingsModal");
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal && !modal.hidden) close();
    });
    const input = $("cfgApiKey");
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        }
      });
      input.addEventListener("input", () => {
        if (input.dataset.masked === "1") {
          delete input.dataset.masked;
        }
      });
    }
    const clearTransBtn = $("settingsClearTransCacheBtn");
    if (clearTransBtn) clearTransBtn.addEventListener("click", clearTransCache);
    const refreshBtn = $("settingsRefreshCostBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshCostEstimate);
    checkAndBanner();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.Settings = { open, close, checkAndBanner };
})();
