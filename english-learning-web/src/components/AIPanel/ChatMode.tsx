// components/AIPanel/ChatMode.tsx - 自由对话模式
import { useRef, useState, useEffect, useCallback } from 'react'
import { Send, Trash2, AlertCircle, Volume2, VolumeX } from 'lucide-react'
import { streamChat, getAIHealth } from '../../api/ai'
import { useAIStore, newMessage } from '../../stores/aiStore'
import { useSubtitleStore } from '../../stores/subtitleStore'
import { MessageBubble } from './MessageBubble'

export function ChatMode() {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [configured, setConfigured] = useState(true)
  const [isChecking, setIsChecking] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const messages = useAIStore((s) => s.chatMessages)
  const append = useAIStore((s) => s.appendChatMessage)
  const updateLast = useAIStore((s) => s.updateLastAssistant)
  const clear = useAIStore((s) => s.clearChat)
  const autoPlayAI = useAIStore((s) => s.autoPlayAI)
  const toggleAutoPlayAI = useAIStore((s) => s.toggleAutoPlayAI)

  const cues = useSubtitleStore((s) => s.cues)

  // 取最近 20 句字幕作为上下文
  const subtitleContext = cues.slice(0, 20).map((c) => c.primaryText).join('\n')

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    getAIHealth()
      .then((h) => setConfigured(h.configured))
      .catch(() => setConfigured(false))
      .finally(() => setIsChecking(false))
  }, [])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return

    const userMsg = newMessage('user', text)
    append(userMsg)
    setInput('')
    setLoading(true)

    // 先放一条空 assistant 占位
    const placeholder = newMessage('assistant', '')
    append(placeholder)

    const history = [...messages, userMsg].slice(-10).map((m) => ({
      role: m.role,
      content: m.content,
    }))

    try {
      let fullText = ''
      let audioBase64: string | undefined
      for await (const ev of streamChat({ message: text, context: subtitleContext, history })) {
        if (ev.type === 'delta' && ev.content) {
          fullText += ev.content
          updateLast(fullText)
        } else if (ev.type === 'audio' && ev.audio) {
          audioBase64 = ev.audio
          updateLast(fullText, audioBase64)
        } else if (ev.type === 'error' && ev.content) {
          updateLast(`❌ ${ev.content}`)
          break
        }
      }
    } catch (e: unknown) {
      updateLast(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [input, loading, messages, subtitleContext, append, updateLast])

  if (isChecking) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        检测后端配置中...
      </div>
    )
  }

  if (!configured) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="text-center text-sm text-yellow-400">
          <AlertCircle className="mx-auto mb-2" size={28} />
          <p>⚠️ DashScope API Key 未配置</p>
          <p className="text-gray-400 mt-1 text-xs">
            请在 shadow-reader 后端设置 DASHSCOPE_API_KEY，
            或直接在 browser console 配置 localStorage。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-xs text-gray-400">视频上下文: {cues.length} 句字幕</span>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleAutoPlayAI}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors ${
              autoPlayAI ? 'bg-subtitle-highlight/20 text-subtitle-highlight' : 'text-gray-500 hover:text-gray-300'
            }`}
            title={autoPlayAI ? '自动朗读已开启' : '自动朗读已关闭'}
          >
            {autoPlayAI ? <Volume2 size={12} /> : <VolumeX size={12} />}
            自动朗读
          </button>
          <button
            onClick={clear}
            className="flex items-center gap-1 text-gray-500 hover:text-red-400 transition-colors text-xs"
          >
            <Trash2 size={12} /> 清空
          </button>
        </div>
      </div>

      {/* 消息区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 ? (
          <div className="text-center text-gray-500 text-sm mt-8">
            <p>👋 我是你的英语口语教练</p>
            <p className="text-xs mt-2">可以问我关于视频内容的问题，或自由练习英语对话</p>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              streaming={loading && msg.role === 'assistant' && msg.id === messages[messages.length - 1].id && !msg.content}
              autoPlay={autoPlayAI}
            />
          ))
        )}
      </div>

      {/* 输入区 */}
      <div className="p-3 border-t border-white/10">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="输入消息... (Shift+Enter 换行)"
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-subtitle-highlight/50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="px-3 py-2 rounded-lg bg-subtitle-highlight/20 text-subtitle-highlight hover:bg-subtitle-highlight/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}