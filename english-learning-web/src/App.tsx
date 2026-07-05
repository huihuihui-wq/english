// App.tsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { ResponsiveLayout } from './components/Layout/ResponsiveLayout';
import { WelcomeScreen } from './components/WelcomeScreen/WelcomeScreen';
import { usePlayerStore } from './stores/playerStore';
import { useSubtitleStore } from './stores/subtitleStore';
import { useSentenceShadowing } from './hooks/useSentenceShadowing';
import { useShadowRecording } from './hooks/useShadowRecording';
import { useSubtitleSync } from './hooks/useSubtitleSync';
import { useSkipBlank } from './hooks/useSkipBlank';
import { usePanelShortcuts } from './hooks/usePanelShortcuts';
import type { VideoInfo } from './types/player';
import type { SubtitleCue } from './types/subtitle';
import { updateHistoryProgress, getHistory } from './api/content';
import { getFile } from './utils/fileCache';

interface VideoSource {
  video: VideoInfo;
  subtitles: SubtitleCue[];
  historyId?: string;
  progressSeconds?: number;
}

function App() {
  const { setVideo, seek } = usePlayerStore();
  const { setCues } = useSubtitleStore();
  const [videoSource, setVideoSource] = useState<VideoSource | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [historyId, setHistoryId] = useState<string | null>(null);

  useSentenceShadowing();
  useShadowRecording();
  useSubtitleSync();
  useSkipBlank();
  usePanelShortcuts();

  // 启动时验证并恢复上次来源
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      const saved = localStorage.getItem('shadow-reader-last-source');
      if (!saved) {
        if (!cancelled) setIsLoading(false);
        return;
      }

      let parsed: VideoSource | null = null;
      try {
        parsed = JSON.parse(saved);
      } catch {
        localStorage.removeItem('shadow-reader-last-source');
        if (!cancelled) setIsLoading(false);
        return;
      }

      if (!parsed) {
        if (!cancelled) setIsLoading(false);
        return;
      }

      // 本地文件需要检查 IndexedDB 缓存
      const isLocalFile =
        parsed.historyId &&
        (parsed.video.videoUrl.startsWith('blob:') ||
          (!parsed.video.videoUrl.startsWith('http') && !parsed.video.videoUrl.startsWith('//')));

      if (isLocalFile) {
        const historyId = parsed.historyId as string;
        const cachedFile = await getFile(historyId);
        if (cachedFile) {
          parsed.video.videoUrl = URL.createObjectURL(cachedFile);
          try {
            const record = await getHistory(historyId);
            parsed.progressSeconds = record.progress_seconds;
          } catch {
            // 使用已保存的进度
          }
        } else {
          // 缓存丢失，不自动恢复本地文件
          localStorage.removeItem('shadow-reader-last-source');
          if (!cancelled) setIsLoading(false);
          return;
        }
      }

      if (!cancelled) {
        setVideoSource(parsed);
        setHistoryId(parsed.historyId || null);
        setVideo(parsed.video);
        setCues(parsed.subtitles || []);
        if (parsed.progressSeconds && parsed.progressSeconds > 1) {
          setTimeout(() => {
            seek(Math.round(parsed.progressSeconds! * 1000));
          }, 500);
        }
        setIsLoading(false);
      }
    };

    restore();
    return () => { cancelled = true; };
  }, [setVideo, setCues, seek]);

  const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 自动保存进度（防抖）
  useEffect(() => {
    if (!historyId) return;

    let lastSaved = 0;
    const save = (currentTime: number) => {
      if (currentTime <= 1000) return;
      // 避免过于频繁保存：至少间隔 10 秒或进度变化超过 5 秒
      if (currentTime - lastSaved < 5000 && Math.abs(currentTime - lastSaved) < 5000) return;
      lastSaved = currentTime;
      updateHistoryProgress(historyId, currentTime / 1000).catch(() => {});
    };

    const unsubscribe = usePlayerStore.subscribe((state) => {
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current);
      }
      progressTimeoutRef.current = setTimeout(() => save(state.currentTime), 3000);
    });

    return () => {
      unsubscribe();
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current);
      }
    };
  }, [historyId]);

  // 页面卸载前保存一次
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!historyId) return;
      const { currentTime } = usePlayerStore.getState();
      if (currentTime > 1000) {
        // 使用 sendBeacon 保证卸载前能发送
        const url = `${window.location.origin}/api/history/${encodeURIComponent(historyId)}/progress`;
        const data = JSON.stringify({ progress_seconds: currentTime / 1000 });
        navigator.sendBeacon?.(url, new Blob([data], { type: 'application/json' }));
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [historyId]);

  const handleLoad = useCallback((source: VideoSource) => {
    setIsLoading(true);
    setVideoSource(source);
    setHistoryId(source.historyId || null);
    localStorage.setItem('shadow-reader-last-source', JSON.stringify({
      video: source.video,
      subtitles: source.subtitles,
      historyId: source.historyId,
    }));

    setVideo(source.video);
    setCues(source.subtitles);

    // 恢复上次进度
    if (source.progressSeconds && source.progressSeconds > 1) {
      setTimeout(() => {
        seek(Math.round(source.progressSeconds! * 1000));
      }, 500);
    }

    setIsLoading(false);
  }, [setVideo, setCues, seek]);

  const handleReset = useCallback(() => {
    setVideoSource(null);
    setHistoryId(null);
    localStorage.removeItem('shadow-reader-last-source');
    setVideo({
      id: '',
      title: '',
      videoUrl: '',
      duration: 0,
    });
    setCues([]);
  }, [setVideo, setCues]);

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-app-bg text-white">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-subtitle-highlight border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400">加载中...</p>
        </div>
      </div>
    );
  }

  if (!videoSource) {
    return <WelcomeScreen onLoad={handleLoad} />;
  }

  return (
    <div className="h-screen flex flex-col bg-app-bg">
      <ResponsiveLayout />
      {/* 重置按钮（临时入口，可集成到设置面板） */}
      <button
        onClick={handleReset}
        className="fixed top-4 left-4 z-50 px-3 py-1.5 bg-black/60 text-white text-xs rounded-lg hover:bg-black/80 backdrop-blur-sm border border-white/10"
        title="返回欢迎页"
      >
        🏠 首页
      </button>
    </div>
  );
}

export default App;
