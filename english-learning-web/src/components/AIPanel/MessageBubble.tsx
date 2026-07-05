// components/AIPanel/MessageBubble.tsx - 单条消息气泡(支持 markdown)
import { Bot, User, Volume2 } from 'lucide-react'
import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { ChatMessage } from '../../types/ai'

interface MessageBubbleProps {
  message: ChatMessage
  streaming?: boolean
  autoPlay?: boolean
}

function playBase64Mp3(base64: string): HTMLAudioElement {
  const audio = new Audio(`data:audio/mpeg;base64,${base64}`)
  void audio.play()
  return audio
}

const markdownComponents = {
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="font-semibold text-sm mt-2 mb-1 text-subtitle-highlight">{children}</h3>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="font-semibold text-base mt-2 mb-1">{children}</h2>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-1 leading-relaxed">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc list-inside space-y-0.5 my-1">{children}</ul>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isInline = !className;
    return isInline ? (
      <code className="px-1 py-0.5 bg-white/10 rounded text-xs">{children}</code>
    ) : (
      <pre className="bg-white/10 rounded p-2 my-2 overflow-x-auto">
        <code className={`${className} text-xs`}>{children}</code>
      </pre>
    );
  },
}

export function MessageBubble({ message, streaming, autoPlay }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const [isPlaying, setIsPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const autoPlayedRef = useRef(false)

  const handlePlay = () => {
    if (!message.audio || isPlaying) return
    if (audioRef.current) {
      audioRef.current.pause()
    }
    const audio = playBase64Mp3(message.audio)
    audioRef.current = audio
    setIsPlaying(true)
    audio.onended = () => {
      setIsPlaying(false)
      audioRef.current = null
    }
    audio.onerror = () => {
      setIsPlaying(false)
      audioRef.current = null
    }
  }

  // 自动播放一次（如果上层允许且消息非空）
  if (autoPlay && message.audio && !isUser && !streaming && message.content && !autoPlayedRef.current) {
    autoPlayedRef.current = true
    handlePlay()
  }

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
              ? (
                <div className="prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown components={markdownComponents}>{message.content}</ReactMarkdown>
                </div>
              )
              : streaming
                ? <span className="inline-block animate-pulse">▍</span>
                : null}
            {streaming && message.content && (
              <span className="inline-block animate-pulse ml-0.5">▍</span>
            )}
            {!streaming && message.audio && (
              <button
                onClick={handlePlay}
                disabled={isPlaying}
                className="mt-2 flex items-center gap-1 text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors disabled:opacity-50"
                title="播放 AI 语音"
              >
                <Volume2 size={12} />
                {isPlaying ? '播放中...' : '播放语音'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}