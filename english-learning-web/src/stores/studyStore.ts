// stores/studyStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface ABRepeatRange {
  startTime: number;
  endTime: number;
  isActive: boolean;
}

export type OcclusionMode = 'none' | 'secondary' | 'primary' | 'words';

interface StudyStore {
  // AB复读
  abRepeat: ABRepeatRange | null;
  setABRepeat: (range: ABRepeatRange | null) => void;

  // 逐句复读
  isSentenceShadowing: boolean;
  toggleSentenceShadowing: () => void;
  shadowingPauseMs: number;
  setShadowingPauseMs: (ms: number) => void;
  shadowingLoopCount: number;
  setShadowingLoopCount: (count: number) => void;
  shadowingDelayMs: number;
  setShadowingDelayMs: (ms: number) => void;

  // 跳过空白
  skipBlank: boolean;
  toggleSkipBlank: () => void;

  // 遮挡板
  occlusionMode: OcclusionMode;
  setOcclusionMode: (mode: OcclusionMode) => void;

  // 收藏句子
  favoriteCueIds: number[];
  toggleFavorite: (cueId: number) => void;
  showFavoritesOnly: boolean;
  toggleFavoritesOnly: () => void;

  // 自动滚动
  autoScroll: boolean;
  toggleAutoScroll: () => void;
}

export const useStudyStore = create<StudyStore>()(
  persist(
    (set) => ({
      abRepeat: null,
      setABRepeat: (range) => set({ abRepeat: range }),

      isSentenceShadowing: false,
      toggleSentenceShadowing: () => set((s) => ({
        isSentenceShadowing: !s.isSentenceShadowing
      })),
      shadowingPauseMs: 1500,
      setShadowingPauseMs: (ms) => set({ shadowingPauseMs: ms }),
      shadowingLoopCount: 3,
      setShadowingLoopCount: (count) => set({ shadowingLoopCount: Math.max(1, Math.min(10, count)) }),
      shadowingDelayMs: 0,
      setShadowingDelayMs: (ms) => set({ shadowingDelayMs: Math.max(0, Math.min(5000, ms)) }),

      skipBlank: false,
      toggleSkipBlank: () => set((s) => ({ skipBlank: !s.skipBlank })),

      occlusionMode: 'none',
      setOcclusionMode: (mode) => set({ occlusionMode: mode }),

      favoriteCueIds: [],
      toggleFavorite: (cueId) => set((s) => ({
        favoriteCueIds: s.favoriteCueIds.includes(cueId)
          ? s.favoriteCueIds.filter(id => id !== cueId)
          : [...s.favoriteCueIds, cueId]
      })),
      showFavoritesOnly: false,
      toggleFavoritesOnly: () => set((s) => ({ showFavoritesOnly: !s.showFavoritesOnly })),

      autoScroll: true,
      toggleAutoScroll: () => set((s) => ({ autoScroll: !s.autoScroll })),
    }),
    {
      name: 'study-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        shadowingPauseMs: state.shadowingPauseMs,
        shadowingLoopCount: state.shadowingLoopCount,
        shadowingDelayMs: state.shadowingDelayMs,
        skipBlank: state.skipBlank,
        occlusionMode: state.occlusionMode,
        autoScroll: state.autoScroll,
      }),
    }
  )
);
