// TTS Test tab - DashScope Qwen3-TTS with real-time subtitle following
const TTSTab = (() => {
  let languageSel, voiceSel, textEl, generateBtn, clearBtn, examplesWrap;
  let playerWrap, audioEl, metaVoice, metaSize, metaCached, logEl;
  let subtitleWrap, subtitleText, wordsData, wordHighlightTimer;

  function init() {
    languageSel = document.getElementById("ttsLanguage");
    voiceSel = document.getElementById("ttsVoice");
    textEl = document.getElementById("ttsText");
    generateBtn = document.getElementById("ttsGenerateBtn");
    clearBtn = document.getElementById("ttsClearBtn");
    examplesWrap = document.getElementById("ttsExamples");
    playerWrap = document.getElementById("ttsPlayerWrap");
    audioEl = document.getElementById("ttsAudio");
    metaVoice = document.getElementById("ttsMetaVoice");
    metaSize = document.getElementById("ttsMetaSize");
    metaCached = document.getElementById("ttsMetaCached");
    logEl = document.getElementById("ttsLog");

    if (!languageSel || !voiceSel) return;

    // Create subtitle display area
    subtitleWrap = document.createElement("div");
    subtitleWrap.className = "tts-subtitle-wrap";
    subtitleWrap.innerHTML = `
      <div class="tts-subtitle-label">🔤 Real-time Subtitle</div>
      <div class="tts-subtitle-text" id="ttsSubtitleText"></div>
    `;
    playerWrap.parentNode.insertBefore(subtitleWrap, playerWrap.nextSibling);
    subtitleText = document.getElementById("ttsSubtitleText");

    languageSel.addEventListener("change", () => {
      loadVoices(languageSel.value);
    });

    generateBtn.addEventListener("click", generate);
    clearBtn.addEventListener("click", () => {
      logEl.innerHTML = `<div class="tts-log-line">TTS log cleared.</div>`;
      clearSubtitle();
    });

    examplesWrap.addEventListener("click", (e) => {
      const chip = e.target.closest(".example-chip");
      if (!chip) return;
      textEl.value = chip.textContent;
    });

    // Audio timeupdate listener for word highlighting
    audioEl.addEventListener("timeupdate", onAudioTimeUpdate);
    audioEl.addEventListener("ended", clearSubtitle);
    audioEl.addEventListener("pause", clearSubtitle);

    loadVoices(languageSel.value);
  }

  async function loadVoices(languageType) {
    try {
      const resp = await fetch(`/api/tts/voices?language_type=${encodeURIComponent(languageType)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const voices = data.voices || [];
      const current = voiceSel.value;
      voiceSel.innerHTML = voices.map((v) =>
        `<option value="${v}" ${v === current ? "selected" : ""}>${v}</option>`
      ).join("");
      if (!voices.includes(current) && voices.length > 0) {
        voiceSel.value = data.default || voices[0];
      }
    } catch (e) {
      log(`Failed to load voices: ${e.message}`, "error");
    }
  }

  async function generate() {
    const text = textEl.value.trim();
    if (!text) {
      log("Please enter text to synthesize.", "warn");
      textEl.focus();
      return;
    }

    const voice = voiceSel.value;
    const languageType = languageSel.value;

    generateBtn.disabled = true;
    generateBtn.textContent = "Synthesizing...";
    clearSubtitle();
    log(`Synthesizing: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}" → ${voice}`);

    try {
      const resp = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice, language_type: languageType }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${resp.status}`);
      }

      const data = await resp.json();
      const meta = data.meta || {};
      const audioBase64 = data.audio;
      
      if (!audioBase64) {
        throw new Error("No audio data in response");
      }

      // Decode base64 audio
      const audioBlob = base64ToBlob(audioBase64, "audio/mpeg");
      const url = URL.createObjectURL(audioBlob);
      audioEl.src = url;
      playerWrap.hidden = false;

      // Store word-level timestamps
      wordsData = meta.words || [];
      if (wordsData.length > 0) {
        log(`Audio generated with ${wordsData.length} word timestamps`, "success");
        renderWords(wordsData);
      } else {
        log(`Audio generated: ${(meta.size / 1024).toFixed(1)} KB · voice=${meta.voice}`, "success");
        subtitleText.textContent = text;
      }

      metaVoice.textContent = meta.voice || voice;
      metaSize.textContent = `${((meta.size || 0) / 1024).toFixed(1)} KB`;
      metaCached.textContent = meta.cached ? "Yes" : "No";

    } catch (e) {
      log(`TTS failed: ${e.message}`, "error");
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = "🔊 Generate Speech";
    }
  }

  function base64ToBlob(base64, mimeType) {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  }

  function renderWords(words) {
    subtitleText.innerHTML = "";
    words.forEach((w, i) => {
      const span = document.createElement("span");
      span.className = "tts-word";
      span.dataset.index = i;
      span.dataset.begin = w.begin_time || 0;
      span.dataset.end = w.end_time || 0;
      span.textContent = w.text + " ";
      subtitleText.appendChild(span);
    });
  }

  function onAudioTimeUpdate() {
    if (!wordsData || wordsData.length === 0) return;
    
    const currentTimeMs = audioEl.currentTime * 1000;
    
    // Find current word
    wordsData.forEach((w, i) => {
      const span = subtitleText.querySelector(`[data-index="${i}"]`);
      if (!span) return;
      
      const begin = parseInt(span.dataset.begin);
      const end = parseInt(span.dataset.end);
      
      if (currentTimeMs >= begin && currentTimeMs <= end) {
        span.classList.add("active");
        span.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        span.classList.remove("active");
      }
    });
  }

  function clearSubtitle() {
    wordsData = [];
    if (subtitleText) {
      subtitleText.innerHTML = "";
    }
  }

  function log(message, type = "info") {
    const line = document.createElement("div");
    line.className = `tts-log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  return { init };
})();

window.TTSTab = TTSTab;
