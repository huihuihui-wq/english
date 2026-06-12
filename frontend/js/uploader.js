// File upload + backend transcription
const Uploader = (() => {
  let dropzone, fileInput, pickBtn, progressWrap, progressLabel, progressFill, statusEl;
  let cancelBtn;
  // Track the active XHR so the cancel button can abort it.
  // Only one upload at a time is supported; starting a new one cancels the previous.
  let activeXhr = null;
  let activeFile = null;

  function init() {
    dropzone = document.getElementById("dropzone");
    fileInput = document.getElementById("fileInput");
    pickBtn = document.getElementById("pickBtn");
    progressWrap = document.getElementById("progressWrap");
    progressLabel = document.getElementById("progressLabel");
    progressFill = document.getElementById("progressFill");
    statusEl = document.getElementById("status");
    cancelBtn = document.getElementById("cancelUploadBtn");

    if (cancelBtn) {
      cancelBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        cancelUpload();
      });
    }

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
      // Reset the input so selecting the same file again still triggers change
      e.target.value = "";
    });
  }

  function cancelUpload() {
    if (activeXhr) {
      try {
        activeXhr.abort();
      } catch (e) {
        console.warn("Failed to abort XHR:", e);
      }
    }
    activeXhr = null;
    activeFile = null;
    hideProgress();
    setStatus("Cancelled", "idle");
    if (window.showToast) {
      window.showToast("✕ Upload cancelled", "info", 2200);
    }
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
    // If a previous upload is in flight, cancel it before starting a new one.
    if (activeXhr) {
      try { activeXhr.abort(); } catch {}
      activeXhr = null;
    }
    activeFile = file;

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
    activeXhr = xhr;
    xhr.open("POST", "/api/transcribe");
    xhr.timeout = 600000;
    xhr.upload.onprogress = (e) => {
      // Ignore if this XHR has been superseded by a new upload
      if (activeXhr !== xhr) return;
      if (e.lengthComputable) {
        const pct = (e.loaded / e.total) * 50;
        setProgress(pct, `Uploading ${(pct * 2).toFixed(0)}%`);
      }
    };
    xhr.onload = () => {
      if (activeXhr === xhr) activeXhr = null;
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
    xhr.onerror = () => {
      if (activeXhr === xhr) activeXhr = null;
      // Don't alert on cancel — we already showed a toast
      if (xhr.readyState === XMLHttpRequest.UNSENT || xhr.readyState === XMLHttpRequest.DONE) {
        hideProgress();
        setStatus("Idle", "idle");
      } else {
        fail("Network error");
      }
    };
    xhr.onabort = () => {
      if (activeXhr === xhr) {
        activeXhr = null;
        hideProgress();
        setStatus("Cancelled", "idle");
      }
    };
    xhr.ontimeout = () => {
      if (activeXhr === xhr) activeXhr = null;
      fail("Request timed out. The audio is very long and may exceed server processing limits. Try a shorter clip (under 10 minutes).");
    };

    xhr.send(formData);

    setTimeout(() => {
      if (xhr.readyState !== 4 && activeXhr === xhr) {
        setStatus("Transcribing…", "working");
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        const estimatedTime = Math.max(30, Math.round(sizeMB * 5));
        setProgress(60, `AI speech recognition in progress (may take ${estimatedTime}s-${Math.round(estimatedTime * 2)}s for ${sizeMB}MB file)`);
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
