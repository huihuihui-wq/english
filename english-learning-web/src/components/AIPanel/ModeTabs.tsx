// components/AIPanel/ModeTabs.tsx - 4 模式切换
import { MessageCircle, GraduationCap, Sparkles, BookOpen } from 'lucide-react'
import type { AIMode } from '../../types/ai'
import { useAIStore } from '../../stores/aiStore'

const MODES: { id: AIMode; icon: typeof MessageCircle; label: string }[] = [
  { id: 'chat', icon: MessageCircle, label: '对话' },
  { id: 'exam', icon: GraduationCap, label: '雅思' },
  { id: 'generate', icon: Sparkles, label: '生成题' },
  { id: 'explain', icon: BookOpen, label: '讲解' },
]

export function ModeTabs() {
  const mode = useAIStore((s) => s.mode)
  const setMode = useAIStore((s) => s.setMode)

  return (
    <div className="flex border-b border-white/10">
      {MODES.map((m) => {
        const Icon = m.icon
        const active = mode === m.id
        return (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`flex-1 flex flex-col items-center gap-1 py-2 transition-colors ${
              active
                ? 'text-subtitle-highlight bg-white/5'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Icon size={16} />
            <span className="text-[10px]">{m.label}</span>
          </button>
        )
      })}
    </div>
  )
}