// components/Toolbar/ToolBar.tsx
import { useCallback } from 'react';
import {
  ScrollText, Star, AlignLeft, BookOpen, Languages,
  Edit3, Search, Bot, Settings
} from 'lucide-react';
import { useStudyStore } from '../../stores/studyStore';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useAIStore } from '../../stores/aiStore';

interface ToolBarProps {
  onSettingsClick: () => void;
}

export function ToolBar({ onSettingsClick }: ToolBarProps) {
  const {
    autoScroll, toggleAutoScroll,
    favoriteCueIds,
    showFavoritesOnly, toggleFavoritesOnly
  } = useStudyStore();
  const { activePanel, setActivePanel } = useSubtitleStore();
  const setMode = useAIStore((s) => s.setMode);

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

  const notImplemented = useCallback(() => {
    alert('该功能暂不支持，将在后续版本实现');
  }, []);

  const tools = [
    {
      id: 'auto-scroll',
      icon: ScrollText,
      label: '自动滚动',
      active: autoScroll,
      onClick: toggleAutoScroll
    },
    {
      id: 'favorites',
      icon: Star,
      label: `已收藏(${favoriteCueIds.length})`,
      active: showFavoritesOnly,
      onClick: handleFavorites
    },
    {
      id: 'auto-segment',
      icon: AlignLeft,
      label: '自动分段',
      active: false,
      onClick: notImplemented
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
      id: 'edit',
      icon: Edit3,
      label: '编辑',
      active: false,
      onClick: notImplemented
    },
    {
      id: 'search',
      icon: Search,
      label: '查找',
      active: activePanel === 'search',
      onClick: handleSearch
    },
  ];

  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-white/10 overflow-x-auto">
      {tools.map((tool) => (
        <button
          key={tool.id}
          className={`tool-btn min-w-[60px] ${tool.active ? 'active' : ''}`}
          onClick={tool.onClick}
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
    </div>
  );
}
