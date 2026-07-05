// components/AIPanel/ExplainMode.tsx - 讲解当前字幕/单词
import { useState, useCallback, useEffect, useRef } from 'react'
import { BookOpen, Wand2, Loader2, Volume2, VolumeX } from 'lucide-react'
import { sendExplain, getAIHealth } from '../../api/ai'
import { useAIStore } from '../../stores/aiStore'
import { useSubtitleStore } from '../../stores/subtitleStore'

export function ExplainMode() {
  const [customText, setCustomText] = useState('')
  const [loading, setLoading] = useState(false)
  const [configured, setConfigured] = useState(true)
  const [isChecking, setIsChecking] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const autoPlayedRef = useRef(false)

  const lastExplainResult = useAIStore((s) => s.lastExplainResult)
  const lastExplainText = useAIStore((s) => s.lastExplainText)
  const lastExplainAudio = useAIStore((s) => s.lastExplainAudio)
  const setExplainResult = useAIStore((s) => s.setExplainResult)
  const setExplainText = useAIStore((s) => s.setExplainText)
  const autoPlayAI = useAIStore((s) => s.autoPlayAI)
  const toggleAutoPlayAI = useAIStore((s) => s.toggleAutoPlayAI)

  const cues = useSubtitleStore((s) => s.cues)
  const currentCueId = useSubtitleStore((s) => s.currentCueId)
  const currentCue = cues.find((c) => c.id === currentCueId)

  const playAudio = (base64: string) => {
    if (audioRef.current) {
      audioRef.current.pause()
    }
    const audio = new Audio(`data:audio/mpeg;base64,${base64}`)
    audioRef.current = audio
    setIsPlaying(true)
    audio.play().catch(() => setIsPlaying(false))
    audio.onended = () => {
      setIsPlaying(false)
      audioRef.current = null
    }
    audio.onerror = () => {
      setIsPlaying(false)
      audioRef.current = null
    }
  }

  useEffect(() => {
    getAIHealth()
      .then((h) => setConfigured(h.configured))
      .catch(() => setConfigured(false))
      .finally(() => setIsChecking(false))
  }, [])

  // 自动播放讲解音频
  useEffect(() => {
    if (
      autoPlayAI &&
      lastExplainAudio &&
      lastExplainResult &&
      !loading &&
      !autoPlayedRef.current
    ) {
      autoPlayedRef.current = true
      playAudio(lastExplainAudio)
    }
  }, [autoPlayAI, lastExplainAudio, lastExplainResult, loading])

  const handleExplain = useCallback(
    async (text: string, ctx?: string) => {
      if (loading) return
      setLoading(true)
      setExplainText(text)
      setExplainResult('')
      autoPlayedRef.current = false

      try {
        const res = await sendExplain({ text, context: ctx })
        setExplainResult(res.explanation, res.audio)
      } catch (e: unknown) {
        setExplainResult(`❌ 请求失败: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setLoading(false)
      }
    },
    [loading, setExplainText, setExplainResult]
  )

  // 自动讲解当前字幕
  const handleExplainCurrent = useCallback(() => {
    if (!currentCue) return
    const ctx = cues.slice(Math.max(0, currentCueId! - 2), currentCueId! + 3)
      .map((c) => c.primaryText).join('\n')
    handleExplain(currentCue.primaryText, ctx)
  }, [currentCue, cues, currentCueId, handleExplain])

  const handleExplainCustom = useCallback(() => {
    const t = customText.trim()
    if (!t) return
    handleExplain(t)
    setCustomText('')
  }, [customText, handleExplain])

  if (isChecking) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        检测后端配置中...
      </div>
    )
  }

  if (!configured) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 text-yellow-400 text-sm">
        ⚠️ DashScope API Key 未配置，无法使用讲解功能
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-white/10 space-y-2">
        {currentCue && (
          <button
            onClick={handleExplainCurrent}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-subtitle-highlight/10 text-subtitle-highlight hover:bg-subtitle-highlight/20 transition-colors disabled:opacity-50 text-sm"
          >
            <BookOpen size={14} />
            讲解当前句: "{currentCue.primaryText.slice(0, 40)}..."
          </button>
        )}

        <div className="flex gap-2">
          <input
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="或输入任意单词/句子..."
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-subtitle-highlight/50"
            onKeyDown={(e) => e.key === 'Enter' && handleExplainCustom()}
          />
          <button
            onClick={handleExplainCustom}
            disabled={!customText.trim() || loading}
            className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-30"
          >
            <Wand2 size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading && !lastExplainResult ? (
          <div className="flex items-center justify-center gap-2 text-gray-400 mt-8">
            <Loader2 className="animate-spin" size={18} />
            <span className="text-sm">AI 正在讲解... {lastExplainText.slice(0, 30)}...</span>
          </div>
        ) : lastExplainResult ? (
          <div className="text-sm leading-relaxed">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-gray-500">讲解对象: {lastExplainText}</div>
              <div className="flex items-center gap-2">
                {lastExplainAudio && (
                  <button
                    onClick={() => lastExplainAudio && playAudio(lastExplainAudio)}
                    disabled={isPlaying}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors disabled:opacity-50"
                  >
                    <Volume2 size={12} />
                    {isPlaying ? '播放中...' : '播放语音'}
                  </button>
                )}
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
              </div>
            </div>
            <div className="bg-white/5 rounded-lg p-3 whitespace-pre-wrap break-words">
              {lastExplainResult}
            </div>
          </div>
        ) : (
          <div className="text-center text-gray-500 text-sm mt-8">
            <p>📖 点击上方按钮讲解当前字幕</p>
            <p className="text-xs mt-2">AI 会分析词汇、语法、文化背景和同义替换</p>
          </div>
        )}
      </div>
    </div>
  )
}