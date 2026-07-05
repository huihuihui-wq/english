// stores/subtitleStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { SubtitleCue, SubtitleSettings } from '../types/subtitle';

export type SidePanel = 'ai' | 'vocab' | 'search' | 'subtitles';

interface TranslationState {
  isTranslating: boolean;
  completed: number;
  total: number;
  failedCueIds: number[];
  isRetry: boolean;
}

interface SubtitleStore {
  cues: SubtitleCue[];
  currentCueId: number | null;
  selectedCueId: number | null;
  settings: SubtitleSettings;

  // 翻译进度
  translation: TranslationState;
  startTranslation: (total: number, isRetry?: boolean) => void;
  updateTranslationProgress: (completed: number) => void;
  addFailedCueIds: (ids: number[]) => void;
  clearFailedCueIds: () => void;
  stopTranslation: () => void;

  // 右侧边栏
  activePanel: SidePanel;
  setActivePanel: (panel: SidePanel) => void;

  // 搜索
  searchQuery: string;
  searchResults: number[];
  currentSearchIndex: number;
  setSearchQuery: (query: string) => void;
  setSearchResults: (ids: number[]) => void;
  setCurrentSearchIndex: (index: number) => void;
  clearSearch: () => void;

  // 词汇
  selectedWord: string | null;
  setSelectedWord: (word: string | null) => void;

  setCues: (cues: SubtitleCue[]) => void;
  setCurrentCueId: (id: number | null) => void;
  setSelectedCueId: (id: number | null) => void;
  updateCue: (id: number, partial: Partial<SubtitleCue>) => void;
  updateSettings: (settings: Partial<SubtitleSettings>) => void;
  getCurrentCue: () => SubtitleCue | null;
  getCueAtTime: (time: number) => SubtitleCue | null;
  resetSettings: () => void;
}

const defaultSettings: SubtitleSettings = {
  fontFamily: '"Inter", "Noto Sans SC", system-ui, sans-serif',
  fontSize: 20,
  fontColor: '#FFFFFF',
  backgroundColor: '#000000',
  backgroundOpacity: 0.6,
  position: 'bottom',
  lineHeight: 1.6,
  letterSpacing: 0,
  displayMode: 'bilingual',
  autoScroll: true,
  highlightColor: '#00D4FF',
  translateTargetLang: 'Chinese',
  subtitleOffset: 0,
};

export const useSubtitleStore = create<SubtitleStore>()(
  persist(
    (set, get) => ({
      cues: [],
      currentCueId: null,
      selectedCueId: null,
      settings: { ...defaultSettings },

      translation: {
        isTranslating: false,
        completed: 0,
        total: 0,
        failedCueIds: [],
        isRetry: false,
      },
      startTranslation: (total, isRetry = false) => set({
        translation: { isTranslating: true, completed: 0, total, failedCueIds: [], isRetry }
      }),
      updateTranslationProgress: (completed) => set((state) => ({
        translation: { ...state.translation, completed }
      })),
      addFailedCueIds: (ids) => set((state) => ({
        translation: {
          ...state.translation,
          failedCueIds: Array.from(new Set([...state.translation.failedCueIds, ...ids]))
        }
      })),
      clearFailedCueIds: () => set((state) => ({
        translation: { ...state.translation, failedCueIds: [] }
      })),
      stopTranslation: () => set((state) => ({
        translation: { ...state.translation, isTranslating: false, isRetry: false }
      })),

      activePanel: 'subtitles',
      setActivePanel: (panel) => set({ activePanel: panel }),

      searchQuery: '',
      searchResults: [],
      currentSearchIndex: -1,
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSearchResults: (ids) => set({ searchResults: ids }),
      setCurrentSearchIndex: (index) => set({ currentSearchIndex: index }),
      clearSearch: () => set({ searchQuery: '', searchResults: [], currentSearchIndex: -1 }),

      selectedWord: null,
      setSelectedWord: (word) => set({ selectedWord: word }),

      setCues: (cues) => set({ cues }),
      setCurrentCueId: (id) => set({ currentCueId: id }),
      setSelectedCueId: (id) => set({ selectedCueId: id }),
      updateCue: (id, partial) => set((state) => ({
        cues: state.cues.map((cue) => (cue.id === id ? { ...cue, ...partial } : cue)),
      })),

      updateSettings: (partial) => set((state) => ({
        settings: { ...defaultSettings, ...state.settings, ...partial }
      })),

      getCurrentCue: () => {
        const { cues, currentCueId } = get();
        return cues.find(c => c.id === currentCueId) || null;
      },

      getCueAtTime: (time) => {
        const { cues } = get();
        return cues.find(c => time >= c.startTime && time <= c.endTime) || null;
      },

      resetSettings: () => set({ settings: { ...defaultSettings } }),
    }),
    {
      name: 'subtitle-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        settings: { ...defaultSettings, ...state.settings },
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.settings = { ...defaultSettings, ...state.settings };
        }
      },
    }
  )
);
