// components/VideoPlayer/VideoPlayer.tsx
import { useRef, useEffect, useCallback } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { SubtitleOverlay } from './SubtitleOverlay';
import { PlayerControls } from './PlayerControls';

interface VideoPlayerProps {
  videoUrl: string;
  poster?: string;
}

export function VideoPlayer({ videoUrl, poster }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({
    handleTimeUpdate: () => {},
    handleLoadedMetadata: () => {},
    handleEnded: () => {},
    handleFullscreenChange: () => {},
  });
  const { 
    setPlayerRef, 
    updateCurrentTime, 
    setDuration, 
    playbackRate,
    setFullscreen,
  } = usePlayerStore();
  
  // 使用 ref 存储最新的 store 方法，避免闭包问题
  const storeRef = useRef({ updateCurrentTime, setDuration, playbackRate, setPlayerRef, setFullscreen });
  useEffect(() => {
    storeRef.current = { updateCurrentTime, setDuration, playbackRate, setPlayerRef, setFullscreen };
  }, [updateCurrentTime, setDuration, playbackRate, setPlayerRef, setFullscreen]);
  
  // 全屏切换
  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);
  
  useEffect(() => {
    if (!videoRef.current) return;
    
    const video = videoRef.current;
    storeRef.current.setPlayerRef(video);
    
    // 使用 ref 存储回调，避免闭包问题
    callbacksRef.current.handleTimeUpdate = () => {
      storeRef.current.updateCurrentTime(video.currentTime * 1000);
    };
    
    callbacksRef.current.handleLoadedMetadata = () => {
      storeRef.current.setDuration(video.duration * 1000);
      video.playbackRate = storeRef.current.playbackRate;
    };
    
    callbacksRef.current.handleEnded = () => {
      usePlayerStore.setState({ isPlaying: false });
    };
    
    callbacksRef.current.handleFullscreenChange = () => {
      storeRef.current.setFullscreen(!!document.fullscreenElement);
    };
    
    const { handleTimeUpdate, handleLoadedMetadata, handleEnded, handleFullscreenChange } = callbacksRef.current;
    
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('ended', handleEnded);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    
    // 如果视频已加载，立即同步状态
    if (video.readyState >= 1) {
      handleLoadedMetadata();
    }
    if (video.readyState >= 2) {
      handleTimeUpdate();
    }
    
    return () => {
      try {
        video.pause();
      } catch {
        // video may already be detached
      }
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('ended', handleEnded);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      storeRef.current.setPlayerRef(null);
    };
  }, [videoUrl]); // 只在 videoUrl 变化时重新绑定
  
  // 单独处理 playbackRate 变化
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);
  
  // 键盘快捷键 - 使用 ref 存储回调，避免重复注册
  const keyboardRef = useRef({
    handleKeyDown: (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      const store = usePlayerStore.getState();
      
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          store.togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          store.seek(Math.max(0, store.currentTime - 5000));
          break;
        case 'ArrowRight':
          e.preventDefault();
          store.seek(Math.min(store.duration, store.currentTime + 5000));
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
          e.preventDefault();
          store.setVolume(store.volume > 0 ? 0 : 1);
          break;
      }
    }
  });
  
  useEffect(() => {
    const handleKeyDown = keyboardRef.current.handleKeyDown;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // 空依赖，只注册一次
  
  return (
    <div 
      ref={containerRef}
      className="relative w-full bg-black aspect-video group"
    >
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        poster={poster}
        preload="metadata"
      >
        <source src={videoUrl} type="video/mp4" />
      </video>
      
      {/* 字幕叠加层 */}
      <SubtitleOverlay />
      
      {/* 播放控制层 */}
      <PlayerControls onFullscreenToggle={toggleFullscreen} />
    </div>
  );
}
