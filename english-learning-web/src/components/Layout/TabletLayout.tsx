// components/Layout/TabletLayout.tsx
import { useState } from 'react';
import { VideoPlayer } from '../VideoPlayer/VideoPlayer';
import { SubtitleList } from '../SubtitlePanel/SubtitleList';
import { ToolBar } from '../Toolbar/ToolBar';
import { StudyToolsBar } from '../StudyTools/StudyToolsBar';
import { SubtitleSettingsPanel } from '../SubtitleSettings/SubtitleSettingsPanel';
import { AIPanelContent } from '../AIPanel/AIPanelContent';
import { VocabularyPanel } from '../VocabularyPanel/VocabularyPanel';
import { SearchPanel } from '../SearchPanel/SearchPanel';
import { PanelTabs } from './PanelTabs';
import { usePlayerStore } from '../../stores/playerStore';
import { useSubtitleStore } from '../../stores/subtitleStore';

export function TabletLayout() {
  const [showSettings, setShowSettings] = useState(false);
  const { video } = usePlayerStore();
  const { activePanel } = useSubtitleStore();

  const isSidePanel = activePanel === 'ai' || activePanel === 'vocab' || activePanel === 'search';
  const videoWrapperClass = isSidePanel ? 'h-[50%]' : 'flex-1';

  const renderPanelContent = () => {
    switch (activePanel) {
      case 'ai':
        return <AIPanelContent />;
      case 'vocab':
        return <VocabularyPanel />;
      case 'search':
        return <SearchPanel />;
      case 'subtitles':
      default:
        return (
          <div className="flex-1 flex flex-col border-t border-white/10">
            <ToolBar onSettingsClick={() => setShowSettings(true)} />
            <SubtitleList />
            <StudyToolsBar />
          </div>
        );
    }
  };

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

      {isSidePanel && (
        <div className="h-[50%] flex flex-col border-t border-white/10">
          <PanelTabs />
          {renderPanelContent()}
        </div>
      )}
      {!isSidePanel && renderPanelContent()}

      {showSettings && (
        <SubtitleSettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
