// components/Layout/TabletLayout.tsx
import { useState } from 'react';
import { VideoPlayer } from '../VideoPlayer/VideoPlayer';
import { SubtitleList } from '../SubtitlePanel/SubtitleList';
import { ToolBar } from '../Toolbar/ToolBar';
import { StudyToolsBar } from '../StudyTools/StudyToolsBar';
import { SubtitleSettingsPanel } from '../SubtitleSettings/SubtitleSettingsPanel';
import { AIPanelContent } from '../AIPanel/AIPanelContent';
import { usePlayerStore } from '../../stores/playerStore';

export function TabletLayout() {
  const [showSettings, setShowSettings] = useState(false);
  const [showAI, setShowAI] = useState(false);
  const { video } = usePlayerStore();

  const videoWrapperClass = showAI ? 'h-[50%]' : 'flex-1';

  return (
    <div className="h-screen flex flex-col bg-app-bg">
      <div className={`${videoWrapperClass} transition-all duration-300`}>
        {video && (
          <VideoPlayer videoUrl={video.videoUrl} />
        )}
        {!video && (
          <div className="h-full flex items-center justify-center text-gray-500">
            请选择视频
          </div>
        )}
      </div>

      {showAI && (
        <div className="h-[50%] flex flex-col border-t border-white/10">
          <AIPanelContent onClose={() => setShowAI(false)} />
        </div>
      )}
      {!showAI && (
        <div className="flex-1 flex flex-col border-t border-white/10">
          <ToolBar onSettingsClick={() => setShowSettings(true)} />
          <SubtitleList />
          <StudyToolsBar />
        </div>
      )}

      {showSettings && (
        <SubtitleSettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
