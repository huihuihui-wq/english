// stores/playerStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { PlayerState, VideoInfo } from '../types/player';

interface PlayerStore extends PlayerState {
  video: VideoInfo | null;
  playerRef: HTMLVideoElement | null;
  
  setVideo: (video: VideoInfo) => void;
  setPlayerRef: (ref: HTMLVideoElement | null) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  setPlaybackRate: (rate: number) => void;
  setFullscreen: (isFullscreen: boolean) => void;
  updateCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
}

export const usePlayerStore = create<PlayerStore>()(
  persist(
    (set, get) => ({
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      volume: 1,
      playbackRate: 1,
      isFullscreen: false,
      video: null,
      playerRef: null,
      
      setVideo: (video) => set({ video, duration: video.duration }),
      setPlayerRef: (ref) => set({ playerRef: ref }),
      
      play: async () => {
        const { playerRef } = get();
        if (!playerRef) return;
        
        try {
          await playerRef.play();
          set({ isPlaying: true });
        } catch (error) {
          console.error('Play failed:', error);
          set({ isPlaying: false });
        }
      },
      
      pause: () => {
        const { playerRef } = get();
        if (!playerRef) return;
        
        try {
          playerRef.pause();
          set({ isPlaying: false });
        } catch (error) {
          console.error('Pause failed:', error);
        }
      },
      
      togglePlay: async () => {
        const { isPlaying, playerRef } = get();
        if (!playerRef) return;
        
        try {
          if (isPlaying) {
            await playerRef.pause();
            set({ isPlaying: false });
          } else {
            const playPromise = playerRef.play();
            if (playPromise !== undefined) {
              await playPromise;
              set({ isPlaying: true });
            }
          }
        } catch (error) {
          console.error('Toggle play failed:', error);
          set({ isPlaying: false });
        }
      },
      
      seek: (time) => {
        const { playerRef } = get();
        if (playerRef) {
          playerRef.currentTime = time / 1000;
          set({ currentTime: time });
        }
      },
      
      setVolume: (volume) => {
        const { playerRef } = get();
        if (playerRef) {
          playerRef.volume = volume;
        }
        set({ volume });
      },
      
      setPlaybackRate: (rate) => {
        const { playerRef } = get();
        if (playerRef) {
          playerRef.playbackRate = rate;
        }
        set({ playbackRate: rate });
      },
      
      setFullscreen: (isFullscreen) => set({ isFullscreen }),
      
      updateCurrentTime: (time) => set({ currentTime: time }),
      
      setDuration: (duration) => set({ duration }),
    }),
    {
      name: 'player-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        volume: state.volume,
        playbackRate: state.playbackRate,
      }),
    }
  )
);
