// types/player.ts
export interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  playbackRate: number;
  isFullscreen: boolean;
}

export interface VideoInfo {
  id: string;
  title: string;
  videoUrl: string;
  subtitleUrl?: string;
  secondarySubtitleUrl?: string;
  duration: number;
}
