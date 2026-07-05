// hooks/useSubtitleSearch.ts
import { useEffect, useMemo, useCallback } from 'react';
import { useSubtitleStore } from '../stores/subtitleStore';
import { usePlayerStore } from '../stores/playerStore';

export function useSubtitleSearch() {
  const {
    cues,
    searchQuery,
    searchResults,
    currentSearchIndex,
    setSearchQuery,
    setSearchResults,
    setCurrentSearchIndex,
    clearSearch,
  } = useSubtitleStore();
  const { seek } = usePlayerStore();

  const normalizedQuery = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);

  useEffect(() => {
    if (!normalizedQuery) {
      setSearchResults([]);
      setCurrentSearchIndex(-1);
      return;
    }

    const matchedIds = cues
      .filter(
        (cue) => {
          const allTranslations = Object.values(cue.translations || {}).join(' ');
          const secondary = cue.secondaryText || '';
          return (
            cue.primaryText.toLowerCase().includes(normalizedQuery) ||
            secondary.toLowerCase().includes(normalizedQuery) ||
            allTranslations.toLowerCase().includes(normalizedQuery)
          );
        }
      )
      .map((cue) => cue.id);

    setSearchResults(matchedIds);
    setCurrentSearchIndex(matchedIds.length > 0 ? 0 : -1);
  }, [normalizedQuery, cues, setSearchResults, setCurrentSearchIndex]);

  const nextMatch = useCallback(() => {
    if (searchResults.length === 0) return;
    const nextIndex = (currentSearchIndex + 1) % searchResults.length;
    setCurrentSearchIndex(nextIndex);
    const cue = cues.find((c) => c.id === searchResults[nextIndex]);
    if (cue) seek(cue.startTime);
  }, [searchResults, currentSearchIndex, setCurrentSearchIndex, cues, seek]);

  const prevMatch = useCallback(() => {
    if (searchResults.length === 0) return;
    const prevIndex = (currentSearchIndex - 1 + searchResults.length) % searchResults.length;
    setCurrentSearchIndex(prevIndex);
    const cue = cues.find((c) => c.id === searchResults[prevIndex]);
    if (cue) seek(cue.startTime);
  }, [searchResults, currentSearchIndex, setCurrentSearchIndex, cues, seek]);

  const jumpToMatch = useCallback(
    (index: number) => {
      if (index < 0 || index >= searchResults.length) return;
      setCurrentSearchIndex(index);
      const cue = cues.find((c) => c.id === searchResults[index]);
      if (cue) seek(cue.startTime);
    },
    [searchResults, setCurrentSearchIndex, cues, seek]
  );

  return {
    query: searchQuery,
    setQuery: setSearchQuery,
    results: searchResults,
    currentIndex: currentSearchIndex,
    matchCount: searchResults.length,
    nextMatch,
    prevMatch,
    jumpToMatch,
    clearSearch,
  };
}
