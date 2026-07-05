// components/Toolbar/ToolBar.tsx
import { useCallback, useRef, useState, useEffect } from 'react';
import {
  ScrollText, Star, BookOpen, Languages, Globe,
  Search, Bot, Settings, RotateCcw, Download
} from 'lucide-react';
import { useStudyStore } from '../../stores/studyStore';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useAIStore } from '../../stores/aiStore';
import { translateSubtitlesStream } from '../../api/content';
import { LoadingSpinner } from '../LoadingSpinner/LoadingSpinner';
import {
  exportSubtitlesToSRT,
  exportSubtitlesToVTT,
  exportBilingualSubtitlesToSRT,
} from '../../utils/export';

import type { LucideIcon } from 'lucide-react';
import type { SubtitleCue } from '../../types/subtitle';

interface ToolBarProps {
  onSettingsClick: () => void;
}

interface ToolItem {
  id: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}

const TRANSLATE_LANG_LABELS: Record<string, string> = {
  Chinese: '中',
  'Chinese-Traditional': '繁',
  Japanese: '日',
  Korean: '韩',
  French: '法',
  German: '德',
  Spanish: '西',
  Portuguese: '葡',
  Russian: '俄',
  Italian: '意',
};

export function ToolBar({ onSettingsClick }: ToolBarProps) {
  const {
    scrollMode, setScrollMode,
    favoriteCueIds,
    showFavoritesOnly, toggleFavoritesOnly
  } = useStudyStore();
  const {
    cues,
    updateCue,
    activePanel,
    setActivePanel,
    settings,
    translation,
    startTranslation,
    updateTranslationProgress,
    addFailedCueIds,
    clearFailedCueIds,
    stopTranslation,
  } = useSubtitleStore();
  const setMode = useAIStore((s) => s.setMode);
  const abortControllerRef = useRef<AbortController | null>(null);
  const targetCuesRef = useRef<SubtitleCue[]>([]);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  const targetLang = settings.translateTargetLang || 'Chinese';
  const targetLangLabel = TRANSLATE_LANG_LABELS[targetLang] || targetLang.slice(0, 2);

  const runTranslation = useCallback(async (targetCues: SubtitleCue[], isRetry = false) => {
    if (targetCues.length === 0) return;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    targetCuesRef.current = targetCues;
    startTranslation(targetCues.length, isRetry);

    try {
      const sentences = targetCues.map((c) => c.primaryText);
      for await (const event of translateSubtitlesStream(
        sentences,
        targetLang,
        'English',
        25,
        abortController.signal
      )) {
        if (event.type === 'batch' && event.translations && event.field) {
          event.translations.forEach((tr, idx) => {
            const targetIdx = (event.start_index || 0) + idx;
            const cue = targetCues[targetIdx];
            const text = tr?.[event.field!];
            if (cue && text) {
              updateCue(cue.id, {
                secondaryText: text,
                translations: { ...cue.translations, [targetLang]: text },
              });
            }
          });
        } else if (event.type === 'progress') {
          updateTranslationProgress(event.completed || 0);
        } else if (event.type === 'error' && event.start_index !== undefined && event.end_index !== undefined) {
          const failedIds: number[] = [];
          for (let i = event.start_index; i < event.end_index; i++) {
            const cue = targetCues[i];
            if (cue) failedIds.push(cue.id);
          }
          addFailedCueIds(failedIds);
        }
      }
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'AbortError') {
        alert(err.message || '翻译失败');
      }
    } finally {
      abortControllerRef.current = null;
      stopTranslation();
    }
  }, [
    targetLang,
    updateCue,
    startTranslation,
    updateTranslationProgress,
    addFailedCueIds,
    stopTranslation,
  ]);

  const handleTranslate = useCallback(() => {
    const toTranslate = cues.filter((c) => !c.isPlaceholder && c.primaryText.trim());
    if (toTranslate.length === 0) return;
    clearFailedCueIds();
    runTranslation(toTranslate);
  }, [cues, runTranslation, clearFailedCueIds]);

  const handleRetryFailed = useCallback(() => {
    const failedCues = targetCuesRef.current.filter((c) =>
      translation.failedCueIds.includes(c.id)
    );
    if (failedCues.length === 0) {
      clearFailedCueIds();
      return;
    }
    runTranslation(failedCues, true);
  }, [translation.failedCueIds, runTranslation, clearFailedCueIds]);

  const hasTranslatableCues = cues.some((c) => !c.isPlaceholder && c.primaryText.trim());
  const hasFailedCues = !translation.isTranslating && translation.failedCueIds.length > 0;
  const hasExportableCues = cues.some((c) => !c.isPlaceholder);

  // 点击外部关闭导出菜单
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    }
    if (showExportMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showExportMenu]);

  const handleExportSRT = useCallback(() => {
    exportSubtitlesToSRT(cues);
    setShowExportMenu(false);
  }, [cues]);

  const handleExportVTT = useCallback(() => {
    exportSubtitlesToVTT(cues);
    setShowExportMenu(false);
  }, [cues]);

  const handleExportBilingualSRT = useCallback(() => {
    exportBilingualSubtitlesToSRT(cues, targetLang);
    setShowExportMenu(false);
  }, [cues, targetLang]);

  const handleFavorites = useCallback(() => {
    toggleFavoritesOnly();
    setActivePanel('subtitles');
  }, [toggleFavoritesOnly, setActivePanel]);

  const handleExplain = useCallback(() => {
    setMode('explain');
    setActivePanel('ai');
  }, [setMode, setActivePanel]);

  const handleVocab = useCallback(() => {
    setActivePanel('vocab');
  }, [setActivePanel]);

  const handleSearch = useCallback(() => {
    setActivePanel('search');
  }, [setActivePanel]);

  const handleAI = useCallback(() => {
    setActivePanel('ai');
  }, [setActivePanel]);

  const tools: ToolItem[] = [
    {
      id: 'auto-scroll',
      icon: ScrollText,
      label: scrollMode === 'auto' ? '自动滚动' : scrollMode === 'highlight' ? '仅高亮' : '滚动关',
      active: scrollMode === 'auto',
      onClick: () => {
        const modes: Array<'auto' | 'highlight' | 'off'> = ['auto', 'highlight', 'off'];
        const next = modes[(modes.indexOf(scrollMode) + 1) % modes.length];
        setScrollMode(next);
      }
    },
    {
      id: 'favorites',
      icon: Star,
      label: `已收藏(${favoriteCueIds.length})`,
      active: showFavoritesOnly,
      onClick: handleFavorites
    },
    {
      id: 'explain',
      icon: BookOpen,
      label: '讲解',
      active: activePanel === 'ai',
      onClick: handleExplain
    },
    {
      id: 'vocabulary',
      icon: Languages,
      label: '词汇',
      active: activePanel === 'vocab',
      onClick: handleVocab
    },
    {
      id: 'translate',
      icon: Globe,
      label: translation.isTranslating ? '翻译中...' : `翻译(${targetLangLabel})`,
      active: false,
      disabled: translation.isTranslating || !hasTranslatableCues,
      onClick: handleTranslate
    },
    ...(hasFailedCues
      ? [
          {
            id: 'retry-failed',
            icon: RotateCcw,
            label: `重试失败(${translation.failedCueIds.length})`,
            active: false,
            disabled: translation.isTranslating,
            onClick: handleRetryFailed,
          } as ToolItem,
        ]
      : []),
    {
      id: 'search',
      icon: Search,
      label: '查找',
      active: activePanel === 'search',
      onClick: handleSearch
    },
    {
      id: 'export',
      icon: Download,
      label: '导出',
      active: false,
      disabled: !hasExportableCues,
      onClick: () => setShowExportMenu((v) => !v)
    },
  ];

  return (
    <>
      <div className="relative flex flex-wrap items-center gap-1 px-3 py-2 border-b border-white/10">
        {tools.map((tool) => (
          <button
            key={tool.id}
            className={`tool-btn min-w-[60px] ${tool.active ? 'active' : ''}`}
            onClick={tool.onClick}
            disabled={tool.disabled}
          >
            <tool.icon size={18} />
            <span className="text-[10px] whitespace-nowrap">{tool.label}</span>
          </button>
        ))}

        <button
          className={`tool-btn min-w-[60px] ${activePanel === 'ai' ? 'active bg-subtitle-highlight/10 text-subtitle-highlight' : ''}`}
          onClick={handleAI}
          title="AI 助手"
        >
          <Bot size={18} />
          <span className="text-[10px]">AI 助手</span>
        </button>

        <button
          className="tool-btn min-w-[60px]"
          onClick={onSettingsClick}
          title="设置"
        >
          <Settings size={18} />
          <span className="text-[10px]">设置</span>
        </button>

        {showExportMenu && (
          <div
            ref={exportMenuRef}
            className="absolute top-full right-3 mt-1 z-50 bg-gray-900 border border-white/10 rounded-lg shadow-xl py-1 min-w-[160px]"
          >
            <div className="px-3 py-2 border-b border-white/10 text-xs text-gray-400">导出字幕</div>
            <button
              onClick={handleExportSRT}
              className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/10 transition-colors"
            >
              导出 SRT
            </button>
            <button
              onClick={handleExportVTT}
              className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/10 transition-colors"
            >
              导出 VTT
            </button>
            <button
              onClick={handleExportBilingualSRT}
              className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/10 transition-colors"
            >
              导出双语 SRT
            </button>
          </div>
        )}
      </div>

      {translation.isTranslating && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-4 px-5 py-3 bg-gray-900/95 border border-white/10 rounded-full shadow-xl">
          <LoadingSpinner size="sm" />
          <span className="text-sm text-white whitespace-nowrap">
            {translation.isRetry ? '重试失败部分' : `正在翻译成 ${targetLangLabel}...`}
            {' '}
            已翻译 {translation.completed} / {translation.total} 句
          </span>
          <button
            className="text-xs px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-white transition-colors"
            onClick={() => {
              abortControllerRef.current?.abort();
            }}
          >
            取消
          </button>
        </div>
      )}
    </>
  );
}
