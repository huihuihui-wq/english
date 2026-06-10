// Shadowing mode: per-sentence loop + inter-sentence pause + delay shadowing
const Shadow = (() => {
  let loopCount = 3;
  let pauseSec = 2;
  let delaySec = 0;        // 延迟跟读秒数 (0 = 同步跟读)
  let enabled = false;
  let abortFlag = false;
  let busyFlag = false;

  // Single-sentence loop state
  let currentLoopIdx = -1;
  let loopsDone = 0;
  let phase = "play"; // "play" | "pause" | "delay"

  // timeupdate listener reference (for cleanup)
  let _timeupdateHandler = null;

  function setEnabled(v) { enabled = v; abort(); }
  function isEnabled() { return enabled; }
  function setLoopCount(n) { loopCount = Math.max(1, Math.min(10, n)); }
  function setPauseSec(s) { pauseSec = Math.max(0, Math.min(10, s)); }
  function setDelaySec(s) { delaySec = Math.max(0, Math.min(5, s)); }
  function getLoopCount() { return loopCount; }
  function getPauseSec() { return pauseSec; }
  function getDelaySec() { return delaySec; }

  function abort() {
    abortFlag = true;
    busyFlag = false;
    const video = document.getElementById("video");
    if (video && _timeupdateHandler) {
      video.removeEventListener("timeupdate", _timeupdateHandler);
      _timeupdateHandler = null;
    }
  }

  // Detect when current sentence playback reaches its end
  function makeTimeupdateHandler(sentenceEndTime) {
    return function onTimeUpdate() {
      if (abortFlag || !enabled || phase !== "play") return;
      const video = document.getElementById("video");
      if (!video) return;
      // Check if we've reached (or passed) the sentence end
      if (video.currentTime >= sentenceEndTime - 0.05) {
        video.removeEventListener("timeupdate", _timeupdateHandler);
        _timeupdateHandler = null;
        onSentenceEnded();
      }
    };
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

    // Clean up previous listener
    if (_timeupdateHandler) {
      video.removeEventListener("timeupdate", _timeupdateHandler);
      _timeupdateHandler = null;
    }

    video.play().catch(() => { busyFlag = false; });

    // Use timeupdate to detect sentence end (onended only fires at video end)
    _timeupdateHandler = makeTimeupdateHandler(s.end);
    video.addEventListener("timeupdate", _timeupdateHandler);
  }

  function onSentenceEnded() {
    if (abortFlag || !enabled) { busyFlag = false; return; }
    loopsDone += 1;
    if (loopsDone < loopCount) {
      // Delay shadowing: pause for delaySec before replaying
      if (delaySec > 0) {
        phase = "delay";
        window.Player.pause();
        setTimeout(() => {
          if (abortFlag || !enabled) { busyFlag = false; return; }
          phase = "play";
          playCurrentSentence();
        }, delaySec * 1000);
      } else {
        playCurrentSentence();
      }
    } else {
      // Move to next sentence
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

  // Called when user jumps / clicks a subtitle to start a new loop
  function onUserJump(idx) {
    if (!enabled) return;
    const video = document.getElementById("video");
    if (video) {
      video.pause();
      if (_timeupdateHandler) {
        video.removeEventListener("timeupdate", _timeupdateHandler);
        _timeupdateHandler = null;
      }
    }
    abort();
    start(idx);
  }

  function stop() {
    abort();
  }

  return { setEnabled, isEnabled, setLoopCount, setPauseSec, setDelaySec, getLoopCount, getPauseSec, getDelaySec, start, stop, onUserJump, abort };
})();

window.Shadow = Shadow;
