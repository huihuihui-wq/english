// 主应用 - 装配所有模块
const App = (() => {
  const settings = window.Storage.load();
  window.AppState = { settings };

  function init() {
    Uploader.init();
    if (window.LinkHandler) LinkHandler.init();
    Player.init();
    if (window.AIAssistant) AIAssistant.init();
    if (window.History) History.init();
    bindControls();
    applySettings();
  }

  function applySettings() {
    setActiveSpeed(settings.speed);
    document.getElementById("loopCount").textContent = settings.loopCount;
    document.getElementById("pauseCount").textContent = settings.pauseSec;
    document.getElementById("autoReplay").checked = settings.autoReplay;
    document.getElementById("showZh").checked = settings.showZh;
    Shadow.setLoopCount(settings.loopCount);
    Shadow.setPauseSec(settings.pauseSec);
    Shadow.setEnabled(settings.autoReplay);
    updateShadowControlsState();
  }

  function updateShadowControlsState() {
    const controls = document.getElementById("shadowControls");
    if (!controls) return;
    const enabled = settings.autoReplay;
    controls.classList.toggle("disabled", !enabled);
    console.log(`[跟读模式] ${enabled ? "✅ 已启用" : "❌ 未启用（循环/停顿按钮已变灰）"}`);
  }

  function bindControls() {
    // 倍速按钮
    document.getElementById("speedGroup").addEventListener("click", (e) => {
      const btn = e.target.closest(".speed-btn");
      if (!btn) return;
      const rate = parseFloat(btn.dataset.rate);
      settings.speed = rate;
      Storage.save(settings);
      setActiveSpeed(rate);
      Player.setRate(rate);
    });

    // 循环次数 +/-（点击时若未启用跟读模式，自动启用）
    function ensureAutoReplay() {
      if (!settings.autoReplay) {
        settings.autoReplay = true;
        document.getElementById("autoReplay").checked = true;
        Shadow.setEnabled(true);
        Storage.save(settings);
        updateShadowControlsState();
        console.log("[跟读模式] 已自动启用");
      }
    }

    document.getElementById("loopPlus").addEventListener("click", () => {
      const v = Math.min(10, settings.loopCount + 1);
      settings.loopCount = v;
      Shadow.setLoopCount(v);
      document.getElementById("loopCount").textContent = v;
      Storage.save(settings);
      ensureAutoReplay();
    });
    document.getElementById("loopMinus").addEventListener("click", () => {
      const v = Math.max(1, settings.loopCount - 1);
      settings.loopCount = v;
      Shadow.setLoopCount(v);
      document.getElementById("loopCount").textContent = v;
      Storage.save(settings);
      ensureAutoReplay();
    });

    // 停顿时长 +/-
    document.getElementById("pausePlus").addEventListener("click", () => {
      const v = Math.min(10, settings.pauseSec + 1);
      settings.pauseSec = v;
      Shadow.setPauseSec(v);
      document.getElementById("pauseCount").textContent = v;
      Storage.save(settings);
      ensureAutoReplay();
    });
    document.getElementById("pauseMinus").addEventListener("click", () => {
      const v = Math.max(0, settings.pauseSec - 1);
      settings.pauseSec = v;
      Shadow.setPauseSec(v);
      document.getElementById("pauseCount").textContent = v;
      Storage.save(settings);
      ensureAutoReplay();
    });

    // 跟读模式开关
    document.getElementById("autoReplay").addEventListener("change", (e) => {
      settings.autoReplay = e.target.checked;
      Shadow.setEnabled(e.target.checked);
      Storage.save(settings);
      updateShadowControlsState();
      console.log(`[跟读模式] 切换为: ${e.target.checked ? "✅ 启用" : "❌ 关闭"}`);
      // 开启时自动开始跟读
      if (e.target.checked) {
        const subs = Player.getSubtitles();
        if (subs.length > 0) {
          const startIdx = Math.max(0, Player.getCurrent());
          Shadow.start(startIdx);
          console.log(`[跟读模式] 从第 ${startIdx + 1} 句开始自动循环`);
        } else {
          console.log(`[跟读模式] 暂无可用字幕，请先上传并转写文件`);
        }
      }
    });

    // 显示中文开关
    document.getElementById("showZh").addEventListener("change", async (e) => {
      const checked = e.target.checked;
      settings.showZh = checked;
      Storage.save(settings);

      if (checked) {
        await ensureSubtitleTranslations();
      } else {
        Player.reRenderSubtitles();
      }
    });

    async function ensureSubtitleTranslations() {
      const subs = Player.getSubtitlesCopy ? Player.getSubtitlesCopy() : Player.getSubtitles() || [];
      if (!subs || subs.length === 0) {
        Player.reRenderSubtitles();
        return;
      }

      const needTranslate = subs
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => !s.zh || !s.zh.trim());

      if (needTranslate.length === 0) {
        Player.reRenderSubtitles();
        return;
      }

      const sentences = needTranslate.map(({ s }) => s.en);
      const statusEl = document.getElementById("subtitleStatus");
      const originalStatusHtml = statusEl ? statusEl.innerHTML : "";
      const originalStatusCls = statusEl ? statusEl.className : "";

      if (statusEl) {
        statusEl.textContent = `🌐 正在翻译 ${sentences.length} 句为中文…`;
        statusEl.className = "subtitle-status loading";
      }

      const checkbox = document.getElementById("showZh");
      if (checkbox) checkbox.disabled = true;

      try {
        const resp = await fetch("/api/translate-subtitles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sentences }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${resp.status}`);
        }

        const data = await resp.json();
        const translations = (data.translations || []).map((t) => (t && t.zh) || "");

        if (translations.length !== needTranslate.length) {
          console.warn("[showZh] 翻译返回数量不匹配", translations.length, "vs", needTranslate.length);
        }

        translations.forEach((zh, k) => {
          const idx = needTranslate[k].i;
          if (Player.setSubtitleZh) Player.setSubtitleZh(idx, zh);
        });

        Player.reRenderSubtitles();

        if (statusEl) {
          statusEl.textContent = `✅ 已翻译 ${translations.length} 句中文`;
          statusEl.className = "subtitle-status success";
          setTimeout(() => {
            if (statusEl.textContent.startsWith("✅ 已翻译")) {
              statusEl.innerHTML = originalStatusHtml;
              statusEl.className = originalStatusCls;
            }
          }, 2500);
        }
      } catch (err) {
        console.error("[showZh] 翻译失败", err);
        if (statusEl) {
          statusEl.textContent = `❌ 翻译失败: ${err.message}`;
          statusEl.className = "subtitle-status error";
        }
        if (checkbox) {
          checkbox.checked = false;
          settings.showZh = false;
          Storage.save(settings);
        }
        Player.reRenderSubtitles();
      } finally {
        if (checkbox) checkbox.disabled = false;
      }
    }

    // 重选文件
    document.getElementById("reloadBtn").addEventListener("click", () => {
      Shadow.abort();
      Player.pause();
      document.body.classList.remove("playing");
      document.getElementById("uploader").scrollIntoView({ behavior: "smooth" });
      document.getElementById("fileInput").click();
    });

    // 转写完成事件
    window.addEventListener("transcribe:done", (e) => {
      const { file, data } = e.detail;
      Player.loadFile(file, data);
      Player.setRate(settings.speed);
      // 自动开启跟读模式
      if (settings.autoReplay) {
        setTimeout(() => Shadow.start(0), 500);
      }
    });

    // 字幕点击：总是跳转播放器，再触发跟读模式
    document.getElementById("subtitleList").addEventListener("click", (e) => {
      const li = e.target.closest(".sub-item");
      if (!li) return;
      const idx = parseInt(li.dataset.idx, 10);
      Player.jumpToSentence(idx);
      Shadow.onUserJump(idx);
    });

    // 键盘快捷键
    document.addEventListener("keydown", onKey);
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
        Shadow.onUserJump(Player.getCurrent());
        break;
      case "ArrowRight":
        e.preventDefault();
        Player.goNext();
        Shadow.onUserJump(Player.getCurrent());
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

  // ========== 历史记录辅助 ==========
  let pendingHistoryRecord = null;
  let reselectHandler = null;

  /**
   * 通过历史记录打开本地文件：
   * 1) 提示用户重新选择原文件
   * 2) 用户选完后，复用历史的字幕/进度，不重新转写
   */
  function reselectForHistory(rec) {
    pendingHistoryRecord = rec;
    const input = document.getElementById("fileInput");
    if (!input) return;
    // 清理之前的 handler
    if (reselectHandler) {
      input.removeEventListener("change", reselectHandler);
    }
    reselectHandler = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      // 验证文件名+大小匹配
      if (f.name !== rec.source || f.size !== rec.size_bytes) {
        const ok = confirm(
          `所选文件与历史记录不匹配（期望：${rec.source}，${(rec.size_bytes/1024/1024).toFixed(2)}MB）。\n\n` +
          `是否仍然使用该文件并复用历史字幕？`
        );
        if (!ok) {
          input.value = "";
          return;
        }
      }
      // 创建对象 URL 给 Player 用
      const data = {
        subtitles: rec.subtitles || [],
        duration: rec.duration || 0,
        raw_text: rec.raw_text || "",
      };
      // 同步文件元信息到 UI
      Player.loadFile(f, data);
      // 恢复进度
      if (rec.progress_seconds && rec.progress_seconds > 1) {
        setTimeout(() => Player.seekTo(rec.progress_seconds), 300);
      }
      // 更新 currentId（保持进度上报到这条记录）
      // 注意：Player.loadFile 会触发 uploader 的 re-save？ 不会，loadFile 是直接调用
      // 但若用户从历史中再次"打开"且没有走 uploader，则 currentId 需要从 history.js 设置
      if (window.History) {
        // 直接设置 currentId
        try { window.History.currentId = rec.id; } catch (e) {}
      }
      // 自动开启跟读
      if (settings.autoReplay) {
        setTimeout(() => Shadow.start(0), 500);
      }
      input.removeEventListener("change", reselectHandler);
      reselectHandler = null;
      pendingHistoryRecord = null;
      input.value = "";
    };
    input.addEventListener("change", reselectHandler);
    input.click();
  }

  return { init, reselectForHistory };
})();

document.addEventListener("DOMContentLoaded", App.init);
window.App = App;
