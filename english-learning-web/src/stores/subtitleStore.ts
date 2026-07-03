// stores/subtitleStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { SubtitleCue, SubtitleSettings } from '../types/subtitle';

export type SidePanel = 'ai' | 'vocab' | 'search' | 'subtitles';

interface SubtitleStore {
  cues: SubtitleCue[];
  currentCueId: number | null;
  selectedCueId: number | null;
  settings: SubtitleSettings;

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
};

export const useSubtitleStore = create<SubtitleStore>()(
  persist(
    (set, get) => ({
      cues: [],
      currentCueId: null,
      selectedCueId: null,
      settings: { ...defaultSettings },

      activePanel: 'subtitles',
      setActivePanel: (panel) => set({ activePanel: panel }),
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

      updateSettings: (partial) => set((state) => ({
        settings: { ...state.settings, ...partial }
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
        settings: state.settings,
      }),
    }
  )
);
