// components/Layout/PanelTabs.tsx
import { Bot, BookOpen, Search, List } from 'lucide-react';
import { useSubtitleStore, type SidePanel } from '../../stores/subtitleStore';

const panels: { id: SidePanel; label: string; icon: typeof Bot }[] = [
  { id: 'subtitles', label: '字幕', icon: List },
  { id: 'ai', label: 'AI 助手', icon: Bot },
  { id: 'vocab', label: '词汇', icon: BookOpen },
  { id: 'search', label: '查找', icon: Search },
];

export function PanelTabs() {
  const { activePanel, setActivePanel } = useSubtitleStore();

  return (
    <div className="flex items-center border-b border-white/10 bg-app-bg shrink-0">
      {panels.map((panel) => {
        const Icon = panel.icon;
        const isActive = activePanel === panel.id;
        return (
          <button
            key={panel.id}
            onClick={() => setActivePanel(panel.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
              isActive
                ? 'text-subtitle-highlight border-b-2 border-subtitle-highlight'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Icon size={14} />
            {panel.label}
          </button>
        );
      })}
    </div>
  );
}
