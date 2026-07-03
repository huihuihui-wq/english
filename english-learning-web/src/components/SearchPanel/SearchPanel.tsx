// components/SearchPanel/SearchPanel.tsx
import { SearchBar } from '../SubtitlePanel/SearchBar';
import { useSubtitleSearch } from '../../hooks/useSubtitleSearch';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { formatTime } from '../../utils/timeFormat';
import { FileSearch } from 'lucide-react';

export function SearchPanel() {
  const { query, results, currentIndex, jumpToMatch } = useSubtitleSearch();
  const { cues } = useSubtitleStore();

  const matchedCues = cues.filter((cue) => results.includes(cue.id));

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-white/10">
        <span className="text-sm font-semibold">🔍 字幕查找</span>
      </div>
      <SearchBar />
      <div className="flex-1 overflow-y-auto">
        {!query.trim() && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 p-6">
            <FileSearch size={32} className="mb-3" />
            <p className="text-center text-sm">输入关键词搜索字幕内容</p>
            <p className="text-center text-xs mt-1">支持英文原文和中文翻译</p>
          </div>
        )}

        {query.trim() && results.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-500 p-6">
            <p className="text-center text-sm">未找到匹配的字幕</p>
          </div>
        )}

        {query.trim() && results.length > 0 && (
          <div className="p-2 space-y-1">
            <div className="text-xs text-gray-500 px-2 py-1">
              共 {results.length} 条匹配
            </div>
            {matchedCues.map((cue, index) => (
              <button
                key={cue.id}
                onClick={() => jumpToMatch(index)}
                className={`w-full text-left p-3 rounded-lg transition-colors ${
                  index === currentIndex
                    ? 'bg-subtitle-highlight/20 border-l-4 border-subtitle-highlight'
                    : 'hover:bg-white/5 border-l-4 border-transparent'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-gray-500 font-mono">#{cue.id}</span>
                  <span className="text-xs text-gray-600">{formatTime(cue.startTime)}</span>
                </div>
                <p className="text-white text-sm line-clamp-2">{cue.primaryText}</p>
                {cue.secondaryText && (
                  <p className="text-gray-400 text-sm line-clamp-1 mt-0.5">{cue.secondaryText}</p>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
