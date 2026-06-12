/**
 * AI Voice Assistant - WeChat Style Voice Chat (Right Drawer)
 * All AI replies are voice (TTS) using qwen-tts
 */

(function() {
  'use strict';

  // State
  let isDrawerOpen = false;
  let isMuted = false;
  let isLoading = false;
  let isRecording = false;
  let isTestMode = false;
  let chatHistory = [];
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingTimer = null;
  let recordingSeconds = 0;
  let currentAudio = null;
  let testModeQuestion = null;

  // DOM Elements
  const els = {};

  function init() {
    console.log('[AI] Initializing AI assistant...');
    
    els.drawerToggle = document.getElementById('aiDrawerToggle');
    els.drawer = document.getElementById('aiDrawer');
    els.closeBtn = document.getElementById('aiCloseDrawer');
    els.muteBtn = document.getElementById('aiMuteToggle');
    els.chatContainer = document.getElementById('aiChatContainer');
    els.keyboardBtn = document.getElementById('aiKeyboardBtn');
    els.voiceHoldBtn = document.getElementById('aiVoiceHoldBtn');
    els.textInputArea = document.getElementById('aiTextInputArea');
    els.textInput = document.getElementById('aiTextInput');
    els.textSendBtn = document.getElementById('aiTextSend');
    els.moreBtn = document.getElementById('aiMoreBtn');
    els.voiceSelect = document.getElementById('aiVoiceSelect');
    els.recordingOverlay = document.getElementById('aiRecordingOverlay');
    els.audioPlayer = document.getElementById('aiAudioPlayer');
    els.statusText = document.getElementById('aiStatusText');
    els.testModeBtn = document.getElementById('aiTestModeBtn');
    els.testModeBar = document.getElementById('aiTestModeBar');
    els.testModeStop = document.getElementById('aiTestModeStop');

    console.log('[AI] Elements found:', {
      drawerToggle: !!els.drawerToggle,
      drawer: !!els.drawer,
      closeBtn: !!els.closeBtn
    });

    bindEvents();
    console.log('[AI] Initialization complete');
  }

  function bindEvents() {
    // Drawer toggle
    if (els.drawerToggle) {
      els.drawerToggle.addEventListener('click', toggleDrawer);
    }
    if (els.closeBtn) {
      els.closeBtn.addEventListener('click', closeDrawer);
    }
    if (els.muteBtn) {
      els.muteBtn.addEventListener('click', toggleMute);
    }

    // Voice hold button
    if (els.voiceHoldBtn) {
      els.voiceHoldBtn.addEventListener('mousedown', startRecording);
      els.voiceHoldBtn.addEventListener('mouseup', stopRecording);
      els.voiceHoldBtn.addEventListener('mouseleave', stopRecording);
      
      els.voiceHoldBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startRecording();
      });
      els.voiceHoldBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        stopRecording();
      });
      els.voiceHoldBtn.addEventListener('touchcancel', (e) => {
        e.preventDefault();
        stopRecording();
      });
    }

    // Keyboard toggle
    if (els.keyboardBtn) {
      els.keyboardBtn.addEventListener('click', toggleTextInput);
    }

    // Text input
    if (els.textSendBtn) {
      els.textSendBtn.addEventListener('click', sendTextMessage);
    }
    if (els.textInput) {
      els.textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendTextMessage();
      });
    }

    // Audio player events
    if (els.audioPlayer) {
      els.audioPlayer.addEventListener('ended', () => {
        stopVoiceAnimation();
      });
      els.audioPlayer.addEventListener('error', () => {
        stopVoiceAnimation();
      });
    }

    // Test mode
    if (els.testModeBtn) {
      els.testModeBtn.addEventListener('click', startTestMode);
    }
    if (els.testModeStop) {
      els.testModeStop.addEventListener('click', stopTestMode);
    }

    // Close drawer on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isDrawerOpen) {
        closeDrawer();
      }
    });
  }

  // Test Mode Functions
  async function startTestMode() {
    if (isLoading || isTestMode) return;

    const subtitles = getSubtitleContext();
    if (!subtitles) {
      alert('请先加载视频字幕');
      return;
    }

    isTestMode = true;
    isLoading = true;
    els.testModeBar.classList.remove('hidden');
    els.statusText.textContent = '准备测试中...';

    // Clear chat and show test welcome
    els.chatContainer.innerHTML = '';
    addSystemMessage('📺 视频测试模式已启动');
    addSystemMessage('正在分析视频内容，准备提问...');

    try {
      const resp = await fetch('/api/ai/video-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtitles: subtitles,
          voice: els.voiceSelect ? els.voiceSelect.value : 'Cherry'
        })
      });

      const data = await resp.json();

      if (data.ok) {
        testModeQuestion = data.question;
        // Add AI question as voice message
        const aiMessageId = addVoiceMessage('ai', null, data.question);

        // Auto-play
        if (data.audio && !isMuted) {
          playAudio(data.audio, aiMessageId);
        }

        chatHistory.push({ role: 'assistant', content: data.question });
        els.statusText.textContent = '测试中';
      } else {
        addSystemMessage('❌ ' + (data.detail || '启动测试失败'));
        stopTestMode();
      }
    } catch (e) {
      addSystemMessage('❌ 网络错误: ' + e.message);
      stopTestMode();
    } finally {
      isLoading = false;
    }
  }

  function stopTestMode() {
    isTestMode = false;
    testModeQuestion = null;
    els.testModeBar.classList.add('hidden');
    els.statusText.textContent = '在线';
    addSystemMessage('📺 已退出视频测试模式');
  }

  async function handleTestModeResponse(userText) {
    if (!isTestMode || !testModeQuestion) return;

    isLoading = true;
    els.statusText.textContent = '思考中...';

    // Show loading
    const loadingId = addLoadingBubble();

    try {
      const resp = await fetch('/api/ai/video-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtitles: getSubtitleContext(),
          previous_question: testModeQuestion,
          user_answer: userText,
          history: chatHistory.slice(-10),
          voice: els.voiceSelect ? els.voiceSelect.value : 'Cherry'
        })
      });

      const data = await resp.json();
      removeMessage(loadingId);

      if (data.ok) {
        // Update question
        testModeQuestion = data.question;

        // Add AI response
        const aiMessageId = addVoiceMessage('ai', null, data.question);

        if (data.audio && !isMuted) {
          playAudio(data.audio, aiMessageId);
        }

        chatHistory.push({ role: 'user', content: userText });
        chatHistory.push({ role: 'assistant', content: data.question });
        els.statusText.textContent = '测试中';
      } else {
        addSystemMessage('❌ ' + (data.detail || '测试失败'));
      }
    } catch (e) {
      removeMessage(loadingId);
      addSystemMessage('❌ 网络错误: ' + e.message);
    } finally {
      isLoading = false;
    }
  }

  // Drawer functions
  function toggleDrawer() {
    console.log('[AI] Toggle drawer, current state:', isDrawerOpen);
    isDrawerOpen = !isDrawerOpen;
    if (els.drawer) {
      els.drawer.classList.toggle('hidden', !isDrawerOpen);
    }
    if (els.drawerToggle) {
      els.drawerToggle.classList.toggle('active', isDrawerOpen);
    }
  }

  function closeDrawer() {
    console.log('[AI] Closing drawer');
    isDrawerOpen = false;
    if (els.drawer) {
      els.drawer.classList.add('hidden');
    }
    if (els.drawerToggle) {
      els.drawerToggle.classList.remove('active');
    }
    // Stop any playing audio
    if (els.audioPlayer) {
      els.audioPlayer.pause();
      stopVoiceAnimation();
    }
  }

  function toggleMute() {
    isMuted = !isMuted;
    els.muteBtn.textContent = isMuted ? '🔇' : '🔊';
    els.muteBtn.title = isMuted ? '取消静音' : '静音';
    if (isMuted && els.audioPlayer) {
      els.audioPlayer.pause();
      stopVoiceAnimation();
    }
  }

  // Text input toggle
  function toggleTextInput() {
    const isTextMode = !els.textInputArea.classList.contains('hidden');
    if (isTextMode) {
      // Switch back to voice
      els.textInputArea.classList.add('hidden');
      els.voiceHoldBtn.classList.remove('hidden');
      els.keyboardBtn.textContent = '⌨️';
      els.keyboardBtn.title = '键盘输入';
    } else {
      // Switch to text
      els.voiceHoldBtn.classList.add('hidden');
      els.textInputArea.classList.remove('hidden');
      els.keyboardBtn.textContent = '🎙️';
      els.keyboardBtn.title = '语音输入';
      els.textInput.focus();
    }
  }

  // Recording functions
  async function startRecording() {
    if (isRecording || isLoading) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      audioChunks = [];
      
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        if (audioChunks.length > 0) {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          await sendVoiceMessage(audioBlob, recordingSeconds);
        }
        hideRecordingOverlay();
      };

      mediaRecorder.start();
      isRecording = true;
      recordingSeconds = 0;
      
      // Show overlay
      showRecordingOverlay();
      
      // Timer
      recordingTimer = setInterval(() => {
        recordingSeconds++;
        if (recordingSeconds >= 60) {
          stopRecording();
        }
      }, 1000);

    } catch (e) {
      console.error('录音失败:', e);
      alert('无法访问麦克风，请检查权限设置');
      hideRecordingOverlay();
    }
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder) return;
    
    clearInterval(recordingTimer);
    
    if (mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    
    isRecording = false;
    mediaRecorder = null;
  }

  function showRecordingOverlay() {
    els.recordingOverlay.classList.remove('hidden');
    els.voiceHoldBtn.classList.add('recording');
    els.statusText.textContent = '正在听...';
  }

  function hideRecordingOverlay() {
    els.recordingOverlay.classList.add('hidden');
    els.voiceHoldBtn.classList.remove('recording');
    els.statusText.textContent = '在线';
  }

  // Voice message functions
  async function sendVoiceMessage(audioBlob, duration) {
    if (isLoading) return;
    
    isLoading = true;
    els.statusText.textContent = '思考中...';
    
    // Add user voice message
    const userMessageId = addVoiceMessage('user', duration);
    
    // Show AI loading
    const loadingId = addLoadingBubble();

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'voice.webm');
      formData.append('context', getSubtitleContext());
      formData.append('history', JSON.stringify(chatHistory.slice(-10)));
      formData.append('voice', els.voiceSelect ? els.voiceSelect.value : 'Cherry');

      const resp = await fetch('/api/ai/voice-chat', {
        method: 'POST',
        body: formData
      });

      const data = await resp.json();
      
      // Remove loading
      removeMessage(loadingId);
      
      if (data.ok) {
        // Update user message with transcription
        if (data.transcription) {
          updateVoiceTranscription(userMessageId, data.transcription);
        }
        
        // Check if in test mode
        if (isTestMode && data.transcription) {
          await handleTestModeResponse(data.transcription);
          return;
        }
        
        // Add AI voice reply
        const aiMessageId = addVoiceMessage('ai', null, data.reply);
        
        // Store in history
        chatHistory.push({ 
          role: 'user', 
          content: data.transcription || '(语音)' 
        });
        chatHistory.push({ 
          role: 'assistant', 
          content: data.reply 
        });
        
        // Auto-play AI voice
        if (data.audio && !isMuted) {
          playAudio(data.audio, aiMessageId);
        }
      } else {
        addSystemMessage('❌ ' + (data.detail || '语音处理失败'));
      }
    } catch (e) {
      removeMessage(loadingId);
      addSystemMessage('❌ 网络错误: ' + e.message);
    } finally {
      isLoading = false;
      els.statusText.textContent = isTestMode ? '测试中' : '在线';
    }
  }

  // Text message (fallback)
  async function sendTextMessage() {
    if (isLoading) return;
    
    const text = els.textInput.value.trim();
    if (!text) return;
    
    els.textInput.value = '';
    
    // Check if in test mode
    if (isTestMode) {
      addTextMessage('user', text);
      await handleTestModeResponse(text);
      return;
    }
    
    isLoading = true;
    els.statusText.textContent = '思考中...';
    
    // Add user text message (display as text since it's text input)
    addTextMessage('user', text);
    
    // Show AI loading
    const loadingId = addLoadingBubble();

    try {
      const resp = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          context: getSubtitleContext(),
          history: chatHistory.slice(-10),
          voice: els.voiceSelect ? els.voiceSelect.value : 'Cherry'
        })
      });

      const data = await resp.json();
      
      removeMessage(loadingId);
      
      if (data.ok) {
        // Add AI voice reply (even for text input, reply is voice)
        const aiMessageId = addVoiceMessage('ai', null, data.reply);
        
        chatHistory.push({ role: 'user', content: text });
        chatHistory.push({ role: 'assistant', content: data.reply });
        
        if (data.audio && !isMuted) {
          playAudio(data.audio, aiMessageId);
        }
      } else {
        addSystemMessage('❌ ' + (data.detail || '请求失败'));
      }
    } catch (e) {
      removeMessage(loadingId);
      addSystemMessage('❌ 网络错误: ' + e.message);
    } finally {
      isLoading = false;
      els.statusText.textContent = '在线';
    }
  }

  // UI Message functions
  function addVoiceMessage(role, duration, text) {
    const id = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    
    const row = document.createElement('div');
    row.className = 'ai-voice-row ' + role;
    row.id = id;
    
    const isUser = role === 'user';
    const avatar = isUser ? '👤' : '🤖';
    const durationText = duration ? `${duration}"` : '';
    
    row.innerHTML = `
      <div class="ai-voice-avatar">${avatar}</div>
      <div class="ai-voice-bubble ${role}" data-msg-id="${id}">
        <span class="ai-voice-icon">${isUser ? '🎤' : '🔊'}</span>
        <div class="ai-voice-bar">
          <span></span><span></span><span></span><span></span><span></span>
        </div>
        <span class="ai-voice-duration">${durationText}</span>
      </div>
    `;
    
    if (text && !isUser) {
      const transcription = document.createElement('div');
      transcription.className = 'ai-transcription';
      transcription.textContent = text;
      row.appendChild(transcription);
    }
    
    // Add click to replay
    const bubble = row.querySelector('.ai-voice-bubble');
    if (bubble) {
      bubble.addEventListener('click', () => {
        const audioData = bubble.dataset.audio;
        if (audioData) {
          playAudio(audioData, id);
        }
      });
    }
    
    els.chatContainer.appendChild(row);
    scrollToBottom();
    
    return id;
  }

  function updateVoiceTranscription(msgId, text) {
    const msg = document.getElementById(msgId);
    if (!msg) return;
    
    // Check if transcription already exists
    let trans = msg.querySelector('.ai-transcription');
    if (!trans) {
      trans = document.createElement('div');
      trans.className = 'ai-transcription';
      msg.appendChild(trans);
    }
    trans.textContent = text;
    scrollToBottom();
  }

  function addTextMessage(role, text) {
    const id = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    
    const row = document.createElement('div');
    row.className = 'ai-voice-row ' + role;
    row.id = id;
    
    const isUser = role === 'user';
    const avatar = isUser ? '👤' : '🤖';
    
    row.innerHTML = `
      <div class="ai-voice-avatar">${avatar}</div>
      <div class="ai-voice-bubble ${role}" style="min-width:auto;max-width:280px;">
        <span style="font-size:13px;color:${isUser ? '#fff' : 'var(--text)'};">${escapeHtml(text)}</span>
      </div>
    `;
    
    els.chatContainer.appendChild(row);
    scrollToBottom();
    
    return id;
  }

  function addLoadingBubble() {
    const id = 'loading-' + Date.now();
    
    const row = document.createElement('div');
    row.className = 'ai-voice-row ai';
    row.id = id;
    
    row.innerHTML = `
      <div class="ai-voice-avatar">🤖</div>
      <div class="ai-loading-bubble">
        <div class="ai-loading-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
    
    els.chatContainer.appendChild(row);
    scrollToBottom();
    
    return id;
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'ai-chat-welcome';
    div.innerHTML = `<div class="ai-welcome-bubble" style="background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.2);">${escapeHtml(text)}</div>`;
    els.chatContainer.appendChild(div);
    scrollToBottom();
  }

  function removeMessage(id) {
    const msg = document.getElementById(id);
    if (msg) msg.remove();
  }

  // Audio playback
  function playAudio(base64Audio, msgId) {
    if (!base64Audio || isMuted) return;
    
    try {
      stopCurrentAudio();
      
      currentAudio = msgId;
      
      // Store audio data on the bubble for replay
      const bubble = document.querySelector(`[data-msg-id="${msgId}"]`);
      if (bubble) {
        bubble.dataset.audio = base64Audio;
      }
      
      els.audioPlayer.src = 'data:audio/mp3;base64,' + base64Audio;
      els.audioPlayer.play().then(() => {
        startVoiceAnimation(msgId);
      }).catch(e => {
        console.log('Audio play failed:', e);
        stopVoiceAnimation();
      });
    } catch (e) {
      console.error('Audio playback error:', e);
    }
  }

  function stopCurrentAudio() {
    if (els.audioPlayer) {
      els.audioPlayer.pause();
      els.audioPlayer.currentTime = 0;
    }
    stopVoiceAnimation();
  }

  function startVoiceAnimation(msgId) {
    // Stop any existing animation
    stopVoiceAnimation();
    
    // Start new animation
    const bubble = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (bubble) {
      const icon = bubble.querySelector('.ai-voice-icon');
      if (icon) {
        icon.classList.add('playing');
      }
    }
  }

  function stopVoiceAnimation() {
    document.querySelectorAll('.ai-voice-icon.playing').forEach(icon => {
      icon.classList.remove('playing');
    });
    currentAudio = null;
  }

  // Utility functions
  function scrollToBottom() {
    els.chatContainer.scrollTop = els.chatContainer.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function getSubtitleContext() {
    const subtitleList = document.getElementById('subtitleList');
    if (!subtitleList) return '';
    
    const items = subtitleList.querySelectorAll('.subtitle-item');
    const texts = [];
    items.forEach((item, i) => {
      if (i < 20) {
        const en = item.querySelector('.sub-en');
        if (en) texts.push(en.textContent.trim());
      }
    });
    return texts.join('\n');
  }

  // Public API for subtitle interaction
  window.AIAssistant = {
    playAudioFromBase64: function(base64) {
      playAudio(base64, '');
    },
    togglePanel: toggleDrawer,
    openPanel: function() {
      if (!isDrawerOpen) toggleDrawer();
    },
    closePanel: closeDrawer,
    switchMode: switchMode,
    askAboutSubtitle: async function(subtitleText) {
      // Open drawer if closed
      if (!isDrawerOpen) {
        toggleDrawer();
      }
      
      // Add user message
      addTextMessage('user', subtitleText);
      
      isLoading = true;
      els.statusText.textContent = '思考中...';
      const loadingId = addLoadingBubble();
      
      try {
        const resp = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `Can you explain this sentence: "${subtitleText}"`,
            context: getSubtitleContext(),
            history: chatHistory.slice(-10),
            voice: els.voiceSelect ? els.voiceSelect.value : 'Cherry'
          })
        });
        
        const data = await resp.json();
        removeMessage(loadingId);
        
        if (data.ok) {
          const aiMessageId = addVoiceMessage('ai', null, data.reply);
          chatHistory.push({ role: 'user', content: subtitleText });
          chatHistory.push({ role: 'assistant', content: data.reply });
          
          if (data.audio && !isMuted) {
            playAudio(data.audio, aiMessageId);
          }
        } else {
          addSystemMessage('❌ ' + (data.detail || '请求失败'));
        }
      } catch (e) {
        removeMessage(loadingId);
        addSystemMessage('❌ 网络错误: ' + e.message);
      } finally {
        isLoading = false;
        els.statusText.textContent = '在线';
      }
    }
  };

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
