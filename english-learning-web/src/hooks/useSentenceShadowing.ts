import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useSubtitleStore } from '../stores/subtitleStore';
import { useStudyStore } from '../stores/studyStore';

export function useSentenceShadowing() {
  const { isSentenceShadowing, shadowingPauseMs, skipBlank, shadowingLoopCount, shadowingDelayMs } = useStudyStore();
  const { currentTime, isPlaying, pause, play, seek } = usePlayerStore();
  const { cues, currentCueId } = useSubtitleStore();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCueRef = useRef<number | null>(null);
  const loopCountRef = useRef(0);
  const delayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 获取当前 cue 在 cues 数组中的实际索引（修复 ID 连续性假设）
  const getCurrentCueIndex = () => {
    if (currentCueId === null) return -1;
    return cues.findIndex((c) => c.id === currentCueId);
  };

  // 获取下一句的索引（跳过 placeholder）
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

  useEffect(() => {
    if (!isSentenceShadowing || !isPlaying || currentCueId === null) return;

    const currentCueIndex = getCurrentCueIndex();
    if (currentCueIndex < 0 || currentCueIndex >= cues.length) return;

    const currentCue = cues[currentCueIndex];
    if (!currentCue) return;

    // 已经处理过这句，避免重复触发
    if (lastCueRef.current === currentCueId) return;

    // 播放时间到达或超过当前句末尾（容差 50ms）
    if (currentTime >= currentCue.endTime - 50) {
      lastCueRef.current = currentCueId;
      loopCountRef.current += 1;

      // 如果还没达到循环次数，重播当前句
      if (loopCountRef.current < shadowingLoopCount) {
        pause();
        
        // 延迟跟读模式：延迟 shadowingDelayMs 后重播
        if (shadowingDelayMs > 0) {
          delayTimeoutRef.current = setTimeout(() => {
            if (!isSentenceShadowing) return;
            seek(currentCue.startTime);
            play();
          }, shadowingDelayMs);
        } else {
          // 立即重播
          seek(currentCue.startTime);
          play();
        }
        return;
      }

      // 循环结束，播放下一句
      loopCountRef.current = 0;
      pause();

      const nextIndex = getNextCueIndex(currentCueIndex);
      if (nextIndex >= 0) {
        timeoutRef.current = setTimeout(() => {
          if (!isSentenceShadowing) return;
          seek(cues[nextIndex].startTime);
          play();
        }, shadowingPauseMs);
      }
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (delayTimeoutRef.current) {
        clearTimeout(delayTimeoutRef.current);
        delayTimeoutRef.current = null;
      }
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
    shadowingDelayMs,
    pause,
    play,
    seek,
  ]);

  // 当逐句复读关闭或用户手动 seek 时重置状态
  useEffect(() => {
    if (!isSentenceShadowing) {
      lastCueRef.current = null;
      loopCountRef.current = 0;
      if (delayTimeoutRef.current) {
        clearTimeout(delayTimeoutRef.current);
        delayTimeoutRef.current = null;
      }
    }
  }, [isSentenceShadowing]);

  // 当 currentCueId 变化时，如果是新句子则重置循环计数
  useEffect(() => {
    if (isSentenceShadowing && currentCueId !== null && lastCueRef.current !== currentCueId) {
      loopCountRef.current = 0;
    }
  }, [isSentenceShadowing, currentCueId]);
}
