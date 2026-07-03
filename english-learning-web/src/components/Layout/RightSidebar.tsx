// components/Layout/RightSidebar.tsx
import { PanelTabs } from './PanelTabs';
import { AIPanelContent } from '../AIPanel/AIPanelContent';
import { VocabularyPanel } from '../VocabularyPanel/VocabularyPanel';
import { SearchPanel } from '../SearchPanel/SearchPanel';
import { ToolBar } from '../Toolbar/ToolBar';
import { SubtitleList } from '../SubtitlePanel/SubtitleList';
import { useSubtitleStore } from '../../stores/subtitleStore';

interface RightSidebarProps {
  onSettingsClick: () => void;
}

export function RightSidebar({ onSettingsClick }: RightSidebarProps) {
  const { activePanel } = useSubtitleStore();

  return (
    <div className="w-[40%] h-full flex flex-col bg-app-bg border-l border-white/10">
      <PanelTabs />
      <div className="flex-1 flex flex-col overflow-hidden">
        {activePanel === 'ai' && <AIPanelContent />}
        {activePanel === 'vocab' && <VocabularyPanel />}
        {activePanel === 'search' && <SearchPanel />}
        {activePanel === 'subtitles' && (
          <>
            <ToolBar onSettingsClick={onSettingsClick} />
            <SubtitleList />
          </>
        )}
      </div>
    </div>
  );
}
