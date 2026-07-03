// components/AIPanel/MessageBubble.tsx - 单条消息气泡(支持 markdown)
import { Bot, User } from 'lucide-react'
import type { ChatMessage } from '../../types/ai'

interface MessageBubbleProps {
  message: ChatMessage
  streaming?: boolean
}

// 简易 markdown 渲染: 标题/列表/加粗/代码块/换行
function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split('\n')
  const out: React.ReactNode[] = []
  let listBuffer: string[] = []

  const flushList = () => {
    if (listBuffer.length) {
      out.push(
        <ul key={`ul-${out.length}`} className="list-disc list-inside space-y-0.5 my-1">
          {listBuffer.map((item, i) => (
            <li key={i} dangerouslySetInnerHTML={{ __html: inlineMd(item) }} />
          ))}
        </ul>
      )
      listBuffer = []
    }
  }

  lines.forEach((line, idx) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('### ')) {
      flushList()
      out.push(
        <h3 key={idx} className="font-semibold text-sm mt-2 mb-1 text-subtitle-highlight">
          {trimmed.slice(4)}
        </h3>
      )
    } else if (trimmed.startsWith('## ')) {
      flushList()
      out.push(
        <h2 key={idx} className="font-semibold text-base mt-2 mb-1">
          {trimmed.slice(3)}
        </h2>
      )
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      listBuffer.push(trimmed.slice(2))
    } else if (trimmed === '') {
      flushList()
    } else {
      flushList()
      out.push(
        <p
          key={idx}
          className="my-1 leading-relaxed"
          dangerouslySetInnerHTML={{ __html: inlineMd(trimmed) }}
        />
      )
    }
  })
  flushList()
  return out
}

function inlineMd(s: string): string {
  // 转义 HTML
  let out = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  // 加粗 **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // 行内代码 `code`
  out = out.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 bg-white/10 rounded text-xs">$1</code>')
  return out
}

export function MessageBubble({ message, streaming }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
          isUser ? 'bg-blue-600' : 'bg-purple-600'
        }`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-blue-600/20 text-white' : 'bg-white/5 text-gray-200'
        }`}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <div className="break-words">
            {message.content
              ? renderMarkdown(message.content)
              : streaming
                ? <span className="inline-block animate-pulse">▍</span>
                : null}
            {streaming && message.content && (
              <span className="inline-block animate-pulse ml-0.5">▍</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}