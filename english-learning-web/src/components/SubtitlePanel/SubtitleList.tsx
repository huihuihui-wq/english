// components/SubtitlePanel/SubtitleList.tsx
import { useRef, useEffect, useMemo } from 'react';
import { Star } from 'lucide-react';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useStudyStore } from '../../stores/studyStore';
import { SubtitleItem } from './SubtitleItem';

export function SubtitleList() {
  const { cues, currentCueId, searchQuery, searchResults, currentSearchIndex } = useSubtitleStore();
  const { autoScroll, favoriteCueIds, showFavoritesOnly } = useStudyStore();
  const listRef = useRef<HTMLDivElement>(null);

  const displayCues = useMemo(() => {
    let result = cues;
    if (showFavoritesOnly) {
      result = result.filter((cue) => favoriteCueIds.includes(cue.id));
    }
    if (searchQuery.trim()) {
      result = result.filter((cue) => searchResults.includes(cue.id));
    }
    return result;
  }, [cues, favoriteCueIds, showFavoritesOnly, searchQuery, searchResults]);

  // 自动滚动到当前字幕
  useEffect(() => {
    if (!autoScroll || !listRef.current || !currentCueId) return;

    const activeElement = listRef.current.querySelector(`[data-cue-id="${currentCueId}"]`);
    if (activeElement) {
      activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentCueId, autoScroll]);

  // 搜索变化时滚动到当前匹配项
  useEffect(() => {
    if (!listRef.current || currentSearchIndex < 0) return;
    const matchId = searchResults[currentSearchIndex];
    if (!matchId) return;
    const el = listRef.current.querySelector(`[data-cue-id="${matchId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentSearchIndex, searchResults]);

  if (cues.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <p>暂无字幕数据</p>
      </div>
    );
  }

  if (displayCues.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-500 p-6">
        {showFavoritesOnly ? (
          <>
            <Star size={32} className="mb-3 text-gray-600" />
            <p className="text-center">暂无收藏句子</p>
            <p className="text-xs text-center mt-1">点击字幕右侧的星标即可收藏</p>
          </>
        ) : (
          <p className="text-center">没有匹配的字幕</p>
        )}
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="flex-1 overflow-y-auto p-3 space-y-1"
    >
      {displayCues.map((cue) => (
        <SubtitleItem
          key={cue.id}
          cue={cue}
          isActive={cue.id === currentCueId}
          isMatched={searchResults.includes(cue.id) && searchQuery.trim() !== ''}
        />
      ))}
    </div>
  );
}
