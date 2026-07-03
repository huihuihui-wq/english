// components/AIPanel/AIPanel.tsx - AI 助手主容器 (右侧侧边栏)
import { X } from 'lucide-react'
import { ModeTabs } from './ModeTabs'
import { ChatMode } from './ChatMode'
import { ExamMode } from './ExamMode'
import { ExplainMode } from './ExplainMode'
import { GenerateMode } from './GenerateMode'
import { useAIStore } from '../../stores/aiStore'
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary'

interface AIPanelProps {
  onClose: () => void
}

export function AIPanel({ onClose }: AIPanelProps) {
  const mode = useAIStore((s) => s.mode)

  return (
    <div className="w-[40%] h-full flex flex-col bg-app-bg border-l border-white/10 animate-in slide-in-from-right">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">🤖 AI 助手</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-white/10 transition-colors text-gray-400 hover:text-white"
          title="关闭 AI 助手"
        >
          <X size={16} />
        </button>
      </div>

      <ModeTabs />

      <div className="flex-1 overflow-hidden">
        <ErrorBoundary>
          {mode === 'chat' && <ChatMode />}
          {mode === 'exam' && <ExamMode />}
          {mode === 'explain' && <ExplainMode />}
          {mode === 'generate' && <GenerateMode />}
        </ErrorBoundary>
      </div>
    </div>
  )
}