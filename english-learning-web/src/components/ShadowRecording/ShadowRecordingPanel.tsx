import { useRef, useState } from 'react';
import { Mic, Square, Play, Pause, Trash2, AlertCircle } from 'lucide-react';
import { useShadowRecording } from '../../hooks/useShadowRecording';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useStudyStore } from '../../stores/studyStore';
import { WaveformCompare } from './WaveformCompare';
import { getRecording, deleteRecording } from '../../utils/shadowRecordingStorage';
import type { ShadowRecordingMeta } from '../../utils/shadowRecordingStorage';

interface ShadowRecordingPanelProps {
  onClose?: () => void;
}

export function ShadowRecordingPanel({ onClose }: ShadowRecordingPanelProps) {
  const { currentCueId, cues } = useSubtitleStore();
  const { autoRecordAfterCue, toggleAutoRecordAfterCue, shadowRecordingMaxMs, setShadowRecordingMaxMs } = useStudyStore();
  const {
    recordingState,
    recentRecordings,
    hasPermission,
    error,
    requestPermission,
    startRecordingForCue,
    stopRecording,
    refreshRecordingsForCue,
  } = useShadowRecording({ enableAutoRecord: false });

  const [playingId, setPlayingId] = useState<string | null>(null);
  const [selectedRecording, setSelectedRecording] = useState<ShadowRecordingMeta | null>(null);
  const [selectedBlob, setSelectedBlob] = useState<Blob | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const currentCue = cues.find((c) => c.id === currentCueId);
  const isRecording = recordingState === 'recording';

  const handleRecordToggle = async () => {
    if (isRecording) {
      await stopRecording();
      return;
    }
    if (hasPermission === false) {
      await requestPermission();
      return;
    }
    if (currentCueId === null) return;
    await startRecordingForCue(currentCueId);
  };

  const handlePlay = async (meta: ShadowRecordingMeta) => {
    if (playingId === meta.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }

    try {
      const rec = await getRecording(meta.id);
      if (!rec) return;
      setSelectedRecording(meta);
      setSelectedBlob(rec.audioBlob);

      if (audioRef.current) {
        audioRef.current.pause();
        URL.revokeObjectURL(audioRef.current.src);
      }

      const url = URL.createObjectURL(rec.audioBlob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => setPlayingId(null);
      await audio.play();
      setPlayingId(meta.id);
    } catch (err) {
      console.error('Playback failed:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteRecording(id);
      if (selectedRecording?.id === id) {
        setSelectedRecording(null);
        setSelectedBlob(null);
      }
      if (currentCueId !== null) {
        await refreshRecordingsForCue(currentCueId);
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 text-white p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">跟读录音</h2>
        {onClose && (
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            ✕
          </button>
        )}
      </div>

      {currentCue && (
        <div className="mb-4 p-3 bg-white/5 rounded-lg">
          <p className="text-sm text-gray-300 line-clamp-2">{currentCue.en || currentCue.text}</p>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-sm text-red-300">
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      <div className="mb-4 space-y-3 p-3 bg-white/5 rounded-lg">
        <label className="flex items-center justify-between text-sm text-gray-300 cursor-pointer">
          <span>句末自动录音</span>
          <input
            type="checkbox"
            checked={autoRecordAfterCue}
            onChange={toggleAutoRecordAfterCue}
            className="w-4 h-4 accent-subtitle-highlight"
          />
        </label>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>最长录音时长</span>
            <span>{shadowRecordingMaxMs / 1000}s</span>
          </div>
          <input
            type="range"
            min={2000}
            max={15000}
            step={1000}
            value={shadowRecordingMaxMs}
            onChange={(e) => setShadowRecordingMaxMs(Number(e.target.value))}
            className="w-full h-1 accent-subtitle-highlight"
          />
        </div>
      </div>

      <button
        onClick={handleRecordToggle}
        disabled={recordingState === 'processing' || currentCueId === null}
        className={`w-full py-3 rounded-lg flex items-center justify-center gap-2 font-medium transition-colors ${
          isRecording
            ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
            : 'bg-subtitle-highlight text-black hover:bg-cyan-300'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {isRecording ? (
          <>
            <Square size={18} fill="currentColor" />
            停止录音
          </>
        ) : (
          <>
            <Mic size={18} />
            {hasPermission === false ? '授权麦克风' : '开始录音'}
          </>
        )}
      </button>

      {isRecording && (
        <div className="mt-3 flex items-center justify-center gap-2 text-sm text-red-400">
          <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
          正在录音...
        </div>
      )}

      {selectedBlob && (
        <div className="mt-6 space-y-2">
          <h3 className="text-sm font-medium text-gray-300">波形对比</h3>
          <WaveformCompare
            userAudioBlob={selectedBlob}
            height={64}
          />
        </div>
      )}

      <div className="mt-6 flex-1">
        <h3 className="text-sm font-medium text-gray-300 mb-2">历史录音</h3>
        {recentRecordings.length === 0 ? (
          <p className="text-sm text-gray-500">暂无录音，点击上方按钮开始跟读</p>
        ) : (
          <ul className="space-y-2">
            {recentRecordings.map((rec) => (
              <li
                key={rec.id}
                className={`flex items-center justify-between p-2 rounded-lg border ${
                  selectedRecording?.id === rec.id
                    ? 'bg-white/10 border-subtitle-highlight'
                    : 'bg-white/5 border-white/10'
                }`}
              >
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handlePlay(rec)}
                    className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"
                  >
                    {playingId === rec.id ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}
                  </button>
                  <div className="text-xs">
                    <p className="text-gray-300">{formatDuration(rec.durationMs)}</p>
                    <p className="text-gray-500">{new Date(rec.createdAt).toLocaleString()}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(rec.id)}
                  className="p-2 text-gray-400 hover:text-red-400"
                  title="删除"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
