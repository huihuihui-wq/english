// components/StudyTools/StudyToolsBar.tsx
import { useState, useCallback, useRef, useEffect } from 'react';
import {
  SkipBack, Play, SkipForward,
  RotateCcw, ArrowLeftRight, Eye, EyeOff, Type, Languages,
  Gauge, Mic
} from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { useStudyStore } from '../../stores/studyStore';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useABRepeat } from '../../hooks/useABRepeat';
import { ShadowRecordingPanel } from '../ShadowRecording/ShadowRecordingPanel';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const DISPLAY_MODES = ['bilingual', 'primary', 'secondary', 'none'] as const;

export function StudyToolsBar() {
  const { isPlaying, togglePlay, currentTime, seek, playbackRate, setPlaybackRate } = usePlayerStore();
  const {
    isSentenceShadowing, toggleSentenceShadowing,
    skipBlank, toggleSkipBlank,
    occlusionMode, setOcclusionMode,
    abRepeat,
    isShadowingPaused,
    shadowingPauseProgress,
    shadowingPauseMs,
    shadowingLoopCount,
  } = useStudyStore();
  const { settings, updateSettings, cues } = useSubtitleStore();
  const { setPointA, setPointB, clearABRepeat } = useABRepeat();

  const [showSpeed, setShowSpeed] = useState(false);
  const [showRecordingPanel, setShowRecordingPanel] = useState(false);
  const speedRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭倍速 popover
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (speedRef.current && !speedRef.current.contains(e.target as Node)) {
        setShowSpeed(false);
      }
    }
    if (showSpeed) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSpeed]);

  // 上一句/下一句
  const goToPrevSentence = useCallback(() => {
    const currentCue = cues.find(c => currentTime >= c.startTime && currentTime <= c.endTime);
    if (!currentCue) return;
    const prevCue = cues.find(c => c.id === currentCue.id - 1);
    if (prevCue) {
      seek(prevCue.startTime);
    }
  }, [currentTime, cues, seek]);

  const goToNextSentence = useCallback(() => {
    const currentCue = cues.find(c => currentTime >= c.startTime && currentTime <= c.endTime);
    if (!currentCue) return;
    const nextCue = cues.find(c => c.id === currentCue.id + 1);
    if (nextCue) {
      seek(nextCue.startTime);
    }
  }, [currentTime, cues, seek]);

  // AB复读按钮处理
  const handleABRepeat = useCallback(() => {
    if (abRepeat?.isActive) {
      clearABRepeat();
    } else if (abRepeat) {
      setPointB();
    } else {
      setPointA();
    }
  }, [abRepeat, setPointA, setPointB, clearABRepeat]);

  // 遮挡板模式循环
  const toggleOcclusion = useCallback(() => {
    const modes = ['none', 'secondary', 'primary', 'words'] as const;
    const currentIndex = modes.indexOf(occlusionMode);
    const nextMode = modes[(currentIndex + 1) % modes.length];
    setOcclusionMode(nextMode);
  }, [occlusionMode, setOcclusionMode]);

  // 字幕显示模式循环
  const cycleDisplayMode = useCallback(() => {
    const currentIndex = DISPLAY_MODES.indexOf(settings.displayMode);
    const nextMode = DISPLAY_MODES[(currentIndex + 1) % DISPLAY_MODES.length];
    updateSettings({ displayMode: nextMode });
  }, [settings.displayMode, updateSettings]);

  const getDisplayModeLabel = () => {
    switch (settings.displayMode) {
      case 'bilingual': return '双语';
      case 'primary': return '英文';
      case 'secondary': return '中文';
      case 'none': return '隐藏';
      default: return '字幕';
    }
  };

  const getDisplayModeIcon = () => {
    switch (settings.displayMode) {
      case 'bilingual': return Eye;
      case 'primary': return Type;
      case 'secondary': return Languages;
      case 'none': return EyeOff;
      default: return Eye;
    }
  };

  const DisplayIcon = getDisplayModeIcon();

  return (
    <div className="flex flex-col border-t border-white/10">
      {/* 中间播放控制 */}
      <div className="flex items-center justify-center gap-6 py-3">
        <button
          className="flex flex-col items-center gap-1 text-gray-400 hover:text-white transition-colors"
          onClick={goToPrevSentence}
        >
          <SkipBack size={24} />
          <span className="text-[10px]">上一句</span>
        </button>

        <button
          className="w-14 h-14 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          onClick={togglePlay}
        >
          {isPlaying ? <PauseIcon size={28} /> : <Play size={28} fill="white" />}
        </button>

        <button
          className="flex flex-col items-center gap-1 text-gray-400 hover:text-white transition-colors"
          onClick={goToNextSentence}
        >
          <SkipForward size={24} />
          <span className="text-[10px]">下一句</span>
        </button>
      </div>

      {/* 逐句复读暂停进度条 */}
      {isSentenceShadowing && isShadowingPaused && (
        <div className="px-6 py-2">
          <div className="flex items-center justify-between text-xs text-subtitle-highlight mb-1">
            <span>请跟读这句话</span>
            <span>{shadowingLoopCount} 遍 / 暂停 {shadowingPauseMs / 1000}s</span>
          </div>
          <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-subtitle-highlight transition-all duration-100"
              style={{ width: `${shadowingPauseProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* 底部学习工具 */}
      <div className="flex items-center justify-around px-4 py-2 border-t border-white/10">
        <StudyToolButton
          icon={RotateCcw}
          label="逐句复读"
          active={isSentenceShadowing}
          onClick={toggleSentenceShadowing}
        />
        <StudyToolButton
          icon={Mic}
          label="跟读"
          active={showRecordingPanel}
          onClick={() => setShowRecordingPanel(true)}
        />
        <StudyToolButton
          icon={ArrowLeftRight}
          label={abRepeat?.isActive ? '清除AB' : abRepeat ? '设B点' : 'AB复读'}
          active={!!abRepeat}
          onClick={handleABRepeat}
        />
        <StudyToolButton
          icon={SkipForward}
          label="跳过空白"
          active={skipBlank}
          onClick={toggleSkipBlank}
        />
        <StudyToolButton
          icon={DisplayIcon}
          label={getDisplayModeLabel()}
          active={settings.displayMode !== 'bilingual'}
          onClick={cycleDisplayMode}
        />
        <StudyToolButton
          icon={EyeOff}
          label={`遮挡:${occlusionMode === 'none' ? '关' : occlusionMode === 'primary' ? '英' : occlusionMode === 'secondary' ? '中' : '词'}`}
          active={occlusionMode !== 'none'}
          onClick={toggleOcclusion}
        />

        {/* 倍速 */}
        <div className="relative" ref={speedRef}>
          <StudyToolButton
            icon={Gauge}
            label={`${playbackRate}x`}
            active={playbackRate !== 1}
            onClick={() => setShowSpeed(v => !v)}
          />
          {showSpeed && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-gray-800 border border-white/10 rounded-lg shadow-xl p-1 flex flex-col gap-0.5 z-20">
              {SPEEDS.map((speed) => (
                <button
                  key={speed}
                  onClick={() => {
                    setPlaybackRate(speed);
                    setShowSpeed(false);
                  }}
                  className={`px-3 py-1.5 text-xs rounded transition-colors whitespace-nowrap ${
                    playbackRate === speed
                      ? 'bg-subtitle-highlight text-black'
                      : 'text-gray-300 hover:bg-white/10'
                  }`}
                >
                  {speed}x
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 跟读录音面板弹窗 */}
      {showRecordingPanel && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60">
          <div className="w-full sm:w-[420px] sm:max-w-[90vw] h-[70vh] sm:h-[600px] bg-gray-900 rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden">
            <ShadowRecordingPanel onClose={() => setShowRecordingPanel(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

interface StudyToolButtonProps {
  icon: typeof Play;
  label: string;
  active: boolean;
  onClick: () => void;
}

function StudyToolButton({ icon: Icon, label, active, onClick }: StudyToolButtonProps) {
  return (
    <button
      className={`tool-btn ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      <Icon size={18} />
      <span className="text-[10px] whitespace-nowrap">{label}</span>
    </button>
  );
}

// 简单的 Pause 图标组件
function PauseIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="white">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}
