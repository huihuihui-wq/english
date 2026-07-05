// hooks/useSubtitleSync.ts
import { useEffect, useCallback } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useSubtitleStore } from '../stores/subtitleStore';

interface UseSubtitleSyncOptions {
  enableSync?: boolean;
}

export function useSubtitleSync(options: UseSubtitleSyncOptions = {}) {
  const { enableSync = true } = options;
  const { currentTime, playbackRate } = usePlayerStore();
  const { cues, setCurrentCueId, settings, updateCue } = useSubtitleStore();
  const { subtitleOffset } = settings;

  // 根据当前时间找到对应的字幕（应用偏移和前向预测）
  useEffect(() => {
    if (!enableSync) return;
    // 前向预测：根据播放速度提前一点判定，倍速越大提前越多
    const lookaheadMs = Math.min(200 * playbackRate, 500);
    const adjustedTime = currentTime + subtitleOffset + lookaheadMs;

    const currentCue = cues.find(
      cue => adjustedTime >= cue.startTime && adjustedTime <= cue.endTime
    );

    if (currentCue) {
      setCurrentCueId(currentCue.id);
    }
  }, [enableSync, currentTime, cues, setCurrentCueId, subtitleOffset, playbackRate]);

  // 点击字幕跳转视频时间
  const seekToCue = useCallback((cueId: number) => {
    const cue = cues.find(c => c.id === cueId);
    if (cue) {
      usePlayerStore.getState().seek(cue.startTime - subtitleOffset);
      usePlayerStore.getState().play();
    }
  }, [cues, subtitleOffset]);

  // 单句时间微调：提前/延后 0.2s
  const adjustCueTime = useCallback((cueId: number, deltaMs: number) => {
    const cue = cues.find(c => c.id === cueId);
    if (!cue) return;
    updateCue(cueId, {
      startTime: cue.startTime + deltaMs,
      endTime: cue.endTime + deltaMs,
    });
  }, [cues, updateCue]);

  return { seekToCue, adjustCueTime };
}
