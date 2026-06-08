// 文件上传 + 后端转写
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
    const maxMB = 50;
    if (file.size > maxMB * 1024 * 1024) {
      alert(`文件超过 ${maxMB}MB 限制`);
      return;
    }
    setStatus("上传中…", "working");
    setProgress(10, `上传 ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);

    const formData = new FormData();
    formData.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/transcribe");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = (e.loaded / e.total) * 50;
        setProgress(pct, `上传中 ${(pct * 2).toFixed(0)}%`);
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          const data = JSON.parse(xhr.responseText);
          setProgress(100, "完成");
          setStatus("就绪", "ready");
          hideProgress();
          window.dispatchEvent(new CustomEvent("transcribe:done", { detail: { file, data } }));
        } catch (e) {
          fail("解析响应失败");
        }
      } else {
        let msg = `HTTP ${xhr.status}`;
        try {
          const err = JSON.parse(xhr.responseText);
          if (err.detail) msg = err.detail;
        } catch {}
        fail(msg);
      }
    };
    xhr.onerror = () => fail("网络错误");
    xhr.onabort = () => fail("已取消");

    xhr.send(formData);

    setTimeout(() => {
      if (xhr.readyState !== 4) {
        setStatus("识别中…", "working");
        setProgress(60, "AI 语音识别中（可能需要 30-60s）");
      }
    }, 500);
  }

  function fail(msg) {
    setStatus(`失败: ${msg}`, "error");
    hideProgress();
    alert("转写失败: " + msg);
  }

  return { init };
})();

window.Uploader = Uploader;
