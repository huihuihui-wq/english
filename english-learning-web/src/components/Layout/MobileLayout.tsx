// components/Layout/MobileLayout.tsx
import { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
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

export function MobileLayout() {
  const [showPanel, setShowPanel] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { video } = usePlayerStore();
  const { activePanel } = useSubtitleStore();

  const renderPanelContent = () => {
    switch (activePanel) {
      case 'ai':
        return <AIPanelContent onClose={() => setShowPanel(false)} />;
      case 'vocab':
        return <VocabularyPanel />;
      case 'search':
        return <SearchPanel />;
      case 'subtitles':
      default:
        return (
          <div className="h-full flex flex-col">
            <ToolBar onSettingsClick={() => setShowSettings(true)} />
            <SubtitleList />
          </div>
        );
    }
  };

  return (
    <div className="h-screen flex flex-col bg-app-bg">
      {/* 视频播放器 */}
      <div className="relative">
        {video && (
          <VideoPlayer videoUrl={video.videoUrl} />
        )}
        {!video && (
          <div className="aspect-video flex items-center justify-center text-gray-500 bg-black">
            请选择视频
          </div>
        )}

        {/* 切换面板按钮 */}
        <button
          className="absolute bottom-4 right-4 bg-black/60 text-white p-2 rounded-full backdrop-blur-sm z-30"
          onClick={() => setShowPanel(!showPanel)}
        >
          {showPanel && <ChevronDown size={20} />}
          {!showPanel && <ChevronUp size={20} />}
        </button>
      </div>

      {/* 学习工具栏 */}
      <StudyToolsBar />

      {/* 底部抽屉式面板 */}
      <div
        className={`flex-1 bg-gray-900 overflow-hidden transition-all duration-300 flex flex-col ${
          showPanel ? 'max-h-[60vh]' : 'max-h-0'
        }`}
      >
        <PanelTabs />
        {renderPanelContent()}
      </div>

      {/* 设置面板 */}
      {showSettings && (
        <SubtitleSettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
