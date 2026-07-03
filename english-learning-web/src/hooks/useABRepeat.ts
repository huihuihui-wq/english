// hooks/useABRepeat.ts
import { useEffect, useCallback } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useStudyStore } from '../stores/studyStore';

export function useABRepeat() {
  const { currentTime } = usePlayerStore();
  const { abRepeat, setABRepeat } = useStudyStore();

  // 设置A点（当前时间）
  const setPointA = useCallback(() => {
    setABRepeat({ startTime: currentTime, endTime: currentTime, isActive: false });
  }, [currentTime, setABRepeat]);

  // 设置B点（当前时间）
  const setPointB = useCallback(() => {
    if (!abRepeat) return;
    setABRepeat({ ...abRepeat, endTime: currentTime, isActive: true });
  }, [currentTime, abRepeat, setABRepeat]);

  // 单句循环：直接设置某句的 AB 范围
  const setSentenceRepeat = useCallback((startTime: number, endTime: number) => {
    setABRepeat({ startTime, endTime, isActive: true });
    usePlayerStore.getState().seek(startTime);
  }, [setABRepeat]);

  // 监听时间，到达B点时跳回A点
  useEffect(() => {
    if (abRepeat?.isActive && currentTime >= abRepeat.endTime) {
      usePlayerStore.getState().seek(abRepeat.startTime);
    }
  }, [currentTime, abRepeat]);

  // 清除AB复读
  const clearABRepeat = useCallback(() => {
    setABRepeat(null);
  }, [setABRepeat]);

  return { setPointA, setPointB, setSentenceRepeat, clearABRepeat, abRepeat };
}
