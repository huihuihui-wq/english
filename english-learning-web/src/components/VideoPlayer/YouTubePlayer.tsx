// components/VideoPlayer/YouTubePlayer.tsx - YouTube IFrame 播放器封装
// 与 playerStore 同步播放/暂停/进度/倍速/音量

import { useRef, useEffect, useCallback, useMemo } from 'react';
import YouTube, { type YouTubeEvent, type YouTubePlayer as YTPlayer } from 'react-youtube';
import { usePlayerStore } from '../../stores/playerStore';
import { extractYouTubeVideoId } from '../../utils/youtube';

interface YouTubePlayerProps {
  videoUrl: string;
}

export function YouTubePlayer({ videoUrl }: YouTubePlayerProps) {
  const playerRef = useRef<YTPlayer | null>(null);
  const isSeekingRef = useRef(false);
  const {
    isPlaying,
    currentTime,
    playbackRate,
    volume,
    updateCurrentTime,
    setDuration,
  } = usePlayerStore();

  // 从 URL 提取 videoId
  const videoId = useMemo(() => extractYouTubeVideoId(videoUrl), [videoUrl]);

  const handleReady = useCallback((event: YouTubeEvent) => {
    playerRef.current = event.target;
    const duration = event.target.getDuration() * 1000;
    setDuration(duration);
    event.target.setVolume(Math.round(volume * 100));
    event.target.setPlaybackRate(playbackRate);
  }, [setDuration, volume, playbackRate]);

  const handleStateChange = useCallback((event: YouTubeEvent) => {
    if (!playerRef.current) return;
    // YouTube 状态: -1 未开始, 0 结束, 1 播放中, 2 暂停, 3 缓冲中, 5 已暂停
    const state = event.data;
    const store = usePlayerStore.getState();

    if (state === 1) {
      store.play();
    } else if (state === 2) {
      store.pause();
    } else if (state === 0) {
      store.pause();
    }
  }, []);

  // 同步当前时间
  useEffect(() => {
    const interval = setInterval(() => {
      if (!playerRef.current || isSeekingRef.current) return;
      const time = playerRef.current.getCurrentTime() * 1000;
      updateCurrentTime(time);
    }, 250);
    return () => clearInterval(interval);
  }, [updateCurrentTime]);

  // 同步播放/暂停
  useEffect(() => {
    if (!playerRef.current) return;
    const player = playerRef.current;
    const state = player.getPlayerState();
    if (isPlaying && state !== 1 && state !== 3) {
      player.playVideo();
    } else if (!isPlaying && state === 1) {
      player.pauseVideo();
    }
  }, [isPlaying]);

  // 同步 seek
  useEffect(() => {
    if (!playerRef.current) return;
    const player = playerRef.current;
    const playerTime = player.getCurrentTime() * 1000;
    if (Math.abs(playerTime - currentTime) > 500) {
      isSeekingRef.current = true;
      player.seekTo(currentTime / 1000, true);
      setTimeout(() => {
        isSeekingRef.current = false;
      }, 300);
    }
  }, [currentTime]);

  // 同步倍速
  useEffect(() => {
    if (!playerRef.current) return;
    playerRef.current.setPlaybackRate(playbackRate);
  }, [playbackRate]);

  // 同步音量
  useEffect(() => {
    if (!playerRef.current) return;
    playerRef.current.setVolume(Math.round(volume * 100));
  }, [volume]);

  if (!videoId) {
    return (
      <div className="flex items-center justify-center h-full bg-black text-white">
        <p>无法解析 YouTube 视频链接</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-black">
      <YouTube
        videoId={videoId}
        opts={{
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            rel: 0,
            modestbranding: 1,
          },
        }}
        onReady={handleReady}
        onStateChange={handleStateChange}
        className="w-full h-full"
      />
    </div>
  );
}
