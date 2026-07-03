// hooks/useSkipBlank.ts
import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useSubtitleStore } from '../stores/subtitleStore';
import { useStudyStore } from '../stores/studyStore';

export function useSkipBlank() {
  const { skipBlank } = useStudyStore();
  const { currentCueId } = useSubtitleStore();
  const { seek } = usePlayerStore();
  const skippedRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!skipBlank || !currentCueId) return;

    const { cues } = useSubtitleStore.getState();
    const currentCue = cues.find((c) => c.id === currentCueId);
    if (!currentCue?.isPlaceholder) return;

    // 避免对同一句重复 seek
    if (skippedRef.current.has(currentCueId)) return;

    let nextCue = cues.find((c) => c.id === currentCueId + 1);
    while (nextCue?.isPlaceholder) {
      skippedRef.current.add(nextCue.id);
      nextCue = cues.find((c) => c.id === nextCue!.id + 1);
    }

    if (nextCue) {
      skippedRef.current.add(currentCueId);
      seek(nextCue.startTime);
    }
  }, [skipBlank, currentCueId, seek]);

  // 当切换到下一句非 placeholder 时清理已跳过记录
  useEffect(() => {
    if (!skipBlank || !currentCueId) return;
    const { cues } = useSubtitleStore.getState();
    const currentCue = cues.find((c) => c.id === currentCueId);
    if (currentCue && !currentCue.isPlaceholder) {
      skippedRef.current.clear();
    }
  }, [skipBlank, currentCueId]);
}
