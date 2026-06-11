// Player (audio/video) + subtitle list sync
const Player = (() => {
  let video, playBtn, prevBtn, nextBtn, replayBtn, seek, timeDisplay;
  let fileNameEl, splitWrap, splitView, playerCard, subtitleCard, subtitleList, subStats;
  let subtitles = [];
  let currentIndex = -1;
  let objectUrl = null;
  let isVideoFile = false;

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
      }
    });

    seek.addEventListener("input", (e) => {
      if (!video.duration) return;
      video.currentTime = (e.target.value / 100) * video.duration;
    });

    initResizer();
  }

  function loadFile(file, data) {
    console.log("[Player] loadFile called, file:", file?.name, "subs:", data?.subtitles?.length);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    isVideoFile = file.type.startsWith("video/");
    video.classList.toggle("audio-only", !isVideoFile);

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

  function onTimeUpdate() {
    updateTimeDisplay();
    updateSeekBar();
    syncActiveSubtitle();
    reportProgressThrottled();
  }

  let _lastReport = 0;
  function reportProgressThrottled() {
    const now = Date.now();
    if (now - _lastReport < 5000) return;
    _lastReport = now;
    if (window.History && window.History.currentId) {
      const t = video.currentTime || 0;
      if (t > 0.5) {
        window.HistoryReportProgress && window.HistoryReportProgress(window.History.currentId, t);
      }
    }
  }

  function onEnded() {
    playBtn.textContent = "▶";
  }

  function updateTimeDisplay() {
    timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration || 0)}`;
  }

  function updateSeekBar() {
    if (video.duration) {
      seek.value = (video.currentTime / video.duration) * 100;
    }
  }

  function syncActiveSubtitle() {
    if (!subtitles.length) return;
    const t = video.currentTime;
    let idx = -1;
    for (let i = 0; i < subtitles.length; i++) {
      if (t >= subtitles[i].start && t < subtitles[i].end) {
        idx = i;
        break;
      }
    }
    if (idx === -1 && t >= subtitles[subtitles.length - 1].end) {
      idx = subtitles.length - 1;
    }
    if (idx !== currentIndex && idx !== -1) {
      setActiveSubtitle(idx);
    }
  }

  function setActiveSubtitle(idx) {
    currentIndex = idx;
    const items = subtitleList.querySelectorAll(".sub-item");
    items.forEach((el, i) => {
      el.classList.toggle("active", i === idx);
      el.classList.toggle("done", i < idx);
    });
    const active = items[idx];
    if (active) {
      const listRect = subtitleList.getBoundingClientRect();
      const itemRect = active.getBoundingClientRect();
      if (itemRect.top < listRect.top + 40 || itemRect.bottom > listRect.bottom - 40) {
        active.scrollIntoView({ block: "center", behavior: "smooth" });
      }
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
      li.className = "sub-item";
      li.dataset.idx = i;
      let translationText = "";
      if (showTranslation) {
        const raw = s[currentTranslationField];
        translationText = (typeof raw === "string") ? raw : "";
      }
      if (showTranslation) {
        if (translationText) renderedCount++;
        else emptyCount++;
      }
      li.innerHTML = `
        <span class="sub-num">${i + 1}</span>
        <div class="sub-content">
          <div class="sub-en">${renderWordsHtml(s.en || "")}</div>
          ${translationText ? `<div class="sub-zh sub-translation" data-translation-field="${currentTranslationField}">${escapeHtml(translationText)}</div>` : ""}
        </div>
        <span class="sub-time">${formatTime(s.start)}</span>
      `;
      li.addEventListener("click", (ev) => {
        const wordEl = ev.target.closest(".word");
        if (wordEl && window.WordLookup) {
          ev.stopPropagation();
          window.WordLookup.show(wordEl, s);
          return;
        }
        jumpToSentence(i);
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
    video.currentTime = subtitles[idx].start;
    setActiveSubtitle(idx);
    if (video.paused) video.play();
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
      video.currentTime = 0;
      video.play();
      return;
    }
    const s = subtitles[currentIndex];
    video.currentTime = s.start;
    video.play();
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
      const iframe = getYouTubeIframe();
      if (!iframe) return;
      if (playBtn.textContent === '▶') {
        sendYouTubeCommand('playVideo');
        playBtn.textContent = '⏸';
      } else {
        sendYouTubeCommand('pauseVideo');
        playBtn.textContent = '▶';
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
  function getDuration() { return video.duration || 0; }
  function getCurrentTime() { return video.currentTime || 0; }
  function seekTo(t) {
    if (video.src) video.currentTime = t;
  }

  function loadSubtitles(newSubtitles, options = {}) {
    subtitles = newSubtitles || [];
    currentIndex = -1;
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
