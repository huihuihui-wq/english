// components/VideoPlayer/PlayerControls.tsx
import { useRef, useState, useCallback } from 'react';
import { 
  Play, Pause, Volume2, VolumeX, Maximize, SkipBack, SkipForward
} from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { formatTime } from '../../utils/timeFormat';

interface PlayerControlsProps {
  onFullscreenToggle: () => void;
}

export function PlayerControls({ onFullscreenToggle }: PlayerControlsProps) {
  const { 
    isPlaying, currentTime, duration, volume, playbackRate,
    togglePlay, seek, setVolume, setPlaybackRate
  } = usePlayerStore();
  
  const [showControls, setShowControls] = useState(true);
  const [hoverTime, setHoverTime] = useState(0);
  const progressRef = useRef<HTMLDivElement>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    if (isPlaying) {
      hideTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
    }
  }, [isPlaying]);
  
  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || !duration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seek(ratio * duration);
  }, [duration, seek]);
  
  const handleProgressHover = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || !duration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    setHoverTime(ratio * duration);
  }, [duration]);
  
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
  
  return (
    <div 
      className={`absolute inset-0 flex flex-col justify-end transition-opacity duration-300 ${
        showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      {/* 渐变遮罩 */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent pointer-events-none" />
      
      {/* 控制栏 */}
      <div className="relative z-20 px-4 pb-4">
        {/* 进度条 */}
        <div 
          ref={progressRef}
          className="relative h-1.5 bg-white/20 rounded-full cursor-pointer mb-3 group"
          onClick={handleProgressClick}
          onMouseMove={handleProgressHover}
        >
          <div 
            className="absolute h-full bg-subtitle-highlight rounded-full transition-all"
            style={{ width: `${progress}%` }}
          />
          <div 
            className="absolute w-3 h-3 bg-white rounded-full -top-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ left: `calc(${progress}% - 6px)` }}
          />
          
          {/* 悬停时间提示 */}
          {showControls && (
            <div 
              className="absolute -top-8 text-xs text-white bg-black/70 px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
              style={{ left: `${(hoverTime / duration) * 100}%`, transform: 'translateX(-50%)' }}
            >
              {formatTime(hoverTime)}
            </div>
          )}
        </div>
        
        {/* 按钮行 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button 
              className="p-2 text-white hover:text-subtitle-highlight transition-colors"
              onClick={() => seek(Math.max(0, currentTime - 5000))}
            >
              <SkipBack size={20} />
            </button>
            
            <button 
              className="p-2 text-white hover:text-subtitle-highlight transition-colors"
              onClick={togglePlay}
            >
              {isPlaying ? <Pause size={24} fill="white" /> : <Play size={24} fill="white" />}
            </button>
            
            <button 
              className="p-2 text-white hover:text-subtitle-highlight transition-colors"
              onClick={() => seek(Math.min(duration, currentTime + 5000))}
            >
              <SkipForward size={20} />
            </button>
            
            {/* 音量 */}
            <div className="flex items-center gap-1 group">
              <button 
                className="p-2 text-white hover:text-subtitle-highlight transition-colors"
                onClick={() => setVolume(volume > 0 ? 0 : 1)}
              >
                {volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
                className="w-20 h-1 accent-subtitle-highlight opacity-0 group-hover:opacity-100 transition-opacity"
              />
            </div>
            
            <span className="text-white text-sm ml-2">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
          
          <div className="flex items-center gap-2">
            {/* 倍速 */}
            <div className="relative group">
              <button className="px-2 py-1 text-white text-sm hover:text-subtitle-highlight transition-colors">
                {playbackRate}x
              </button>
              <div className="absolute bottom-full right-0 mb-2 bg-black/90 rounded-lg p-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto">
                {speeds.map(speed => (
                  <button
                    key={speed}
                    className={`block w-full px-3 py-1.5 text-sm text-left rounded hover:bg-white/10 ${
                      playbackRate === speed ? 'text-subtitle-highlight' : 'text-white'
                    }`}
                    onClick={() => setPlaybackRate(speed)}
                  >
                    {speed}x
                  </button>
                ))}
              </div>
            </div>
            
            <button 
              className="p-2 text-white hover:text-subtitle-highlight transition-colors"
              onClick={onFullscreenToggle}
            >
              <Maximize size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
