// components/SubtitlePanel/SubtitleItem.tsx
import { useState } from 'react';
import { Star, MoreHorizontal } from 'lucide-react';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useStudyStore } from '../../stores/studyStore';
import { useSubtitleSync } from '../../hooks/useSubtitleSync';
import { CueActionMenu } from './CueActionMenu';
import { formatTime } from '../../utils/timeFormat';
import type { SubtitleCue } from '../../types/subtitle';

interface SubtitleItemProps {
  cue: SubtitleCue;
  isActive: boolean;
  isMatched?: boolean;
}

function WordSpan({ word, query }: { word: string; query: string }) {
  const { setSelectedWord, setActivePanel } = useSubtitleStore();

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const clean = word.replace(/[^a-zA-Z0-9'-]/g, '').toLowerCase();
    if (clean) {
      setSelectedWord(clean);
      setActivePanel('vocab');
    }
  };

  const lowerWord = word.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const isMatch = query.trim() && lowerWord.includes(lowerQuery);

  return (
    <span
      onClick={handleClick}
      className={`cursor-pointer hover:bg-white/10 rounded px-0.5 ${isMatch ? 'bg-subtitle-highlight/40' : ''}`}
      title="点击查词"
    >
      {word}
    </span>
  );
}

function PrimaryText({ text, query }: { text: string; query: string }) {
  const words = text.split(/(\s+)/);
  return (
    <>
      {words.map((part, index) => {
        if (/^\s+$/.test(part)) {
          return <span key={index}>{part}</span>;
        }
        return <WordSpan key={index} word={part} query={query} />;
      })}
    </>
  );
}

function SecondaryText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) {
    return <>{text}</>;
  }

  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let index = lowerText.indexOf(lowerQuery);

  while (index !== -1) {
    parts.push(text.slice(lastIndex, index));
    parts.push(
      <span key={index} className="bg-subtitle-highlight/40 text-white rounded px-0.5">
        {text.slice(index, index + query.length)}
      </span>
    );
    lastIndex = index + query.length;
    index = lowerText.indexOf(lowerQuery, lastIndex);
  }
  parts.push(text.slice(lastIndex));

  return <>{parts}</>;
}

export function SubtitleItem({ cue, isActive, isMatched = false }: SubtitleItemProps) {
  const { settings, searchQuery } = useSubtitleStore();
  const { favoriteCueIds, toggleFavorite, occlusionMode } = useStudyStore();
  const { seekToCue } = useSubtitleSync();
  const [showMenu, setShowMenu] = useState(false);

  const isFavorite = favoriteCueIds.includes(cue.id);
  const isPrimaryOccluded = occlusionMode === 'primary';
  const isSecondaryOccluded = occlusionMode === 'secondary';
  const isPlaceholder = cue.isPlaceholder;

  const shouldShowPrimary = settings.displayMode === 'bilingual' || settings.displayMode === 'primary';
  const shouldShowSecondary = settings.displayMode === 'bilingual' || settings.displayMode === 'secondary';

  return (
    <div
      data-cue-id={cue.id}
      className={`relative p-3 rounded-lg cursor-pointer transition-all duration-200 ${
        isActive
          ? 'bg-white/10 border-l-4 border-subtitle-highlight'
          : isMatched
            ? 'bg-subtitle-highlight/10 border-l-4 border-subtitle-highlight/50 hover:bg-white/5'
            : 'hover:bg-white/5 border-l-4 border-transparent'
      } ${isPlaceholder ? 'opacity-50' : ''}`}
      onClick={() => seekToCue(cue.id)}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-mono">
            {cue.id}
          </span>
          <span className="text-xs text-gray-600">
            {formatTime(cue.startTime)}
          </span>
          {isPlaceholder && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">空白</span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleFavorite(cue.id);
            }}
            className={`p-1 rounded transition-colors ${
              isFavorite ? 'text-yellow-400' : 'text-gray-600 hover:text-gray-400'
            }`}
            title={isFavorite ? '取消收藏' : '收藏'}
          >
            <Star size={14} fill={isFavorite ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu((v) => !v);
            }}
            className="p-1 rounded transition-colors text-gray-600 hover:text-gray-400"
            title="更多操作"
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>

      {showMenu && <CueActionMenu cue={cue} onClose={() => setShowMenu(false)} />}

      {shouldShowPrimary && !isPlaceholder && (
        <p className={`text-white text-sm leading-relaxed mb-1 ${
          isPrimaryOccluded ? 'blur-[4px] select-none' : ''
        }`}
        >
          <PrimaryText text={cue.primaryText} query={searchQuery} />
        </p>
      )}

      {shouldShowSecondary && !isPlaceholder && (
        <p className={`text-gray-400 text-sm leading-relaxed ${
          isSecondaryOccluded ? 'blur-[4px] select-none' : ''
        }`}
        >
          <SecondaryText text={cue.secondaryText} query={searchQuery} />
        </p>
      )}
    </div>
  );
}
