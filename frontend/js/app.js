// 主应用 - 装配所有模块
const App = (() => {
  const settings = window.Storage.load();
  window.AppState = { settings };

  function init() {
    Uploader.init();
    if (window.LinkHandler) LinkHandler.init();
    Player.init();
    if (window.AIAssistant) AIAssistant.init();
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
    document.getElementById("showZh").addEventListener("change", (e) => {
      settings.showZh = e.target.checked;
      Storage.save(settings);
      Player.reRenderSubtitles();
    });

    // 重选文件
    document.getElementById("reloadBtn").addEventListener("click", () => {
      Shadow.abort();
      Player.pause();
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

  return { init };
})();

document.addEventListener("DOMContentLoaded", App.init);
window.App = App;
