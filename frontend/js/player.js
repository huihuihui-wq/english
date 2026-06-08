// 播放器（音频/视频通用） + 字幕列表同步
const Player = (() => {
  let video, playBtn, prevBtn, nextBtn, replayBtn, seek, timeDisplay;
  let fileNameEl, playerCard, subtitleCard, subtitleList, subStats;
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

    seek.addEventListener("input", (e) => {
      if (!video.duration) return;
      video.currentTime = (e.target.value / 100) * video.duration;
    });
  }

  function loadFile(file, data) {
    console.log("[Player] loadFile called, file:", file?.name, "subs:", data?.subtitles?.length);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    // 检测是否为视频文件
    isVideoFile = file.type.startsWith("video/");
    video.classList.toggle("audio-only", !isVideoFile);

    fileNameEl.textContent = file.name;
    playerCard.hidden = false;
    subtitleCard.hidden = false;

    subtitles = data.subtitles || [];
    currentIndex = -1;
    renderSubtitles();
    subStats.textContent = `共 ${subtitles.length} 句 · 时长 ${formatTime(data.duration || 0)}`;
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

  function renderSubtitles() {
    subtitleList.innerHTML = "";
    const showZh = window.AppState.settings.showZh;
    subtitles.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = "sub-item";
      li.dataset.idx = i;
      li.innerHTML = `
        <span class="sub-num">${i + 1}</span>
        <div class="sub-content">
          <div class="sub-en">${escapeHtml(s.en)}</div>
          ${showZh && s.zh ? `<div class="sub-zh">${escapeHtml(s.zh)}</div>` : ""}
        </div>
        <span class="sub-time">${formatTime(s.start)}</span>
      `;
      li.addEventListener("click", () => jumpToSentence(i));
      subtitleList.appendChild(li);
    });
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

  function togglePlay() {
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

  function goPrev() { goRelative(-1); }
  function goNext() { goRelative(1); }

  return {
    init,
    loadFile,
    play, pause, setRate, togglePlay,
    getCurrent, getSubtitles, getDuration, getCurrentTime, seekTo,
    reRenderSubtitles,
    goPrev, goNext, replayCurrent, jumpToSentence,
  };
})();

window.Player = Player;
