/** 视频链接处理 - 支持 YouTube 和普通视频链接 */
const LinkHandler = (() => {
  let videoContainer, video, youtubePlayer;
  let youtubeIframe = null;
  let currentVideoUrl = '';
  let currentSubtitles = [];

  function init() {
    // 绑定标签页切换
    document.querySelectorAll('.input-tab').forEach(tab => {
      tab.addEventListener('click', () => switchInputTab(tab.dataset.tab));
    });

    // 绑定加载按钮
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

    // 绑定示例链接
    document.querySelectorAll('.link-example').forEach(el => {
      el.addEventListener('click', () => {
        if (linkInput) {
          linkInput.value = el.dataset.url;
          handleLinkLoad();
        }
      });
    });

    // 绑定字幕按钮
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

    // 获取播放器元素
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
      alert('请输入视频链接');
      return;
    }

    currentVideoUrl = url;
    
    const progressWrap = document.getElementById('linkProgressWrap');
    const progressLabel = document.getElementById('linkProgressLabel');
    const progressFill = document.getElementById('linkProgressFill');
    
    progressWrap.hidden = false;
    progressLabel.textContent = '正在解析链接...';
    progressFill.style.width = '30%';

    try {
      const youtubeId = extractYouTubeId(url);
      
      if (youtubeId) {
        // YouTube 视频
        progressLabel.textContent = '加载 YouTube 播放器...';
        progressFill.style.width = '60%';
        
        loadYouTubeVideo(youtubeId);
        
        progressFill.style.width = '100%';
        progressLabel.textContent = '加载完成！';
        
        // 显示播放器
        showPlayer(`YouTube: ${youtubeId}`);
        
      } else if (isDirectVideoUrl(url)) {
        // 直接视频链接
        progressLabel.textContent = '加载视频...';
        progressFill.style.width = '60%';
        
        loadDirectVideo(url);
        
        progressFill.style.width = '100%';
        progressLabel.textContent = '加载完成！';
        
        showPlayer(url.split('/').pop() || '在线视频');
      } else {
        throw new Error('不支持的链接格式。目前支持 YouTube 和 MP4/WebM 直接链接。');
      }

      // 显示字幕控制区域
      const subControls = document.getElementById('subtitleControls');
      if (subControls) subControls.hidden = false;
      
      // 3秒后隐藏进度条
      setTimeout(() => {
        progressWrap.hidden = true;
      }, 1500);

    } catch (error) {
      progressLabel.textContent = '加载失败';
      progressFill.style.width = '100%';
      progressFill.style.background = 'var(--danger)';
      
      alert(`加载失败: ${error.message}`);
      
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
    // 隐藏普通视频，显示 YouTube 容器
    video.classList.add('hidden');
    youtubePlayer.classList.remove('hidden');
    
    // 清空之前的 iframe
    youtubePlayer.innerHTML = '';
    
    // 创建 iframe
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`;
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.title = 'YouTube video player';
    
    youtubePlayer.appendChild(iframe);
    youtubeIframe = iframe;

    // 由于 YouTube iframe 的限制，我们无法直接控制播放/暂停
    // 需要告诉用户 YouTube 播放器有自己的控制栏
    console.log('[LinkHandler] YouTube video loaded:', videoId);
  }

  function loadDirectVideo(url) {
    // 显示普通视频，隐藏 YouTube
    video.classList.remove('hidden');
    youtubePlayer.classList.add('hidden');
    
    // 清空 YouTube iframe
    youtubePlayer.innerHTML = '';
    youtubeIframe = null;
    
    // 设置视频源
    video.src = url;
    video.load();
  }

  function showPlayer(title) {
    const fileNameEl = document.getElementById('fileName');
    const splitView = document.getElementById('splitView');

    if (fileNameEl) fileNameEl.textContent = title;
    if (splitView) splitView.hidden = false;

    // 判断视频类型
    const isYouTube = extractYouTubeId(currentVideoUrl) !== null;

    // 重置字幕
    const subtitleCard = document.getElementById('subtitleCard');
    const subtitleList = document.getElementById('subtitleList');
    const subStats = document.getElementById('subStats');

    if (subtitleCard) {
      if (subtitleList) subtitleList.innerHTML = '';
    }
    
    // 根据视频类型显示不同的提示
    const statusEl = document.getElementById('subtitleStatus');
    if (statusEl) {
      if (isYouTube) {
        statusEl.innerHTML = '📺 <strong>YouTube 视频</strong><br><br>' +
          '点击"🤖 AI 生成字幕"直接获取 YouTube 官方字幕（无需下载）<br><br>' +
          '或点击"📤 上传字幕"上传自己的字幕文件';
        statusEl.className = 'subtitle-status';
        
        if (subStats) {
          subStats.innerHTML = '⬆️ 点击"AI 生成"获取 YouTube 字幕';
        }
      } else {
        statusEl.innerHTML = '💡 <strong>在线视频</strong><br><br>' +
          '您可以：<br>' +
          '1. 点击"🤖 AI 生成"自动识别字幕<br>' +
          '2. 点击"📤 上传字幕"上传 .srt 文件';
        statusEl.className = 'subtitle-status';
        
        if (subStats) {
          subStats.innerHTML = '⬆️ 请上传字幕文件或使用 AI 生成';
        }
      }
    }

    // 更新状态
    const topStatus = document.getElementById('status');
    if (topStatus) {
      topStatus.textContent = '就绪';
      topStatus.className = 'status ready';
    }
  }

  // ========== 字幕处理 ==========
  
  function handleSubtitleUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const statusEl = document.getElementById('subtitleStatus');
    statusEl.textContent = '正在解析字幕...';
    statusEl.className = 'subtitle-status loading';

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target.result;
        const subtitles = parseSRT(content);
        
        if (subtitles.length === 0) {
          throw new Error('字幕文件解析失败，请检查格式');
        }
        
        currentSubtitles = subtitles;
        loadSubtitlesIntoPlayer(subtitles);
        
        statusEl.textContent = `✅ 字幕加载成功！共 ${subtitles.length} 句`;
        statusEl.className = 'subtitle-status success';
        
        // 更新统计
        const subStats = document.getElementById('subStats');
        if (subStats && video.duration) {
          subStats.textContent = `共 ${subtitles.length} 句 · 时长 ${formatTime(video.duration)}`;
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
      alert('请先加载视频');
      return;
    }

    const statusEl = document.getElementById('subtitleStatus');
    const isYouTube = extractYouTubeId(currentVideoUrl) !== null;
    
    if (isYouTube) {
      statusEl.textContent = '📺 正在获取 YouTube 官方字幕...';
    } else {
      statusEl.textContent = '🤖 AI 正在生成字幕，请稍候（可能需要 30-120 秒）...';
    }
    statusEl.className = 'subtitle-status loading';

    try {
      const response = await fetch('/api/generate-subtitles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          video_url: currentVideoUrl,
          language: 'en',
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || '字幕生成失败');
      }

      const data = await response.json();
      
      if (!data.subtitles || data.subtitles.length === 0) {
        throw new Error('未能识别到语音内容');
      }

      currentSubtitles = data.subtitles;
      loadSubtitlesIntoPlayer(data.subtitles);
      
      // 显示成功信息
      const source = data.source || 'ai';
      const isAuto = data.is_auto_generated || false;
      
      if (source === 'youtube_official') {
        const autoText = isAuto ? '（自动生成）' : '（官方字幕）';
        statusEl.innerHTML = `✅ YouTube 字幕获取成功${autoText}！共 ${data.subtitles.length} 句`;
      } else {
        statusEl.textContent = `✅ AI 字幕生成成功！共 ${data.subtitles.length} 句`;
      }
      statusEl.className = 'subtitle-status success';

      // 更新统计
      const subStats = document.getElementById('subStats');
      if (subStats) {
        const duration = data.subtitles[data.subtitles.length - 1]?.end || 0;
        subStats.textContent = `共 ${data.subtitles.length} 句 · 时长 ${formatTime(duration)}`;
      }

    } catch (error) {
      let errorMsg = error.message;
      
      // 检查是否是 OSS 未配置错误
      if (errorMsg.includes('OSS')) {
        errorMsg = 'AI 字幕生成需要配置阿里云 OSS<br><br>' +
          '请在 backend/.env 中添加 OSS 配置<br>' +
          '或直接使用"上传字幕"功能';
      }
      
      statusEl.innerHTML = `❌ ${errorMsg.replace(/\n/g, '<br>')}`;
      statusEl.className = 'subtitle-status error';
      console.error('字幕生成失败:', error);
    }
  }

  function parseSRT(content) {
    const subtitles = [];
    const blocks = content.trim().split(/\n\s*\n/);
    
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;
      
      // 找到时间行
      const timeLine = lines.find(line => line.includes('-->'));
      if (!timeLine) continue;
      
      // 解析时间
      const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
      if (!timeMatch) continue;
      
      const start = parseTime(timeMatch[1]);
      const end = parseTime(timeMatch[2]);
      
      // 获取文本（跳过序号和时间行）
      const textLines = lines.filter(line => 
        line !== lines[0] && !line.includes('-->')
      );
      const text = textLines.join(' ').trim();
      
      if (text) {
        subtitles.push({
          start,
          end,
          en: text,
          zh: '',
        });
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
    // 触发事件让 Player 加载字幕
    window.dispatchEvent(new CustomEvent('link:subtitles-loaded', {
      detail: { subtitles }
    }));
    
    // 如果 Player 有直接加载方法，使用它
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

  // 提供给外部使用的方法
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
  };
})();

window.LinkHandler = LinkHandler;
