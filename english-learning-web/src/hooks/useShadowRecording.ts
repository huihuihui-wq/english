import { useEffect, useRef, useState, useCallback } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useSubtitleStore } from '../stores/subtitleStore';
import { useStudyStore } from '../stores/studyStore';
import {
  saveRecording,
  listRecordingsForCue,
} from '../utils/shadowRecordingStorage';
import type { ShadowRecordingMeta } from '../utils/shadowRecordingStorage';

export type RecordingState = 'idle' | 'listening' | 'recording' | 'processing';

export interface ShadowRecordingState {
  recordingState: RecordingState;
  currentRecordingMeta: ShadowRecordingMeta | null;
  recentRecordings: ShadowRecordingMeta[];
  hasPermission: boolean | null;
  error: string | null;
  requestPermission: () => Promise<void>;
  startRecordingForCue: (cueId: number) => Promise<void>;
  stopRecording: () => Promise<void>;
  refreshRecordingsForCue: (cueId: number) => Promise<void>;
}

export interface UseShadowRecordingOptions {
  enableAutoRecord?: boolean;
}

export function useShadowRecording(options: UseShadowRecordingOptions = {}): ShadowRecordingState {
  const { enableAutoRecord = true } = options;
  const { autoRecordAfterCue, shadowRecordingMaxMs } = useStudyStore();
  const { currentTime, isPlaying } = usePlayerStore();
  const { cues, currentCueId } = useSubtitleStore();

  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [currentRecordingMeta, setCurrentRecordingMeta] = useState<ShadowRecordingMeta | null>(null);
  const [recentRecordings, setRecentRecordings] = useState<ShadowRecordingMeta[]>([]);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordedCueRef = useRef<number | null>(null);
  const isStoppingRef = useRef(false);

  const requestPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setHasPermission(true);
      setError(null);
    } catch (err) {
      setHasPermission(false);
      setError('无法访问麦克风，请检查权限设置');
    }
  }, []);

  const refreshRecordingsForCue = useCallback(async (cueId: number) => {
    try {
      const list = await listRecordingsForCue(cueId);
      setRecentRecordings(list);
    } catch (err) {
      console.error('Failed to list recordings:', err);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;

    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }

    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      setRecordingState('idle');
      isStoppingRef.current = false;
      return;
    }

    setRecordingState('processing');
    recorder.stop();

    // Wait for onstop to finish before resolving
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });

    isStoppingRef.current = false;
  }, []);

  const startRecordingForCue = useCallback(async (cueId: number) => {
    if (recordingState !== 'idle' || isStoppingRef.current) return;

    setError(null);
    recordedCueRef.current = cueId;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setHasPermission(true);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      const startTime = Date.now();

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const durationMs = Date.now() - startTime;
        const blob = new Blob(audioChunksRef.current, { type: mimeType || 'audio/webm' });

        // Stop all tracks to release microphone
        stream.getTracks().forEach((t) => t.stop());

        try {
          const meta = await saveRecording(cueId, blob, durationMs);
          setCurrentRecordingMeta(meta);
          await refreshRecordingsForCue(cueId);
        } catch (err) {
          console.error('Failed to save recording:', err);
          setError('保存录音失败');
        }

        setRecordingState('idle');
        mediaRecorderRef.current = null;
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        setError('录音过程中出错');
        setRecordingState('idle');
        mediaRecorderRef.current = null;
      };

      recorder.start(100);
      setRecordingState('recording');

      // Auto stop after max duration
      recordingTimeoutRef.current = setTimeout(() => {
        stopRecording();
      }, shadowRecordingMaxMs);
    } catch (err) {
      setHasPermission(false);
      setError('无法访问麦克风，请检查权限设置');
      setRecordingState('idle');
    }
  }, [recordingState, shadowRecordingMaxMs, stopRecording, refreshRecordingsForCue]);

  // 自动录音：当前句播放结束后，若开启自动录音则开始录制
  useEffect(() => {
    if (!enableAutoRecord || !autoRecordAfterCue || !isPlaying || currentCueId === null) return;

    const cueIndex = cues.findIndex((c) => c.id === currentCueId);
    if (cueIndex < 0) return;
    const cue = cues[cueIndex];
    if (!cue || cue.isPlaceholder) return;

    // 当播放时间进入句末附近，且没有正在录音时触发
    if (
      currentTime >= cue.endTime - 80 &&
      currentTime <= cue.endTime + 200 &&
      recordingState === 'idle' &&
      recordedCueRef.current !== currentCueId
    ) {
      startRecordingForCue(currentCueId);
    }
  }, [enableAutoRecord, autoRecordAfterCue, isPlaying, currentTime, currentCueId, cues, recordingState, startRecordingForCue]);

  // 切换句子时重置已录音标记
  useEffect(() => {
    if (currentCueId !== null && recordedCueRef.current !== currentCueId) {
      // 如果正在录音且切换了句子，停止当前录音
      if (recordingState === 'recording') {
        stopRecording();
      }
    }
  }, [currentCueId, recordingState, stopRecording]);

  // 加载当前句的历史录音
  useEffect(() => {
    if (currentCueId === null) {
      setRecentRecordings([]);
      return;
    }
    refreshRecordingsForCue(currentCueId);
  }, [currentCueId, refreshRecordingsForCue]);

  // 清理
  useEffect(() => {
    return () => {
      if (recordingTimeoutRef.current) {
        clearTimeout(recordingTimeoutRef.current);
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  return {
    recordingState,
    currentRecordingMeta,
    recentRecordings,
    hasPermission,
    error,
    requestPermission,
    startRecordingForCue,
    stopRecording,
    refreshRecordingsForCue,
  };
}
