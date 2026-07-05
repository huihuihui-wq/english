// components/SubtitlePanel/SubtitleList.tsx
import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { Star, ChevronDown } from 'lucide-react';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useStudyStore } from '../../stores/studyStore';
import { SubtitleItem } from './SubtitleItem';

export function SubtitleList() {
  const { cues, currentCueId, searchQuery, searchResults, currentSearchIndex } = useSubtitleStore();
  const { scrollMode, favoriteCueIds, showFavoritesOnly } = useStudyStore();
  const listRef = useRef<HTMLDivElement>(null);
  const [userScrolling, setUserScrolling] = useState(false);
  const userScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showBackToCurrent, setShowBackToCurrent] = useState(false);

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

  const isElementInViewport = useCallback((container: HTMLElement, element: Element) => {
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    return (
      elementRect.top >= containerRect.top &&
      elementRect.bottom <= containerRect.bottom
    );
  }, []);

  // 检测用户手动滚动，3 秒内暂停自动滚动
  const handleScroll = useCallback(() => {
    if (userScrollTimerRef.current) {
      clearTimeout(userScrollTimerRef.current);
    }
    setUserScrolling(true);
    userScrollTimerRef.current = setTimeout(() => {
      setUserScrolling(false);
    }, 3000);
  }, []);

  // 检查当前句是否在视口内，控制"回到当前句"按钮
  useEffect(() => {
    const container = listRef.current;
    if (!container || !currentCueId) {
      setShowBackToCurrent(false);
      return;
    }
    const activeElement = container.querySelector(`[data-cue-id="${currentCueId}"]`);
    if (!activeElement) {
      setShowBackToCurrent(false);
      return;
    }
    setShowBackToCurrent(!isElementInViewport(container, activeElement));
  }, [currentCueId, displayCues, isElementInViewport]);

  // 自动滚动到当前字幕
  useEffect(() => {
    if (scrollMode === 'off' || !listRef.current || !currentCueId) return;
    if (userScrolling) return;

    const container = listRef.current;
    const activeElement = container.querySelector(`[data-cue-id="${currentCueId}"]`);
    if (!activeElement) return;

    // 仅高亮模式：不滚动，只高亮
    if (scrollMode === 'highlight') return;

    // 自动滚动模式：当前句不在视口内时才滚动，使用即时定位
    if (!isElementInViewport(container, activeElement)) {
      activeElement.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
  }, [currentCueId, scrollMode, userScrolling, isElementInViewport]);

  // 搜索变化时滚动到当前匹配项（平滑滚动）
  useEffect(() => {
    if (!listRef.current || currentSearchIndex < 0) return;
    const matchId = searchResults[currentSearchIndex];
    if (!matchId) return;
    const el = listRef.current.querySelector(`[data-cue-id="${matchId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentSearchIndex, searchResults]);

  const handleBackToCurrent = useCallback(() => {
    if (!listRef.current || !currentCueId) return;
    const activeElement = listRef.current.querySelector(`[data-cue-id="${currentCueId}"]`);
    if (activeElement) {
      activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentCueId]);

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
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto p-3 space-y-1"
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

      {showBackToCurrent && (
        <button
          onClick={handleBackToCurrent}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-3 py-1.5 rounded-full bg-subtitle-highlight text-black text-xs font-medium shadow-lg hover:opacity-90 transition-opacity"
        >
          <ChevronDown size={14} />
          回到当前句
        </button>
      )}
    </div>
  );
}
