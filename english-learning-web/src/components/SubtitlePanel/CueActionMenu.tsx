// components/SubtitlePanel/CueActionMenu.tsx
import { useEffect, useRef } from 'react';
import { Play, Star, BookOpen, Repeat, X, Languages } from 'lucide-react';
import { useStudyStore } from '../../stores/studyStore';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useSubtitleSync } from '../../hooks/useSubtitleSync';
import { useABRepeat } from '../../hooks/useABRepeat';
import { useAIStore } from '../../stores/aiStore';
import type { SubtitleCue } from '../../types/subtitle';

interface CueActionMenuProps {
  cue: SubtitleCue;
  onClose: () => void;
}

export function CueActionMenu({ cue, onClose }: CueActionMenuProps) {
  const { favoriteCueIds, toggleFavorite } = useStudyStore();
  const { setSelectedWord, setActivePanel } = useSubtitleStore();
  const { seekToCue } = useSubtitleSync();
  const { setSentenceRepeat } = useABRepeat();
  const { setMode } = useAIStore();
  const menuRef = useRef<HTMLDivElement>(null);

  const isFavorite = favoriteCueIds.includes(cue.id);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handlePlay = () => {
    seekToCue(cue.id);
    onClose();
  };

  const handleFavorite = () => {
    toggleFavorite(cue.id);
    onClose();
  };

  const handleExplain = () => {
    setMode('explain');
    setActivePanel('ai');
    onClose();
  };

  const handleRepeat = () => {
    setSentenceRepeat(cue.startTime, cue.endTime);
    onClose();
  };

  const handleVocab = () => {
    const firstWord = cue.primaryText.split(/\s+/)[0]?.replace(/[^a-zA-Z0-9'-]/g, '').toLowerCase();
    if (firstWord) {
      setSelectedWord(firstWord);
      setActivePanel('vocab');
    }
    onClose();
  };

  const items = [
    { id: 'play', icon: Play, label: '播放此句', onClick: handlePlay },
    { id: 'favorite', icon: Star, label: isFavorite ? '取消收藏' : '收藏', onClick: handleFavorite },
    { id: 'explain', icon: BookOpen, label: 'AI 讲解', onClick: handleExplain },
    { id: 'repeat', icon: Repeat, label: '单句循环', onClick: handleRepeat },
    { id: 'vocab', icon: Languages, label: '词汇查询', onClick: handleVocab },
  ];

  return (
    <div
      ref={menuRef}
      className="absolute right-2 top-8 z-30 bg-gray-800 border border-white/10 rounded-lg shadow-xl py-1 min-w-[140px]"
    >
      <div className="flex items-center justify-between px-2 py-1 border-b border-white/10">
        <span className="text-[10px] text-gray-400">句 #{cue.id}</span>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-white"
        >
          <X size={12} />
        </button>
      </div>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            onClick={item.onClick}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-300 hover:bg-white/10 transition-colors text-left"
          >
            <Icon size={14} />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
