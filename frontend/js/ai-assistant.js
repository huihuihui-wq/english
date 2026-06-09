/** AI 口语教练 - 前端逻辑（语音对话版） */
const AIAssistant = (() => {
  let isOpen = false;
  let currentMode = "chat";
  let examQuestions = [];
  let currentQuestionIndex = -1;
  let currentAudio = null;
  let isPlaying = false;

  // 录音相关
  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let recordingStartTime = 0;
  let recordingTimer = null;

  // DOM 元素
  let assistant, fabBtn, toggleBtn, overlay, messagesEl, inputEl, sendBtn, voiceBtn;
  let statusEl, modeBtns, examSetup, examQuestionsEl, generateBtn;
  let voiceHint;

  function init() {
    assistant = document.getElementById("aiAssistant");
    fabBtn = document.getElementById("aiFab");
    toggleBtn = document.getElementById("aiClose");
    overlay = document.getElementById("aiOverlay");
    messagesEl = document.getElementById("aiMessages");
    inputEl = document.getElementById("aiInput");
    sendBtn = document.getElementById("aiSendBtn");
    voiceBtn = document.getElementById("aiVoiceBtn");
    statusEl = document.getElementById("aiStatus");
    examSetup = document.getElementById("aiExamSetup");
    examQuestionsEl = document.getElementById("aiExamQuestions");
    generateBtn = document.getElementById("aiGenerateExam");
    voiceHint = document.getElementById("aiVoiceHint");

    modeBtns = document.querySelectorAll(".ai-mode-btn");

    bindEvents();
  }

  function bindEvents() {
    fabBtn.addEventListener("click", openPanel);
    toggleBtn.addEventListener("click", closePanel);
    overlay.addEventListener("click", closePanel);
    
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen) closePanel();
    });

    modeBtns.forEach((btn) => {
      btn.addEventListener("click", () => switchMode(btn.dataset.mode));
    });

    sendBtn.addEventListener("click", sendMessage);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // 语音按钮 - 按住录音
    voiceBtn.addEventListener("mousedown", startRecording);
    voiceBtn.addEventListener("mouseup", stopRecording);
    voiceBtn.addEventListener("mouseleave", stopRecording);
    voiceBtn.addEventListener("touchstart", (e) => {
      e.preventDefault();
      startRecording();
    });
    voiceBtn.addEventListener("touchend", (e) => {
      e.preventDefault();
      stopRecording();
    });

    generateBtn.addEventListener("click", generateExam);
    window.addEventListener("shadow:completed", onPracticeCompleted);
  }

  function openPanel() {
    isOpen = true;
    assistant.classList.add("open");
    fabBtn.classList.add("hidden");
    document.body.style.overflow = "hidden";
  }

  function closePanel() {
    isOpen = false;
    assistant.classList.remove("open");
    fabBtn.classList.remove("hidden");
    document.body.style.overflow = "";
    stopAudio();
  }

  function switchMode(mode) {
    currentMode = mode;
    modeBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    examSetup.hidden = mode !== "exam";

    if (mode === "exam") {
      addSystemMessage(`切换到雅思模考模式。跟练完成后点击"生成试题"，我会根据视频内容生成口语题目。`);
    } else {
      addSystemMessage("切换到自由对话模式。你可以随时用英语和我对话练习。");
    }
  }

  // ========== 录音功能 ==========
  async function startRecording() {
    if (isRecording) return;
    
    try {
      // 请求麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });
      
      // 创建MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
      
      mediaRecorder = new MediaRecorder(stream, { mimeType });
      audioChunks = [];
      
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };
      
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: mimeType });
        await processVoiceMessage(audioBlob);
        
        // 停止所有音轨
        stream.getTracks().forEach(track => track.stop());
      };
      
      mediaRecorder.start(100); // 每100ms收集一次数据
      isRecording = true;
      recordingStartTime = Date.now();
      
      // 更新UI
      voiceBtn.classList.add("recording");
      voiceHint.textContent = "录音中... 松开发送";
      
      // 显示录音时长
      recordingTimer = setInterval(() => {
        const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
        voiceHint.textContent = `录音中 ${duration}s... 松开发送`;
      }, 1000);
      
    } catch (err) {
      console.error("录音失败:", err);
      voiceHint.textContent = "无法访问麦克风，请检查权限设置";
      alert("无法访问麦克风，请检查浏览器权限设置");
    }
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder) return;
    
    isRecording = false;
    clearInterval(recordingTimer);
    
    voiceBtn.classList.remove("recording");
    voiceHint.textContent = "处理中...";
    
    if (mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  }

  // ========== 处理语音消息 ==========
  async function processVoiceMessage(audioBlob) {
    const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
    
    if (duration < 1) {
      voiceHint.textContent = "录音时间太短，请重试";
      return;
    }
    
    // 显示用户语音消息
    const userMsgEl = addVoiceMessage("user", "", duration);
    
    showTyping();
    setStatus("thinking", "识别中...");
    
    try {
      // 上传到后端
      const formData = new FormData();
      formData.append("file", audioBlob, "recording.webm");
      
      // 添加视频上下文
      const subtitles = getCurrentSubtitles();
      if (subtitles) {
        const context = subtitles.map(s => s.en).join(" ");
        formData.append("context", context);
      }
      
      const resp = await fetch("/api/ai/voice-chat", {
        method: "POST",
        body: formData,
      });
      
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      
      const data = await resp.json();
      
      hideTyping();
      
      // 更新用户消息文字
      if (data.user_text) {
        updateVoiceMessageText(userMsgEl, data.user_text);
      }
      
      if (data.ai_text) {
        // 显示AI语音消息
        const aiMsgEl = addVoiceMessage("assistant", data.ai_text, null, data.audio_base64);
        setStatus("ready", "就绪");
        
        // 自动播放
        if (data.audio_base64) {
          setTimeout(() => {
            playAudioFromBase64(data.audio_base64, aiMsgEl);
          }, 300);
        }
      } else {
        addSystemMessage("抱歉，我没有听清，请再说一遍。");
        setStatus("ready", "就绪");
      }
      
    } catch (error) {
      hideTyping();
      console.error("语音处理失败:", error);
      addSystemMessage(`语音处理失败: ${error.message}`);
      setStatus("error", "错误");
    }
    
    voiceHint.textContent = "按住麦克风按钮说话";
  }

  // ========== 语音消息渲染 ==========
  function addVoiceMessage(role, text, duration, audioBase64 = null) {
    const msgEl = document.createElement("div");
    msgEl.className = `ai-message ${role}`;
    msgEl.dataset.msgId = Date.now();

    const avatar = document.createElement("div");
    avatar.className = "ai-avatar";
    avatar.textContent = role === "user" ? "🧑" : "🤖";

    const wrapper = document.createElement("div");
    wrapper.className = "ai-msg-wrapper";

    // 语音消息UI
    const voiceEl = document.createElement("div");
    voiceEl.className = "ai-voice-msg";
    
    // 播放按钮
    const playBtn = document.createElement("button");
    playBtn.className = "ai-voice-play";
    playBtn.innerHTML = `<span class="ai-voice-icon">▶</span>`;
    
    if (audioBase64) {
      playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleAudioPlayback(audioBase64, voiceEl);
      });
    } else if (role === "user") {
      // 用户消息没有音频，显示文字
      playBtn.style.display = "none";
    }

    // 波形
    const waveEl = document.createElement("div");
    waveEl.className = "ai-voice-wave";
    for (let i = 0; i < 20; i++) {
      const bar = document.createElement("span");
      bar.style.height = `${Math.random() * 60 + 20}%`;
      bar.style.animationDelay = `${i * 0.05}s`;
      waveEl.appendChild(bar);
    }

    // 信息
    const infoEl = document.createElement("div");
    infoEl.className = "ai-voice-info";
    
    if (duration) {
      infoEl.innerHTML = `<span class="ai-voice-duration">${duration}"</span>`;
    } else {
      infoEl.innerHTML = `<span class="ai-voice-duration">语音</span>`;
    }
    
    if (text) {
      infoEl.innerHTML += `<span class="ai-voice-text">${text.substring(0, 30)}${text.length > 30 ? "..." : ""}</span>`;
    }

    voiceEl.appendChild(playBtn);
    voiceEl.appendChild(waveEl);
    voiceEl.appendChild(infoEl);

    wrapper.appendChild(voiceEl);

    // 时间
    const timeEl = document.createElement("div");
    timeEl.className = "ai-msg-time";
    timeEl.textContent = new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    wrapper.appendChild(timeEl);

    msgEl.appendChild(avatar);
    msgEl.appendChild(wrapper);
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    return msgEl;
  }

  function updateVoiceMessageText(msgEl, text) {
    const infoEl = msgEl.querySelector(".ai-voice-info");
    if (infoEl) {
      const durationSpan = infoEl.querySelector(".ai-voice-duration");
      const duration = durationSpan ? durationSpan.textContent : "";
      infoEl.innerHTML = `
        <span class="ai-voice-duration">${duration}</span>
        <span class="ai-voice-text">${text.substring(0, 30)}${text.length > 30 ? "..." : ""}</span>
      `;
    }
  }

  // ========== 音频播放 ==========
  function playAudioFromBase64(base64, voiceEl) {
    stopAudio();
    
    try {
      const audioBytes = atob(base64);
      const arrayBuffer = new ArrayBuffer(audioBytes.length);
      const view = new Uint8Array(arrayBuffer);
      for (let i = 0; i < audioBytes.length; i++) {
        view[i] = audioBytes.charCodeAt(i);
      }
      
      const blob = new Blob([arrayBuffer], { type: "audio/mp3" });
      const url = URL.createObjectURL(blob);
      
      currentAudio = new Audio(url);
      
      currentAudio.onplay = () => {
        isPlaying = true;
        voiceEl.classList.add("playing");
        voiceEl.querySelector(".ai-voice-icon").textContent = "⏸";
      };
      
      currentAudio.onended = () => {
        isPlaying = false;
        voiceEl.classList.remove("playing");
        voiceEl.querySelector(".ai-voice-icon").textContent = "▶";
        URL.revokeObjectURL(url);
        currentAudio = null;
      };
      
      currentAudio.onerror = () => {
        isPlaying = false;
        voiceEl.classList.remove("playing");
        voiceEl.querySelector(".ai-voice-icon").textContent = "▶";
        console.error("音频播放失败");
        URL.revokeObjectURL(url);
        currentAudio = null;
      };
      
      currentAudio.play();
      
    } catch (e) {
      console.error("音频播放错误:", e);
    }
  }

  function toggleAudioPlayback(base64, voiceEl) {
    if (isPlaying && currentAudio) {
      stopAudio();
      voiceEl.classList.remove("playing");
      voiceEl.querySelector(".ai-voice-icon").textContent = "▶";
    } else {
      playAudioFromBase64(base64, voiceEl);
    }
  }

  function stopAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    isPlaying = false;
    
    // 重置所有播放按钮
    document.querySelectorAll(".ai-voice-msg.playing").forEach(el => {
      el.classList.remove("playing");
      el.querySelector(".ai-voice-icon").textContent = "▶";
    });
  }

  // ========== 普通消息（备用） ==========
  function addMessage(content, role = "assistant") {
    const msgEl = document.createElement("div");
    msgEl.className = `ai-message ${role}`;

    const avatar = document.createElement("div");
    avatar.className = "ai-avatar";
    avatar.textContent = role === "user" ? "🧑" : "🤖";

    const contentEl = document.createElement("div");
    contentEl.className = "ai-msg-content";
    contentEl.textContent = content;

    const timeEl = document.createElement("div");
    timeEl.className = "ai-msg-time";
    timeEl.textContent = new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const wrapper = document.createElement("div");
    wrapper.className = "ai-msg-wrapper";
    wrapper.appendChild(contentEl);
    wrapper.appendChild(timeEl);

    msgEl.appendChild(avatar);
    msgEl.appendChild(wrapper);
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addSystemMessage(content) {
    const msgEl = document.createElement("div");
    msgEl.className = "ai-message system";
    msgEl.innerHTML = `<div class="ai-msg-content">${content}</div>`;
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    const typingEl = document.createElement("div");
    typingEl.className = "ai-message assistant typing-indicator";
    typingEl.id = "aiTyping";
    typingEl.innerHTML = `
      <div class="ai-avatar">🤖</div>
      <div class="ai-typing">
        <span></span><span></span><span></span>
      </div>
    `;
    messagesEl.appendChild(typingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    const typing = document.getElementById("aiTyping");
    if (typing) typing.remove();
  }

  // ========== 文字消息发送（带语音） ==========
  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;

    addMessage(text, "user");
    inputEl.value = "";

    showTyping();
    setStatus("thinking", "思考中...");

    try {
      let result;

      if (currentMode === "exam" && currentQuestionIndex >= 0) {
        result = await fetchExamResponse(text);
      } else {
        result = await fetchChatResponse(text);
      }

      hideTyping();

      // 如果有语音数据，渲染为语音消息
      if (result.audio_base64) {
        const aiMsgEl = addVoiceMessage("assistant", result.reply || result, null, result.audio_base64);
        setStatus("ready", "就绪");

        // 自动播放
        setTimeout(() => {
          const voiceEl = aiMsgEl.querySelector(".ai-voice-msg");
          if (voiceEl) {
            playAudioFromBase64(result.audio_base64, voiceEl);
          }
        }, 300);
      } else {
        // 没有语音，显示普通文字
        addMessage(result.reply || result, "assistant");
        setStatus("ready", "就绪");
      }
    } catch (error) {
      hideTyping();
      addSystemMessage(`请求失败: ${error.message}`);
      setStatus("error", "错误");
    }
  }

  async function fetchChatResponse(text) {
    const subtitles = getCurrentSubtitles();
    const context = subtitles ? subtitles.map((s) => s.en).join(" ") : "";

    const resp = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        context: context,
        mode: "chat",
        voice: true,  // 请求语音回复
      }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  }

  async function fetchExamResponse(text) {
    const currentQ = examQuestions[currentQuestionIndex];

    const resp = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        question: currentQ,
        mode: "exam",
        questionIndex: currentQuestionIndex,
        totalQuestions: examQuestions.length,
        voice: true,  // 请求语音回复
      }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // 处理下一题或考试结束
    if (data.nextQuestion) {
      currentQuestionIndex++;
      setTimeout(() => {
        if (data.audio_base64) {
          const aiMsgEl = addVoiceMessage("assistant", data.nextQuestion, null, data.audio_base64);
          setTimeout(() => {
            const voiceEl = aiMsgEl.querySelector(".ai-voice-msg");
            if (voiceEl) playAudioFromBase64(data.audio_base64, voiceEl);
          }, 300);
        } else {
          addMessage(`**问题 ${currentQuestionIndex + 1}/${examQuestions.length}：**\n${data.nextQuestion}`, "assistant");
        }
      }, 1000);
    } else if (data.feedback) {
      setTimeout(() => {
        if (data.audio_base64) {
          const aiMsgEl = addVoiceMessage("assistant", data.feedback, null, data.audio_base64);
          setTimeout(() => {
            const voiceEl = aiMsgEl.querySelector(".ai-voice-msg");
            if (voiceEl) playAudioFromBase64(data.audio_base64, voiceEl);
          }, 300);
        } else {
          addMessage(`**考试结束！**\n\n${data.feedback}`, "assistant");
        }
      }, 1000);
      currentQuestionIndex = -1;
    }

    return data;
  }

  // ========== 试题生成 ==========
  async function generateExam() {
    const subtitles = getCurrentSubtitles();
    if (!subtitles || subtitles.length === 0) {
      addSystemMessage("请先加载一个视频素材，跟练完成后才能生成试题。");
      return;
    }

    generateBtn.disabled = true;
    generateBtn.innerHTML = "<span>⏳ 生成中...</span>";
    setStatus("thinking", "生成试题...");

    try {
      const resp = await fetch("/api/ai/generate-exam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subtitles: subtitles,
          count: 3,
        }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      examQuestions = data.questions;
      renderQuestions();
      addSystemMessage(`✅ 已生成 ${examQuestions.length} 道口语试题，点击下方题目开始模考。`);
    } catch (error) {
      addSystemMessage(`生成试题失败: ${error.message}`);
    } finally {
      generateBtn.disabled = false;
      generateBtn.innerHTML = "<span>✨ 生成试题</span>";
      setStatus("ready", "就绪");
    }
  }

  function renderQuestions() {
    examQuestionsEl.innerHTML = "";
    examQuestions.forEach((q, i) => {
      const card = document.createElement("div");
      card.className = "ai-question-card";
      card.innerHTML = `
        <div class="q-num">问题 ${i + 1}</div>
        <div class="q-text">${q}</div>
      `;
      card.addEventListener("click", () => startExam(i));
      examQuestionsEl.appendChild(card);
    });
  }

  function startExam(index) {
    currentQuestionIndex = index;
    const q = examQuestions[index];

    messagesEl.innerHTML = "";
    addSystemMessage("📝 雅思口语模考开始！请用英语回答以下问题。");
    setTimeout(() => {
      addMessage(`**问题 ${index + 1}/${examQuestions.length}：**\n${q}`, "assistant");
    }, 500);
  }

  // ========== 辅助功能 ==========
  function getCurrentSubtitles() {
    if (window.AppState && window.AppState.subtitles) {
      return window.AppState.subtitles;
    }
    return null;
  }

  function onPracticeCompleted() {
    if (!isOpen) {
      openPanel();
    }
    addSystemMessage(`🎉 跟练完成！切换到"雅思模考"模式，点击"生成试题"开始口语测试。`);
  }

  function setStatus(type, text) {
    statusEl.className = `ai-status ${type}`;
    statusEl.textContent = text;
  }

  return { init };
})();

window.AIAssistant = AIAssistant;
