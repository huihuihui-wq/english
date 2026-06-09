// TTS 测试 tab 逻辑 - 调用后端 /api/tts
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function log(msg, type = "info") {
    const el = $("ttsLog");
    if (!el) return;
    const line = document.createElement("div");
    line.className = `tts-log-line ${type}`;
    const t = new Date().toLocaleTimeString();
    line.textContent = `[${t}] ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  // 1. 加载引擎信息 + 动态填充音色下拉框
  let engineInfo = null;
  async function loadEngineInfo() {
    try {
      const r = await fetch("/api/tts/info");
      engineInfo = await r.json();
      $("ttsEngineInfo").textContent =
        `${engineInfo.model} | 音色 ${engineInfo.voice} | 语种 ${engineInfo.language} | 缓存 ${engineInfo.cache_size} 条 | 共 ${engineInfo.voices.length} 个音色`;
      log(`引擎: ${engineInfo.model}, 默认音色: ${engineInfo.voice}, 共 ${engineInfo.voices.length} 个音色`, "success");
      populateVoices(engineInfo.voices, engineInfo.voice);
    } catch (e) {
      $("ttsEngineInfo").textContent = "加载失败: " + e.message;
      log("加载引擎信息失败: " + e.message, "error");
    }
  }

  // 1b. 把音色按"语言分组"渲染到 <select>
  function populateVoices(voices, defaultVoice) {
    const sel = $("ttsVoice");
    if (!sel || !voices) return;
    sel.innerHTML = "";

    // 按 language 分组
    const groups = {};
    for (const v of voices) {
      const lang = v.language || "其他";
      if (!groups[lang]) groups[lang] = [];
      groups[lang].push(v);
    }

    // 顺序: 普通话 -> 各方言 -> 其他
    const order = ["普通话", "上海话", "北京话", "南京话", "陕西话", "闽南语", "天津话", "四川话", "粤语"];
    const sortedLangs = Object.keys(groups).sort((a, b) => {
      const ia = order.indexOf(a); const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1; if (ib === -1) return -1;
      return ia - ib;
    });

    for (const lang of sortedLangs) {
      const og = document.createElement("optgroup");
      og.label = `【${lang}】${groups[lang].length} 个`;
      for (const v of groups[lang]) {
        const opt = document.createElement("option");
        opt.value = v.id;
        // 展示: "Cherry · 芊悦 (女) - 阳光积极、亲切自然小姐姐"
        opt.textContent = `${v.id} · ${v.name} (${v.gender}) - ${v.desc}`;
        opt.title = opt.textContent;
        if (v.id === defaultVoice) opt.selected = true;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
    log(`已加载 ${voices.length} 个音色, 分 ${sortedLangs.length} 组`, "info");
  }

  // 2. 合成
  let currentBlobUrl = null;
  async function synth(download = false) {
    const text = $("ttsText").value.trim();
    if (!text) { log("文本为空", "error"); return; }
    if (text.length > 2000) { log("文本超过 2000 字符", "error"); return; }

    const voice = $("ttsVoice").value;
    const btn = download ? $("ttsDownloadBtn") : $("ttsBtn");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "合成中...";

    const t0 = performance.now();
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
      });
      if (!r.ok) {
        const err = await r.text();
        throw new Error(err);
      }
      const blob = await r.blob();
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = URL.createObjectURL(blob);

      $("ttsPlayerWrap").style.display = "block";
      const player = $("ttsPlayer");
      player.src = currentBlobUrl;
      if (!download) player.play().catch(() => {});

      // 元数据
      const txtLen = r.headers.get("X-Text-Length") || text.length;
      const audioSize = r.headers.get("X-Audio-Size") || blob.size;
      $("ttsMetaText").innerHTML = `文本 <code>${txtLen}</code> 字符`;
      $("ttsMetaSize").innerHTML = `音频 <code>${(audioSize / 1024).toFixed(1)}</code> KB`;
      $("ttsMetaTime").innerHTML = `耗时 <code>${((performance.now() - t0) / 1000).toFixed(2)}</code> s`;

      log(`合成成功: 音色=${voice}, ${txtLen} 字符 -> ${(audioSize / 1024).toFixed(1)} KB, 耗时 ${((performance.now() - t0) / 1000).toFixed(2)}s`, "success");

      if (download) {
        const a = document.createElement("a");
        a.href = currentBlobUrl;
        a.download = `tts_${Date.now()}.mp3`;
        a.click();
        log("已触发下载", "info");
      }
    } catch (e) {
      log("合成失败: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  // 3. Tab 切换
  function initTabs() {
    const tabs = document.querySelectorAll("#mainTabs .tab-btn");
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        tabs.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const target = btn.dataset.tab;
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
        const panel = $("tab-" + target);
        if (panel) panel.classList.remove("hidden");
      });
    });
  }

  // 4. 示例填充
  function initExamples() {
    document.querySelectorAll(".example-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        $("ttsText").value = chip.dataset.text;
        log("填入示例: " + chip.textContent);
      });
    });
  }

  // 5. 启动
  function init() {
    initTabs();
    initExamples();
    $("ttsBtn").addEventListener("click", () => synth(false));
    $("ttsDownloadBtn").addEventListener("click", () => synth(true));
    loadEngineInfo();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
