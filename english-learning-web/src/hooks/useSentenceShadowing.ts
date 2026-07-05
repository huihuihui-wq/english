import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useSubtitleStore } from '../stores/subtitleStore';
import { useStudyStore } from '../stores/studyStore';

export function useSentenceShadowing() {
  const {
    isSentenceShadowing,
    shadowingPauseMs,
    skipBlank,
    shadowingLoopCount,
    setShadowingPauseState,
  } = useStudyStore();
  const { currentTime, isPlaying, pause, play, seek } = usePlayerStore();
  const { cues, currentCueId } = useSubtitleStore();

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastCueRef = useRef<number | null>(null);
  const playedCountRef = useRef(0);

  const getCurrentCueIndex = () => {
    if (currentCueId === null) return -1;
    return cues.findIndex((c) => c.id === currentCueId);
  };

  const getNextCueIndex = (fromIndex: number) => {
    let idx = fromIndex + 1;
    while (idx < cues.length) {
      if (!skipBlank || !cues[idx].isPlaceholder) {
        return idx;
      }
      idx++;
    }
    return -1;
  };

  // 清理计时器
  const clearTimers = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  useEffect(() => {
    if (!isSentenceShadowing || !isPlaying || currentCueId === null) {
      clearTimers();
      setShadowingPauseState(false, 0);
      return;
    }

    const currentCueIndex = getCurrentCueIndex();
    if (currentCueIndex < 0 || currentCueIndex >= cues.length) return;

    const currentCue = cues[currentCueIndex];
    if (!currentCue) return;

    // 已经处理过这句，避免重复触发
    if (lastCueRef.current === currentCueId) return;

    // 播放时间到达或超过当前句末尾（容差 50ms）
    if (currentTime >= currentCue.endTime - 50) {
      lastCueRef.current = currentCueId;
      playedCountRef.current += 1;

      pause();
      setShadowingPauseState(true, 0);

      const totalPause = Math.max(500, shadowingPauseMs);
      const updateInterval = 100;
      let elapsed = 0;

      intervalRef.current = setInterval(() => {
        elapsed += updateInterval;
        const progress = Math.min(100, (elapsed / totalPause) * 100);
        setShadowingPauseState(true, progress);
      }, updateInterval);

      timeoutRef.current = setTimeout(() => {
        clearTimers();
        setShadowingPauseState(false, 100);

        if (!isSentenceShadowing) return;

        if (playedCountRef.current < shadowingLoopCount) {
          // 继续复读当前句
          seek(currentCue.startTime);
          play();
        } else {
          // 已经复读足够次数，播放下一句
          playedCountRef.current = 0;
          const nextIndex = getNextCueIndex(currentCueIndex);
          if (nextIndex >= 0) {
            seek(cues[nextIndex].startTime);
            play();
          }
        }
      }, totalPause);
    }

    return () => {
      clearTimers();
    };
  }, [
    isSentenceShadowing,
    isPlaying,
    currentTime,
    currentCueId,
    cues,
    shadowingPauseMs,
    skipBlank,
    shadowingLoopCount,
    pause,
    play,
    seek,
    setShadowingPauseState,
  ]);

  // 当逐句复读关闭或用户手动 seek 时重置状态
  useEffect(() => {
    if (!isSentenceShadowing) {
      lastCueRef.current = null;
      playedCountRef.current = 0;
      clearTimers();
      setShadowingPauseState(false, 0);
    }
  }, [isSentenceShadowing, setShadowingPauseState]);

  // 当 currentCueId 变化时，如果是新句子则重置播放计数
  useEffect(() => {
    if (isSentenceShadowing && currentCueId !== null && lastCueRef.current !== currentCueId) {
      playedCountRef.current = 0;
    }
  }, [isSentenceShadowing, currentCueId]);
}
