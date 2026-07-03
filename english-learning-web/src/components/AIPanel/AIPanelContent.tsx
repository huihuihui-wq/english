// components/AIPanel/AIPanelContent.tsx
import { X } from 'lucide-react';
import { ModeTabs } from './ModeTabs';
import { ChatMode } from './ChatMode';
import { ExamMode } from './ExamMode';
import { ExplainMode } from './ExplainMode';
import { GenerateMode } from './GenerateMode';
import { useAIStore } from '../../stores/aiStore';

interface AIPanelContentProps {
  onClose?: () => void;
}

export function AIPanelContent({ onClose }: AIPanelContentProps) {
  const mode = useAIStore((s) => s.mode);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">🤖 AI 助手</span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/10 transition-colors text-gray-400 hover:text-white"
            title="关闭"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <ModeTabs />
      <div className="flex-1 overflow-hidden">
        {mode === 'chat' && <ChatMode />}
        {mode === 'exam' && <ExamMode />}
        {mode === 'explain' && <ExplainMode />}
        {mode === 'generate' && <GenerateMode />}
      </div>
    </div>
  );
}
