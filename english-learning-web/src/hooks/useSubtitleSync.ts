// hooks/useSubtitleSync.ts
import { useEffect, useCallback } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useSubtitleStore } from '../stores/subtitleStore';

export function useSubtitleSync() {
  const { currentTime } = usePlayerStore();
  const { cues, setCurrentCueId } = useSubtitleStore();
  
  // 根据当前时间找到对应的字幕
  useEffect(() => {
    const currentCue = cues.find(
      cue => currentTime >= cue.startTime && currentTime <= cue.endTime
    );
    
    if (currentCue) {
      setCurrentCueId(currentCue.id);
    }
  }, [currentTime, cues, setCurrentCueId]);
  
  // 点击字幕跳转视频时间
  const seekToCue = useCallback((cueId: number) => {
    const cue = cues.find(c => c.id === cueId);
    if (cue) {
      usePlayerStore.getState().seek(cue.startTime);
      usePlayerStore.getState().play();
    }
  }, [cues]);
  
  return { seekToCue };
}
