/** Video link handler - supports YouTube and direct video links */
const LinkHandler = (() => {
  let videoContainer, video, youtubePlayer;
  let youtubeIframe = null;
  let currentVideoUrl = '';
  let currentSubtitles = [];

  // YouTube IFrame API state - we use postMessage polling because
  // the local <video> element does NOT get timeupdate events when
  // YouTube is playing inside its iframe.
  let ytCurrentTime = 0;
  let ytDuration = 0;
  let ytIsPlaying = false;
  let ytPollHandle = null;
  let ytPostMessageListener = null;
  let ytCommandQueue = [];

  function init() {
    document.querySelectorAll('.input-tab').forEach(tab => {
      tab.addEventListener('click', () => switchInputTab(tab.dataset.tab));
    });

    const loadBtn = document.getElementById('loadLinkBtn');
    const linkInput = document.getElementById('videoLinkInput');
    
    if (loadBtn) {
      loadBtn.addEventListener('click', () => handleLinkLoad());
    }
    
    if (linkInput) {
      linkInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleLinkLoad();
      });
    }

    document.querySelectorAll('.link-example').forEach(el => {
      el.addEventListener('click', () => {
        if (linkInput) {
          linkInput.value = el.dataset.url;
          handleLinkLoad();
        }
      });
    });

    const uploadSubBtn = document.getElementById('uploadSubBtn');
    const generateSubBtn = document.getElementById('generateSubBtn');
    const subFileInput = document.getElementById('subFileInput');
    
    if (uploadSubBtn && subFileInput) {
      uploadSubBtn.addEventListener('click', () => subFileInput.click());
      subFileInput.addEventListener('change', handleSubtitleUpload);
    }
    
    if (generateSubBtn) {
      generateSubBtn.addEventListener('click', handleSubtitleGeneration);
    }

    videoContainer = document.getElementById('videoContainer');
    video = document.getElementById('video');
    youtubePlayer = document.getElementById('youtubePlayer');
  }

  function switchInputTab(tab) {
    document.querySelectorAll('.input-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    
    document.getElementById('filePanel').classList.toggle('hidden', tab !== 'file');
    document.getElementById('linkPanel').classList.toggle('hidden', tab !== 'link');
  }

  async function handleLinkLoad() {
    const input = document.getElementById('videoLinkInput');
    const url = input.value.trim();
    
    if (!url) {
      alert('Please enter a video URL');
      return;
    }

    currentVideoUrl = url;
    
    const progressWrap = document.getElementById('linkProgressWrap');
    const progressLabel = document.getElementById('linkProgressLabel');
    const progressFill = document.getElementById('linkProgressFill');
    
    progressWrap.hidden = false;
    progressLabel.textContent = 'Parsing link...';
    progressFill.style.width = '30%';

    try {
      const youtubeId = extractYouTubeId(url);
      
      if (youtubeId) {
        progressLabel.textContent = 'Loading YouTube player...';
        progressFill.style.width = '60%';
        loadYouTubeVideo(youtubeId);
        progressFill.style.width = '100%';
        progressLabel.textContent = 'Loaded!';
        showPlayer(`YouTube: ${youtubeId}`);
      } else if (isDirectVideoUrl(url)) {
        progressLabel.textContent = 'Loading video...';
        progressFill.style.width = '60%';
        loadDirectVideo(url);
        progressFill.style.width = '100%';
        progressLabel.textContent = 'Loaded!';
        showPlayer(url.split('/').pop() || 'Online Video');
      } else {
        throw new Error('Unsupported link format. Only YouTube and MP4/WebM direct links are supported.');
      }

      const subControls = document.getElementById('subtitleControls');
      if (subControls) subControls.hidden = false;
      
      setTimeout(() => {
        progressWrap.hidden = true;
      }, 1500);

    } catch (error) {
      progressLabel.textContent = 'Load failed';
      progressFill.style.width = '100%';
      progressFill.style.background = 'var(--danger)';
      alert(`Load failed: ${error.message}`);
      
      setTimeout(() => {
        progressWrap.hidden = true;
        progressFill.style.background = '';
      }, 2000);
    }
  }

  function extractYouTubeId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^\&\s?]+)/,
      /youtube\.com\/watch\?.*v=([^\&\s]+)/,
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  function isDirectVideoUrl(url) {
    return url.match(/\.(mp4|webm|ogg|mov)(\?.*)?$/i) !== null;
  }

  function loadYouTubeVideo(videoId) {
    video.classList.add('hidden');
    youtubePlayer.classList.remove('hidden');
    youtubePlayer.innerHTML = '';

    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`;
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.title = 'YouTube video player';

    youtubePlayer.appendChild(iframe);
    youtubeIframe = iframe;

    // Reset YouTube state
    ytCurrentTime = 0;
    ytDuration = 0;
    ytIsPlaying = false;
    ytCommandQueue = [];

    // Set up postMessage listener for YouTube IFrame API responses
    if (!ytPostMessageListener) {
      ytPostMessageListener = (event) => {
        // YouTube IFrame API sends messages prefixed with certain patterns.
        // We extract numeric time/duration from the response.
        if (typeof event.data !== 'string') return;
        const data = event.data;
        // Match patterns like "{\"event\":\"infoDelivery\",\"info\":{\"currentTime\":12.34}}"
        // or "{\"event\":\"onStateChange\"...}"
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object') {
            if (parsed.event === 'infoDelivery' && parsed.info) {
              if (typeof parsed.info.currentTime === 'number') {
                ytCurrentTime = parsed.info.currentTime;
              }
              if (typeof parsed.info.duration === 'number') {
                ytDuration = parsed.info.duration;
              }
            } else if (parsed.event === 'onStateChange') {
              if (parsed.info === 1) ytIsPlaying = true;     // playing
              else if (parsed.info === 2) ytIsPlaying = false; // paused
              else if (parsed.info === 0) ytIsPlaying = false; // ended
            }
          }
        } catch (e) {
          // Not a YouTube API message - ignore.
        }
      };
      window.addEventListener('message', ytPostMessageListener);
    }

    // Poll the IFrame every 250ms. We queue getCurrentTime, getDuration,
    // and playerState commands; YouTube responds via postMessage.
    if (ytPollHandle) clearInterval(ytPollHandle);
    ytPollHandle = setInterval(() => {
      if (!youtubeIframe || !youtubeIframe.contentWindow) return;
      try {
        // Send a fresh getCurrentTime every poll - YouTube replies asynchronously
        // via the 'message' listener above.
        youtubeIframe.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: 'getCurrentTime', args: [] }),
          '*'
        );
        // Throttle duration/state queries to once per ~1s
        if (!ytPollHandle._tick) ytPollHandle._tick = 0;
        ytPollHandle._tick++;
        if (ytPollHandle._tick % 4 === 0) {
          youtubeIframe.contentWindow.postMessage(
            JSON.stringify({ event: 'command', func: 'getDuration', args: [] }),
            '*'
          );
          youtubeIframe.contentWindow.postMessage(
            JSON.stringify({ event: 'command', func: 'getPlayerState', args: [] }),
            '*'
          );
        }
      } catch (e) {
        // Cross-origin or iframe not ready - skip.
      }
    }, 250);

    console.log('[LinkHandler] YouTube video loaded with time polling:', videoId);
  }

  /**
   * Send a command to the YouTube iframe. Returns a promise that resolves
   * when the iframe acknowledges the command (not when the action completes).
   */
  function sendYouTubeCommand(command, args = []) {
    if (!youtubeIframe || !youtubeIframe.contentWindow) return;
    try {
      youtubeIframe.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: command, args }),
        '*'
      );
    } catch (e) {
      // ignore
    }
  }

  /**
   * Get current playback time. For YouTube, returns the polled value
   * (0 if not yet polled). For direct video, returns the local <video>.currentTime.
   */
  function getCurrentTime() {
    if (youtubeIframe) {
      return ytCurrentTime || 0;
    }
    return video ? (video.currentTime || 0) : 0;
  }

  function getDuration() {
    if (youtubeIframe) {
      return ytDuration || 0;
    }
    return video ? (video.duration || 0) : 0;
  }

  function isYouTubePlaying() {
    if (youtubeIframe) {
      return ytIsPlaying;
    }
    return video ? !video.paused : false;
  }

  function seekTo(seconds) {
    if (youtubeIframe) {
      sendYouTubeCommand('seekTo', [seconds, true]);
      ytCurrentTime = seconds;  // optimistic update
    } else if (video) {
      video.currentTime = seconds;
    }
  }

  function play() {
    if (youtubeIframe) {
      sendYouTubeCommand('playVideo');
      ytIsPlaying = true;
    } else if (video && video.paused) {
      video.play();
    }
  }

  function pause() {
    if (youtubeIframe) {
      sendYouTubeCommand('pauseVideo');
      ytIsPlaying = false;
    } else if (video && !video.paused) {
      video.pause();
    }
  }

  function loadDirectVideo(url) {
    video.classList.remove('hidden');
    youtubePlayer.classList.add('hidden');
    youtubePlayer.innerHTML = '';
    youtubeIframe = null;
    // Stop YouTube polling if it was running
    if (ytPollHandle) {
      clearInterval(ytPollHandle);
      ytPollHandle = null;
    }
    ytCurrentTime = 0;
    ytDuration = 0;
    ytIsPlaying = false;
    video.src = url;
    video.load();
  }

  function showPlayer(title) {
    const fileNameEl = document.getElementById('fileName');
    const splitWrap = document.getElementById('splitWrap');

    if (fileNameEl) fileNameEl.textContent = title;
    if (splitWrap) splitWrap.hidden = false;

    const isYouTube = extractYouTubeId(currentVideoUrl) !== null;
    const subtitleList = document.getElementById('subtitleList');
    const subStats = document.getElementById('subStats');

    if (subtitleList) subtitleList.innerHTML = '';
    
    const statusEl = document.getElementById('subtitleStatus');
    if (statusEl) {
      if (isYouTube) {
        statusEl.innerHTML = '📺 <strong>YouTube Video</strong><br><br>' +
          'Click "🤖 AI Generate Subtitles" to fetch YouTube official/auto subtitles<br><br>' +
          'Or click "📤 Upload Subtitle" to use your own SRT file<br><br>' +
          '💡 Translation is off by default; select a target language on the right to translate';
        statusEl.className = 'subtitle-status';
        if (subStats) subStats.innerHTML = '⬆️ Click "AI Generate" to get YouTube subtitles';
      } else {
        statusEl.innerHTML = '💡 <strong>Online Video</strong><br><br>' +
          'Options:<br>' +
          '1. Click "🤖 AI Generate" to auto-transcribe subtitles<br>' +
          '2. Click "📤 Upload Subtitle" to upload an .srt file<br><br>' +
          '💡 Translation is off by default; select a target language on the right to translate';
        statusEl.className = 'subtitle-status';
        if (subStats) subStats.innerHTML = '⬆️ Upload a subtitle file or use AI Generate';
      }
    }

    const topStatus = document.getElementById('status');
    if (topStatus) {
      topStatus.textContent = 'Ready';
      topStatus.className = 'status ready';
    }
  }

  // Subtitle handling
  
  function handleSubtitleUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const statusEl = document.getElementById('subtitleStatus');
    statusEl.textContent = 'Parsing subtitle...';
    statusEl.className = 'subtitle-status loading';

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target.result;
        const subtitles = parseSRT(content);
        
        if (subtitles.length === 0) {
          throw new Error('Failed to parse subtitle file. Please check the format.');
        }
        
        currentSubtitles = subtitles;
        loadSubtitlesIntoPlayer(subtitles);

        if (window.History && window.History.save && currentVideoUrl) {
          const ytId = extractYouTubeId(currentVideoUrl);
          const dur = subtitles[subtitles.length - 1]?.end || 0;
          const firstSub = subtitles[0] || {};
          window.History.save({
            type: ytId ? "youtube" : "online_url",
            title: ytId ? `YouTube: ${ytId}` : (currentVideoUrl.split('/').pop() || 'Online Video'),
            source: ytId || currentVideoUrl,
            size_bytes: 0,
            duration: dur,
            subtitles: subtitles,
            raw_text: "",
            source_lang: firstSub.source_lang || "en",
          });
        }

        statusEl.textContent = `✅ Subtitle loaded! ${subtitles.length} sentences`;
        statusEl.className = 'subtitle-status success';
        
        const subStats = document.getElementById('subStats');
        if (subStats && video.duration) {
          subStats.textContent = `${subtitles.length} sentences · ${formatTime(video.duration)}`;
        }
        
      } catch (error) {
        statusEl.textContent = `❌ ${error.message}`;
        statusEl.className = 'subtitle-status error';
      }
    };
    reader.readAsText(file);
  }

  async function handleSubtitleGeneration() {
    if (!currentVideoUrl) {
      alert('Please load a video first');
      return;
    }

    const statusEl = document.getElementById('subtitleStatus');
    const isYouTube = extractYouTubeId(currentVideoUrl) !== null;
    
    if (isYouTube) {
      statusEl.textContent = '📺 Fetching YouTube subtitles...';
    } else {
      statusEl.textContent = '🤖 AI is generating subtitles (may take 30-120s)...';
    }
    statusEl.className = 'subtitle-status loading';

    try {
      const response = await fetch('/api/generate-subtitles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_url: currentVideoUrl, language: 'en' }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Subtitle generation failed');
      }

      const data = await response.json();
      
      if (!data.subtitles || data.subtitles.length === 0) {
        throw new Error('No speech content detected');
      }

      currentSubtitles = data.subtitles;
      loadSubtitlesIntoPlayer(data.subtitles);

      if (window.History && window.History.save) {
        const ytId = extractYouTubeId(currentVideoUrl);
        const dur = data.duration || data.subtitles[data.subtitles.length - 1]?.end || 0;
        const firstSub = (data.subtitles && data.subtitles[0]) || {};
        window.History.save({
          type: ytId ? "youtube" : "online_url",
          title: ytId ? `YouTube: ${ytId}` : (currentVideoUrl.split('/').pop() || 'Online Video'),
          source: ytId || currentVideoUrl,
          size_bytes: 0,
          duration: dur,
          subtitles: data.subtitles || [],
          raw_text: data.raw_text || "",
          source_lang: firstSub.source_lang || data.source_lang || "en",
        });
      }

      const source = data.source || 'ai';
      const isAuto = data.is_auto_generated || false;

      if (source === 'youtube_official' || source === 'ytdlp_official') {
        statusEl.innerHTML = `✅ YouTube official subtitles loaded! ${data.subtitles.length} sentences<br>💡 Select a translation language on the right to translate`;
      } else if (source === 'youtube_automatic' || source === 'ytdlp_automatic') {
        statusEl.innerHTML = `✅ YouTube auto-generated subtitles loaded! ${data.subtitles.length} sentences<br>💡 Select a translation language on the right to translate`;
      } else if (source === 'ai_recognition_fallback') {
        const reason = data.fallback_reason ? `(${String(data.fallback_reason).split('\n')[0].slice(0, 60)}…)` : '';
        statusEl.innerHTML = `✅ AI subtitles generated! ${data.subtitles.length} sentences ${reason}<br>💡 Select a translation language on the right to translate`;
      } else {
        statusEl.innerHTML = `✅ AI subtitles generated! ${data.subtitles.length} sentences<br>💡 Select a translation language on the right to translate`;
      }
      statusEl.className = 'subtitle-status success';

      const subStats = document.getElementById('subStats');
      if (subStats) {
        const duration = data.subtitles[data.subtitles.length - 1]?.end || 0;
        subStats.textContent = `${data.subtitles.length} sentences · ${formatTime(duration)}`;
      }

    } catch (error) {
      statusEl.innerHTML = `❌ ${error.message.replace(/\n/g, '<br>')}`;
      statusEl.className = 'subtitle-status error';
      console.error('Subtitle generation failed:', error);
    }
  }

  function parseSRT(content) {
    const subtitles = [];
    const blocks = content.trim().split(/\n\s*\n/);
    
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;
      
      const timeLine = lines.find(line => line.includes('-->'));
      if (!timeLine) continue;
      
      const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*--\u003e\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
      if (!timeMatch) continue;
      
      const start = parseTime(timeMatch[1]);
      const end = parseTime(timeMatch[2]);
      
      const textLines = lines.filter(line => 
        line !== lines[0] && !line.includes('-->')
      );
      const text = textLines.join(' ').trim();
      
      if (text) {
        subtitles.push({ start, end, en: text, zh: '' });
      }
    }
    
    return subtitles;
  }

  function parseTime(timeStr) {
    const match = timeStr.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!match) return 0;
    const [, h, m, s, ms] = match;
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
  }

  function loadSubtitlesIntoPlayer(subtitles) {
    const firstSub = (subtitles && subtitles[0]) || {};
    if (window.AppState) window.AppState.currentSourceLang = firstSub.source_lang || "en";
    window.dispatchEvent(new CustomEvent('link:subtitles-loaded', {
      detail: { subtitles }
    }));
    
    if (window.Player && window.Player.loadSubtitles) {
      window.Player.loadSubtitles(subtitles);
    }
  }

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function getCurrentSubtitles() {
    return currentSubtitles;
  }

  function getYouTubeId() {
    if (!youtubeIframe) return null;
    const match = youtubeIframe.src.match(/embed\/([^?]+)/);
    return match ? match[1] : null;
  }

  function isYouTubeActive() {
    return youtubeIframe !== null;
  }

  return {
    init,
    switchInputTab,
    handleLinkLoad,
    extractYouTubeId,
    isDirectVideoUrl,
    getYouTubeId,
    isYouTubeActive,
    getCurrentSubtitles,
    // New: time source abstraction for YouTube + direct video
    getCurrentTime,
    getDuration,
    isYouTubePlaying,
    seekTo,
    play,
    pause,
  };
})();

window.LinkHandler = LinkHandler;
