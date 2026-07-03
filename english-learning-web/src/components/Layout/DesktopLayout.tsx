// components/Layout/DesktopLayout.tsx
import { useState } from 'react';
import { VideoPlayer } from '../VideoPlayer/VideoPlayer';
import { StudyToolsBar } from '../StudyTools/StudyToolsBar';
import { SubtitleSettingsPanel } from '../SubtitleSettings/SubtitleSettingsPanel';
import { RightSidebar } from './RightSidebar';
import { usePlayerStore } from '../../stores/playerStore';

export function DesktopLayout() {
  const [showSettings, setShowSettings] = useState(false);
  const { video } = usePlayerStore();

  return (
    <div className="h-screen flex bg-app-bg">
      {/* 左侧：视频播放器 */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 flex items-center justify-center bg-black">
          {video && (
            <VideoPlayer videoUrl={video.videoUrl} />
          )}
          {!video && (
            <div className="text-gray-500">请选择视频</div>
          )}
        </div>

        <StudyToolsBar />
      </div>

      {/* 右侧：可切换面板 */}
      <RightSidebar onSettingsClick={() => setShowSettings(true)} />

      {/* 设置面板 */}
      {showSettings && (
        <SubtitleSettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
