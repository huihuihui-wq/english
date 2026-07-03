// components/SubtitlePanel/SearchBar.tsx
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import { useSubtitleSearch } from '../../hooks/useSubtitleSearch';

export function SearchBar() {
  const { query, setQuery, clearSearch, matchCount, currentIndex, nextMatch, prevMatch } = useSubtitleSearch();

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      nextMatch();
    } else if (e.key === 'ArrowDown' && e.altKey) {
      e.preventDefault();
      nextMatch();
    } else if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault();
      prevMatch();
    }
  };

  return (
    <div className="p-3 border-b border-white/10">
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索字幕..."
          className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-20 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-subtitle-highlight"
        />
        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {query.trim() && matchCount > 0 && (
            <span className="text-[10px] text-gray-400 px-1">
              {currentIndex + 1}/{matchCount}
            </span>
          )}
          <button
            onClick={prevMatch}
            disabled={matchCount === 0}
            className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
            title="上一个匹配 (Alt+↑ )"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={nextMatch}
            disabled={matchCount === 0}
            className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
            title="下一个匹配 (Enter / Alt+↓)"
          >
            <ChevronDown size={14} />
          </button>
          {query && (
            <button
              onClick={clearSearch}
              className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-white"
              title="清除搜索"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
