// File upload + backend transcription
const Uploader = (() => {
  let dropzone, fileInput, pickBtn, progressWrap, progressLabel, progressFill, statusEl;

  function init() {
    dropzone = document.getElementById("dropzone");
    fileInput = document.getElementById("fileInput");
    pickBtn = document.getElementById("pickBtn");
    progressWrap = document.getElementById("progressWrap");
    progressLabel = document.getElementById("progressLabel");
    progressFill = document.getElementById("progressFill");
    statusEl = document.getElementById("status");

    dropzone.addEventListener("click", (e) => {
      if (e.target.tagName === "BUTTON") return;
      fileInput.click();
    });
    pickBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      fileInput.click();
    });

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    fileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) handleFile(f);
    });
  }

  function setStatus(text, cls = "idle") {
    statusEl.textContent = text;
    statusEl.className = `status ${cls}`;
  }

  function setProgress(percent, label) {
    progressWrap.hidden = false;
    progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (label) progressLabel.textContent = label;
  }

  function hideProgress() {
    progressWrap.hidden = true;
  }

  function handleFile(file) {
    const maxMB = 200;
    if (file.size > maxMB * 1024 * 1024) {
      alert(`File exceeds ${maxMB}MB limit`);
      return;
    }
    setStatus("Uploading…", "working");
    setProgress(10, `Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);

    const formData = new FormData();
    formData.append("file", file);
    const langSel = document.getElementById("uploadLanguage");
    if (langSel) {
      formData.append("language", langSel.value || "en");
    } else {
      formData.append("language", "en");
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/transcribe");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = (e.loaded / e.total) * 50;
        setProgress(pct, `Uploading ${(pct * 2).toFixed(0)}%`);
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          const data = JSON.parse(xhr.responseText);
          setProgress(100, "Done");
          setStatus("Ready", "ready");
          hideProgress();
          // Save to history
          if (window.History && window.History.save) {
            const firstSub = (data.subtitles && data.subtitles[0]) || {};
            window.History.save({
              type: "local",
              title: file.name,
              source: file.name,
              size_bytes: file.size,
              duration: data.duration || 0,
              subtitles: data.subtitles || [],
              raw_text: data.raw_text || "",
              source_lang: firstSub.source_lang || "en",
            });
          }
          window.dispatchEvent(new CustomEvent("transcribe:done", { detail: { file, data } }));
        } catch (e) {
          fail("Failed to parse response");
        }
      } else {
        let msg = `HTTP ${xhr.status}`;
        try {
          const err = JSON.parse(xhr.responseText);
          if (err.detail) msg = err.detail;
        } catch {}
        if (/too long|duration|exceeds/i.test(msg)) {
          msg = "Audio is too long. Long clips are auto-sliced; if this still fails, use a shorter clip or increase MAX_ASR_AUDIO_SECONDS in backend/.env.";
        }
        fail(msg);
      }
    };
    xhr.onerror = () => fail("Network error");
    xhr.onabort = () => fail("Cancelled");

    xhr.send(formData);

    setTimeout(() => {
      if (xhr.readyState !== 4) {
        setStatus("Transcribing…", "working");
        setProgress(60, "AI speech recognition in progress (may take 30-120s)");
      }
    }, 500);
  }

  function fail(msg) {
    setStatus(`Failed: ${msg}`, "error");
    hideProgress();
    alert("Transcription failed: " + msg);
  }

  return { init };
})();

window.Uploader = Uploader;
