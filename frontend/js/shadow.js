// 跟读模式：单句循环 + 句间停顿
const Shadow = (() => {
  let loopCount = 3;
  let pauseSec = 2;
  let enabled = false;
  let abortFlag = false;
  let busyFlag = false;

  // 单句循环播放状态
  let currentLoopIdx = -1;
  let loopsDone = 0;
  let phase = "play"; // "play" | "pause"

  function setEnabled(v) { enabled = v; abort(); }
  function isEnabled() { return enabled; }
  function setLoopCount(n) { loopCount = Math.max(1, Math.min(10, n)); }
  function setPauseSec(s) { pauseSec = Math.max(0, Math.min(10, s)); }
  function getLoopCount() { return loopCount; }
  function getPauseSec() { return pauseSec; }

  function abort() {
    abortFlag = true;
    busyFlag = false;
    if (window.Player) {
      const video = document.getElementById("video");
      video.onended = null;
    }
  }

  function start(sentenceIdx) {
    if (!enabled) return;
    if (busyFlag) return;
    const subs = window.Player.getSubtitles();
    if (!subs.length) return;
    if (sentenceIdx >= subs.length) return;

    abortFlag = false;
    busyFlag = true;
    currentLoopIdx = sentenceIdx;
    loopsDone = 0;
    phase = "play";
    playCurrentSentence();
  }

  function playCurrentSentence() {
    if (abortFlag || !enabled || currentLoopIdx < 0) {
      busyFlag = false;
      return;
    }
    const subs = window.Player.getSubtitles();
    const s = subs[currentLoopIdx];
    if (!s) { busyFlag = false; return; }

    phase = "play";
    window.Player.seekTo(s.start);
    const video = document.getElementById("video");
    video.playbackRate = window.AppState.settings.speed;
    video.play().catch(() => { busyFlag = false; });

    video.onended = onSentenceEnded;
  }

  function onSentenceEnded() {
    if (abortFlag || !enabled) { busyFlag = false; return; }
    loopsDone += 1;
    if (loopsDone < loopCount) {
      playCurrentSentence();
    } else {
      if (pauseSec > 0) {
        phase = "pause";
        window.Player.pause();
        setTimeout(() => {
          if (abortFlag || !enabled) { busyFlag = false; return; }
          currentLoopIdx += 1;
          loopsDone = 0;
          if (currentLoopIdx >= window.Player.getSubtitles().length) {
            busyFlag = false;
            return;
          }
          playCurrentSentence();
        }, pauseSec * 1000);
      } else {
        currentLoopIdx += 1;
        loopsDone = 0;
        if (currentLoopIdx >= window.Player.getSubtitles().length) {
          busyFlag = false;
          return;
        }
        playCurrentSentence();
      }
    }
  }

  // 用户手动跳转 / 点击字幕时调用，触发新一轮
  function onUserJump(idx) {
    if (!enabled) return;
    const video = document.getElementById("video");
    if (video) {
      video.pause();
      video.onended = null;
    }
    abort();
    start(idx);
  }

  function stop() {
    abort();
  }

  return { setEnabled, isEnabled, setLoopCount, setPauseSec, getLoopCount, getPauseSec, start, stop, onUserJump, abort };
})();

window.Shadow = Shadow;
