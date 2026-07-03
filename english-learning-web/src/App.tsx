// App.tsx
import { useState, useEffect, useCallback } from 'react';
import { ResponsiveLayout } from './components/Layout/ResponsiveLayout';
import { WelcomeScreen } from './components/WelcomeScreen/WelcomeScreen';
import { usePlayerStore } from './stores/playerStore';
import { useSubtitleStore } from './stores/subtitleStore';
import { useSentenceShadowing } from './hooks/useSentenceShadowing';
import { useSkipBlank } from './hooks/useSkipBlank';
import { usePanelShortcuts } from './hooks/usePanelShortcuts';
import type { VideoInfo } from './types/player';
import type { SubtitleCue } from './types/subtitle';
import { updateHistoryProgress } from './api/content';

interface VideoSource {
  video: VideoInfo;
  subtitles: SubtitleCue[];
  historyId?: string;
  progressSeconds?: number;
}

function App() {
  const { setVideo, seek } = usePlayerStore();
  const { setCues } = useSubtitleStore();
  const [videoSource, setVideoSource] = useState<VideoSource | null>(() => {
    const saved = localStorage.getItem('shadow-reader-last-source');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return null;
      }
    }
    return null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);

  useSentenceShadowing();
  useSkipBlank();
  usePanelShortcuts();

  // 自动保存进度
  useEffect(() => {
    if (!historyId) return;
    const { currentTime } = usePlayerStore.getState();
    if (currentTime > 1000) {
      const timeout = setTimeout(() => {
        updateHistoryProgress(historyId, currentTime / 1000).catch(() => {});
      }, 5000);
      return () => clearTimeout(timeout);
    }
  });

  const handleLoad = useCallback((source: VideoSource) => {
    setIsLoading(true);
    setVideoSource(source);
    setHistoryId(source.historyId || null);
    localStorage.setItem('shadow-reader-last-source', JSON.stringify({
      video: source.video,
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
