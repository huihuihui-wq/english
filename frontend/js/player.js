// Player (audio/video) + subtitle list sync
const Player = (() => {
  let video, playBtn, prevBtn, nextBtn, replayBtn, seek, timeDisplay;
  let fileNameEl, splitWrap, splitView, playerCard, subtitleCard, subtitleList, subStats;
  let subtitles = [];
  let currentIndex = -1;
  let objectUrl = null;
  let isVideoFile = false;

  let currentTranslationEl, currentTranslationTextEl;
  let autoFollow = true;

  function init() {
    video = document.getElementById("video");
    playBtn = document.getElementById("playBtn");
    prevBtn = document.getElementById("prevBtn");
    nextBtn = document.getElementById("nextBtn");
    replayBtn = document.getElementById("replayBtn");
    seek = document.getElementById("seek");
    timeDisplay = document.getElementById("timeDisplay");
    fileNameEl = document.getElementById("fileName");
    splitWrap = document.getElementById("splitWrap");
    splitView = document.getElementById("splitView");
    playerCard = document.getElementById("playerCard");
    subtitleCard = document.getElementById("subtitleCard");
    subtitleList = document.getElementById("subtitleList");
    subStats = document.getElementById("subStats");
    currentTranslationEl = document.getElementById("currentTranslation");
    currentTranslationTextEl = document.getElementById("currentTranslationText");

    playBtn.addEventListener("click", togglePlay);
    prevBtn.addEventListener("click", () => goRelative(-1));
    nextBtn.addEventListener("click", () => goRelative(1));
    replayBtn.addEventListener("click", replayCurrent);

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);
    video.addEventListener("play", () => (playBtn.textContent = "⏸"));
    video.addEventListener("pause", () => (playBtn.textContent = "▶"));

    window.addEventListener("link:subtitles-loaded", (e) => {
      if (e.detail && e.detail.subtitles) {
        loadSubtitles(e.detail.subtitles);
        // If YouTube is active, start the time sync poller
        if (window.LinkHandler && window.LinkHandler.isYouTubeActive && window.LinkHandler.isYouTubeActive()) {
          startYouTubeTimeSync();
        }
      }
    });

    // Auto-start YouTube time sync when YouTube video is loaded
    // (fires before subtitles may be loaded).
    let _ytAutoStartCheck = setInterval(() => {
      if (window.LinkHandler && window.LinkHandler.isYouTubeActive && window.LinkHandler.isYouTubeActive()) {
        if (!_ytSyncHandle) startYouTubeTimeSync();
      } else {
        if (_ytSyncHandle) stopYouTubeTimeSync();
      }
    }, 500);

    seek.addEventListener("input", (e) => {
      const d = getDuration();
      if (!d) return;
      const newT = (e.target.value / 100) * d;
      if (isYouTubeActive() && window.LinkHandler) {
        window.LinkHandler.seekTo(newT);
      } else {
        video.currentTime = newT;
      }
    });

    const autoFollowToggle = document.getElementById("autoFollowToggle");
    if (autoFollowToggle) {
      autoFollowToggle.addEventListener("change", (e) => {
        autoFollow = e.target.checked;
      });
    }

    initResizer();
  }

  function loadFile(file, data) {
    console.log("[Player] loadFile called, file:", file?.name, "subs:", data?.subtitles?.length);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    isVideoFile = file.type.startsWith("video/");
    video.classList.toggle("audio-only", !isVideoFile);

    // Local file mode - stop YouTube sync if it was running
    stopYouTubeTimeSync();

    fileNameEl.textContent = file.name;
    splitWrap.hidden = false;
    document.body.classList.add("playing");

    loadSubtitles(data.subtitles || []);
    subStats.textContent = `${subtitles.length} sentences · ${formatTime(data.duration || 0)}`;
  }

  function loadVideo(url, data) {
    console.log("[Player] loadVideo called, url:", url, "subs:", data?.subtitles?.length);
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    video.src = url;

    isVideoFile = url.match(/\.(mp4|webm|ogg|mov)(\?.*)?$/i) !== null;
    video.classList.toggle("audio-only", !isVideoFile);

    // Direct video mode - stop YouTube sync
    stopYouTubeTimeSync();

    fileNameEl.textContent = data.title || "Online Video";
    splitWrap.hidden = false;
    document.body.classList.add("playing");

    loadSubtitles(data.subtitles || []);
    subStats.textContent = `${subtitles.length} sentences · ${formatTime(data.duration || 0)}`;
  }

  function onLoadedMetadata() {
    seek.max = 100;
    video.currentTime = 0;
    updateTimeDisplay();
  }

  // Throttle subtitle sync to ~20 fps so that rapid timeupdate bursts
  // (e.g. during seeking or fast playback) don’t queue redundant DOM work.
  let _lastSyncTime = 0;
  function onTimeUpdate() {
    updateTimeDisplay();
    updateSeekBar();
    const now = performance.now();
    if (now - _lastSyncTime > 50) {
      _lastSyncTime = now;
      syncActiveSubtitle();
    }
    reportProgressThrottled();
  }

  // Cross-source time/duration/play-state accessors.
  // YouTube IFrame does not fire 'timeupdate' on the local <video> element,
  // so we use LinkHandler.getCurrentTime() which polls the IFrame.
  function getCurrentTime() {
    if (window.LinkHandler && window.LinkHandler.isYouTubeActive && window.LinkHandler.isYouTubeActive()) {
      return window.LinkHandler.getCurrentTime();
    }
    return video ? (video.currentTime || 0) : 0;
  }

  function getDuration() {
    if (window.LinkHandler && window.LinkHandler.isYouTubeActive && window.LinkHandler.isYouTubeActive()) {
      return window.LinkHandler.getDuration();
    }
    return video ? (video.duration || 0) : 0;
  }

  function isPlaying() {
    if (window.LinkHandler && window.LinkHandler.isYouTubeActive && window.LinkHandler.isYouTubeActive()) {
      return window.LinkHandler.isYouTubePlaying();
    }
    return video ? !video.paused : false;
  }

  // Independent YouTube time polling - runs every 250ms when YouTube is active.
  // The local <video> element's timeupdate doesn't fire for YouTube iframes,
  // so we need a separate poller to drive subtitle sync.
  let _ytSyncHandle = null;
  function startYouTubeTimeSync() {
    if (_ytSyncHandle) return;
    _ytSyncHandle = setInterval(() => {
      if (!window.LinkHandler || !window.LinkHandler.isYouTubeActive()) {
        stopYouTubeTimeSync();
        return;
      }
      syncActiveSubtitle();
      updateTimeDisplay();
      updateSeekBar();
      reportProgressThrottled();
    }, 250);
    console.log('[Player] YouTube time sync started');
  }

  function stopYouTubeTimeSync() {
    if (_ytSyncHandle) {
      clearInterval(_ytSyncHandle);
      _ytSyncHandle = null;
      console.log('[Player] YouTube time sync stopped');
    }
  }

  let _lastReport = 0;
  function reportProgressThrottled() {
    const now = Date.now();
    if (now - _lastReport < 5000) return;
    _lastReport = now;
    if (window.History && window.History.currentId) {
      const t = getCurrentTime();
      if (t > 0.5) {
        window.HistoryReportProgress && window.HistoryReportProgress(window.History.currentId, t);
      }
    }
  }

  function onEnded() {
    playBtn.textContent = "▶";
  }

  function updateTimeDisplay() {
    const t = getCurrentTime();
    const d = getDuration();
    timeDisplay.textContent = `${formatTime(t)} / ${formatTime(d)}`;
  }

  function updateSeekBar() {
    const t = getCurrentTime();
    const d = getDuration();
    if (d) {
      seek.value = (t / d) * 100;
    }
  }

  function syncActiveSubtitle() {
    if (!subtitles.length) return;
    const offset = (window.AppState && window.AppState.settings && window.AppState.settings.subtitleOffset) || 0;
    const t = getCurrentTime() - offset;
    let idx = -1;

    // Binary search O(log n) instead of linear O(n).
    // subtitles are strictly sorted by start time.
    let lo = 0, hi = subtitles.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const s = subtitles[mid];
      if (t >= s.start && t < s.end) {
        idx = mid;
        break;
      }
      if (t < s.start) {
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    // Handle edge case: past the very last subtitle
    if (idx === -1 && t >= subtitles[subtitles.length - 1].end) {
      idx = subtitles.length - 1;
    }

    if (idx !== currentIndex && idx !== -1) {
      setActiveSubtitle(idx);
    }
  }

  function setActiveSubtitle(idx) {
    if (idx === currentIndex) return;
    const prevIdx = currentIndex;
    currentIndex = idx;

    const items = subtitleList.children;
    if (!items || !items.length) return;

    // 1. Update active class — only 2 elements touched (prev + curr).
    if (prevIdx >= 0 && prevIdx < items.length) {
      items[prevIdx].classList.remove("active");
    }
    if (idx >= 0 && idx < items.length) {
      items[idx].classList.add("active");
    }

    // 2. Update done class — only the range between prev and curr.
    const start = Math.min(prevIdx < 0 ? 0 : prevIdx, idx);
    const end = Math.max(prevIdx < 0 ? 0 : prevIdx, idx);
    for (let i = start; i <= end && i < items.length; i++) {
      const shouldBeDone = i < idx;
      const el = items[i];
      if (el.classList.contains("done") !== shouldBeDone) {
        el.classList.toggle("done", shouldBeDone);
      }
    }

    // 3. Update translation display.
    updateCurrentTranslation(idx);

    // 4. Scroll — only if user enabled auto-follow AND the item is off-screen.
    // We use offsetTop / clientHeight instead of getBoundingClientRect to avoid
    // forced synchronous layout of the entire document.
    if (autoFollow && idx >= 0 && idx < items.length) {
      const curr = items[idx];
      const listTop = subtitleList.scrollTop;
      const listBottom = listTop + subtitleList.clientHeight;
      const itemTop = curr.offsetTop;
      const itemBottom = itemTop + curr.clientHeight;
      if (itemTop < listTop || itemBottom > listBottom) {
        curr.scrollIntoView({ block: "nearest", behavior: "auto" });
      }
    }
  }

  function updateCurrentTranslation(idx) {
    if (!currentTranslationEl || !currentTranslationTextEl) return;
    const s = subtitles[idx];
    if (!s) {
      currentTranslationEl.hidden = true;
      return;
    }
    const text = currentTranslationField ? s[currentTranslationField] : "";
    if (text && String(text).trim()) {
      currentTranslationTextEl.textContent = text;
      currentTranslationEl.hidden = false;
    } else {
      currentTranslationEl.hidden = true;
    }
  }

  // Translation field map (matches backend services.translate.SUPPORTED_TARGET_LANGS)
  const TRANSLATION_FIELDS = {
    "Chinese": "zh",
    "Chinese-Traditional": "zh-TW",
    "Japanese": "ja",
    "Korean": "ko",
    "French": "fr",
    "German": "de",
    "Spanish": "es",
    "Portuguese": "pt",
    "Russian": "ru",
    "Italian": "it",
  };

  let currentTranslationField = "";

  function renderSubtitles() {
    subtitleList.innerHTML = "";
    const showTranslation = !!currentTranslationField;
    let renderedCount = 0;
    let emptyCount = 0;
    subtitles.forEach((s, i) => {
      const li = document.createElement("li");
      const ptype = s.placeholder_type || "silence";
      li.className = "sub-item" + (s.is_placeholder ? " placeholder placeholder-" + ptype : "");
      li.dataset.idx = i;
      if (s.is_placeholder) {
        const ptypeTitle = {
          music: "Music segment",
          applause: "Applause segment",
          silence: "Silent segment",
          noise: "Noise segment",
        }[ptype] || "Silent segment";
        li.title = `${ptypeTitle} — click to jump`;
      }
      let translationText = "";
      if (showTranslation) {
        const raw = s[currentTranslationField];
        translationText = (typeof raw === "string") ? raw : "";
      }
      if (showTranslation) {
        if (translationText) renderedCount++;
        else emptyCount++;
      }
      const enHtml = s.is_placeholder
        ? `<span class="placeholder-label">${escapeHtml(s.en || "🤐 silence")}</span>`
        : renderWordsHtml(s.en || "");
      li.innerHTML = `
        <span class="sub-num">${i + 1}</span>
        <div class="sub-content">
          <div class="sub-en">${enHtml}</div>
          ${translationText ? `<div class="sub-zh sub-translation" data-translation-field="${currentTranslationField}">${escapeHtml(translationText)}</div>` : ""}
        </div>
        <div class="sub-actions">
          <button class="sub-ask-ai" data-idx="${i}" title="问 AI">🤖 问AI</button>
          <span class="sub-time">${formatTime(s.start)}</span>
        </div>
      `;
      li.addEventListener("click", (ev) => {
        const askBtn = ev.target.closest(".sub-ask-ai");
        if (askBtn) {
          ev.stopPropagation();
          const subText = s.en || "";
          if (subText && window.AIAssistant) {
            window.AIAssistant.askAboutSubtitle(subText);
          }
          return;
        }
        const wordEl = ev.target.closest(".word");
        if (wordEl && window.WordLookup) {
          ev.stopPropagation();
          window.WordLookup.show(wordEl, s);
          return;
        }
        jumpToSentence(i);
      });
      // Right-click context menu: reset this line's start to current playback time.
      li.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        const cur = getCurrentTime();
        const newStart = Math.max(0, cur);
        const oldStart = s.start;
        const oldEnd = s.end;
        s.start = newStart;
        // Preserve duration; if the line would overlap the next, clamp end.
        s.end = newStart + (oldEnd - oldStart);
        if (i + 1 < subtitles.length && s.end > subtitles[i + 1].start) {
          s.end = subtitles[i + 1].start;
        }
        // Re-render the whole list to reflect the new time display
        renderSubtitles();
        if (window.showToast) {
          window.showToast(
            `✓ Subtitle #${i + 1} start: ${oldStart.toFixed(2)}s → ${newStart.toFixed(2)}s`,
            'success',
            2200,
          );
        }
      });
      subtitleList.appendChild(li);
    });
    if (showTranslation) {
      console.log(`[Player] Render translation: field=${currentTranslationField}, rendered=${renderedCount}/${subtitles.length}, empty=${emptyCount}`);
    }
  }

  function reRenderSubtitles() {
    renderSubtitles();
    if (currentIndex >= 0) setActiveSubtitle(currentIndex);
  }

  function jumpToSentence(idx) {
    if (!subtitles[idx]) return;
    const startT = subtitles[idx].start;
    if (isYouTubeActive() && window.LinkHandler) {
      window.LinkHandler.seekTo(startT);
      window.LinkHandler.play();
    } else {
      video.currentTime = startT;
      if (video.paused) video.play();
    }
    setActiveSubtitle(idx);
  }

  function goRelative(delta) {
    if (!subtitles.length) return;
    const target = Math.max(0, Math.min(subtitles.length - 1, currentIndex + delta));
    if (target === currentIndex && currentIndex === -1 && subtitles.length) {
      jumpToSentence(0);
      return;
    }
    jumpToSentence(target);
  }

  function replayCurrent() {
    if (currentIndex === -1) {
      if (isYouTubeActive() && window.LinkHandler) {
        window.LinkHandler.seekTo(0);
        window.LinkHandler.play();
      } else {
        video.currentTime = 0;
        video.play();
      }
      return;
    }
    const s = subtitles[currentIndex];
    if (isYouTubeActive() && window.LinkHandler) {
      window.LinkHandler.seekTo(s.start);
      window.LinkHandler.play();
    } else {
      video.currentTime = s.start;
      video.play();
    }
  }

  function isYouTubeActive() {
    return window.LinkHandler && window.LinkHandler.isYouTubeActive && window.LinkHandler.isYouTubeActive();
  }

  function getYouTubeIframe() {
    return document.getElementById('youtubePlayer')?.querySelector('iframe');
  }

  function sendYouTubeCommand(command) {
    const iframe = getYouTubeIframe();
    if (!iframe) return;
    iframe.contentWindow.postMessage(JSON.stringify({
      event: 'command',
      func: command,
      args: []
    }), '*');
  }

  function togglePlay() {
    if (isYouTubeActive()) {
      if (window.LinkHandler) {
        if (window.LinkHandler.isYouTubePlaying()) {
          window.LinkHandler.pause();
          playBtn.textContent = '▶';
        } else {
          window.LinkHandler.play();
          playBtn.textContent = '⏸';
        }
      }
      return;
    }

    if (!video.src) return;
    if (video.paused) video.play();
    else video.pause();
  }

  function play() { video.play(); }
  function pause() { video.pause(); }

  function setRate(r) {
    video.playbackRate = r;
  }

  function getCurrent() { return currentIndex; }
  function getSubtitles() { return subtitles; }
  function seekTo(t) {
    if (isYouTubeActive() && window.LinkHandler) {
      window.LinkHandler.seekTo(t);
    } else if (video.src) {
      video.currentTime = t;
    }
  }

  function loadSubtitles(newSubtitles, options = {}) {
    subtitles = newSubtitles || [];
    currentIndex = -1;
    const phCount = subtitles.filter((s) => s.is_placeholder).length;
    console.log(`[Player] loadSubtitles: ${subtitles.length} total (${phCount} placeholders)`);
    if (!options.skipAutoTranslation) {
      const savedLang = window.AppState?.settings?.targetLang;
      if (savedLang) {
        const FIELD_MAP = {
          "Chinese": "zh", "Chinese-Traditional": "zh-TW",
          "Japanese": "ja", "Korean": "ko",
          "French": "fr", "German": "de", "Spanish": "es",
          "Portuguese": "pt", "Russian": "ru", "Italian": "it",
        };
        const field = FIELD_MAP[savedLang];
        if (field && subtitles.some((s) => s[field] && String(s[field]).trim())) {
          currentTranslationField = field;
        }
      }
    }
    renderSubtitles();
    subStats.textContent = `${subtitles.length} sentences`;
  }

  function getSubtitlesCopy() {
    return subtitles.map((s) => ({ ...s }));
  }

  // Legacy compatibility API (zh field)
  function setSubtitleZh(index, zh) {
    if (!subtitles[index]) return;
    subtitles[index].zh = (typeof zh === "string") ? zh : "";
  }

  // Generic API for any field (zh / ja / ko / fr / ...)
  function setSubtitleField(index, field, text) {
    if (!subtitles[index]) return;
    subtitles[index][field] = (typeof text === "string") ? text : "";
  }

  function setTranslationField(field) {
    currentTranslationField = field || "";
  }

  function setAllSubtitleZh(zhList) {
    if (!Array.isArray(zhList)) return;
    subtitles.forEach((s, i) => {
      if (i < zhList.length) {
        const val = zhList[i];
        s.zh = (typeof val === "string") ? val : "";
      }
    });
    reRenderSubtitles();
  }

  function formatTime(s) {
    if (!s || isNaN(s)) return "00:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const _WORD_RE = /[A-Za-z][A-Za-z'\-]*|[0-9]+|[^A-Za-z0-9\s]+|\s+/g;

  function isEnglishWordToken(t) {
    if (!t) return false;
    if (!/^[A-Za-z]/.test(t)) return false;
    return /^[A-Za-z][A-Za-z'\-]*$/.test(t);
  }

  function renderWordsHtml(text) {
    if (!text) return "";
    const out = [];
    let m;
    _WORD_RE.lastIndex = 0;
    while ((m = _WORD_RE.exec(text)) !== null) {
      const tok = m[0];
      if (tok.isspace || /^\s+$/.test(tok)) {
        out.push(escapeHtml(tok));
      } else if (isEnglishWordToken(tok)) {
        out.push(`<span class="word" data-word="${escapeHtml(tok)}">${escapeHtml(tok)}</span>`);
      } else {
        out.push(`<span class="word-punct">${escapeHtml(tok)}</span>`);
      }
    }
    return out.join("");
  }

  function goPrev() { goRelative(-1); }
  function goNext() { goRelative(1); }

  window.debugSubtitles = () => {
    console.table(subtitles.map((s, i) => ({
      idx: i + 1,
      start: s.start,
      en: s.en?.substring(0, 50),
      zh: s.zh?.substring(0, 50) || "(empty)",
      hasZh: !!s.zh,
    })));
    return subtitles;
  };

  // Subtitle column resize drag
  function initResizer() {
    const resizer = document.getElementById("splitResizer");
    if (!resizer || !splitView) return;

    let dragging = false;
    let startX = 0;
    let startLeftPct = 0;

    const onDown = (e) => {
      dragging = true;
      const point = e.touches ? e.touches[0] : e;
      startX = point.clientX;
      const rect = splitView.getBoundingClientRect();
      const cs = window.getComputedStyle(splitView);
      const cols = cs.gridTemplateColumns.split(" ");
      const leftPx = parseFloat(cols[0]);
      startLeftPct = (leftPx / rect.width) * 100;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const point = e.touches ? e.touches[0] : e;
      const rect = splitView.getBoundingClientRect();
      const dx = point.clientX - startX;
      const newLeftPct = startLeftPct + (dx / rect.width) * 100;
      const clamped = Math.max(25, Math.min(75, newLeftPct));
      splitView.style.gridTemplateColumns = `${clamped}% ${100 - clamped}%`;
      resizer.style.left = `${clamped}%`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    resizer.addEventListener("mousedown", onDown);
    resizer.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
  }

  return {
    init,
    loadFile,
    loadVideo,
    loadSubtitles,
    getSubtitlesCopy,
    setSubtitleZh,
    setSubtitleField,
    setTranslationField,
    setAllSubtitleZh,
    play, pause, setRate, togglePlay,
    getCurrent, getSubtitles, getDuration, getCurrentTime, seekTo,
    reRenderSubtitles,
    goPrev, goNext, replayCurrent, jumpToSentence,
  };
})();

window.Player = Player;
