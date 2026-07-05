// components/AIPanel/ExamMode.tsx - 雅思口语模拟
import { useRef, useState, useEffect, useCallback } from 'react'
import { Send, ArrowRight, RotateCcw, Trophy, AlertCircle, Volume2, VolumeX } from 'lucide-react'
import { sendExamChat, getAIHealth } from '../../api/ai'
import { useAIStore, newMessage } from '../../stores/aiStore'
import { useSubtitleStore } from '../../stores/subtitleStore'
import { generateExamQuestions } from '../../api/ai'
import { MessageBubble } from './MessageBubble'

export function ExamMode() {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [configured, setConfigured] = useState(true)
  const [isChecking, setIsChecking] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const questions = useAIStore((s) => s.examQuestions)
  const currentIndex = useAIStore((s) => s.examCurrentIndex)
  const finished = useAIStore((s) => s.examFinished)
  const setQuestions = useAIStore((s) => s.setExamQuestions)
  const setAnswer = useAIStore((s) => s.setExamAnswer)
  const advance = useAIStore((s) => s.advanceExam)
  const reset = useAIStore((s) => s.resetExam)
  const autoPlayAI = useAIStore((s) => s.autoPlayAI)
  const toggleAutoPlayAI = useAIStore((s) => s.toggleAutoPlayAI)

  const cues = useSubtitleStore((s) => s.cues)
  const currentCueId = useSubtitleStore((s) => s.currentCueId)
  const currentCue = cues.find((c) => c.id === currentCueId)

  useEffect(() => {
    getAIHealth()
      .then((h) => setConfigured(h.configured))
      .catch(() => setConfigured(false))
      .finally(() => setIsChecking(false))
  }, [])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [questions, currentIndex])

  const handleStart = useCallback(async () => {
    setGenerating(true)
    try {
      const res = await generateExamQuestions(cues.slice(0, 30), 5)
      const qs = res.questions.map((q, i) => ({
        index: i,
        text: q,
      }))
      setQuestions(qs)
    } catch (e: unknown) {
      alert(`生成题目失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGenerating(false)
    }
  }, [cues, setQuestions])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    const q = questions[currentIndex]
    if (!text || loading || !q) return

    const msgs = [...questions.slice(0, currentIndex + 1).map((_, i) => ({
      role: questions[i].answer ? 'user' as const : 'assistant' as const,
      content: questions[i].answer || questions[i].text,
    })), { role: 'user' as const, content: text }]

    setInput('')
    setLoading(true)

    try {
      const result = await sendExamChat({
        message: text,
        question: q.text,
        question_index: currentIndex,
        total_questions: questions.length,
        history: msgs.map((m) => newMessage(m.role, m.content)),
      })

      // 解析 Band 评分
      const bandMatch = result.reply.match(/Band\s*(\d(?:\.\d)?)/i)
      const band = bandMatch ? parseFloat(bandMatch[1]) : null

      setAnswer(currentIndex, text, result.reply, band, result.audio)
      advance()
    } catch (e: unknown) {
      alert(`提交失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [input, loading, questions, currentIndex, setAnswer, advance])

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
        </div>
      </div>
    )
  }

  // 未开始
  if (questions.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Trophy size={36} className="text-subtitle-highlight mb-3" />
        <h3 className="text-base font-semibold mb-1">雅思口语模拟考</h3>
        <p className="text-sm text-gray-400 mb-4">根据当前视频字幕生成 5 道 IELTS 口语题，逐题作答后获得 AI 评分</p>
        <button
          onClick={handleStart}
          disabled={generating}
          className="px-5 py-2 rounded-lg bg-subtitle-highlight/20 text-subtitle-highlight hover:bg-subtitle-highlight/30 transition-colors disabled:opacity-50"
        >
          {generating ? '生成中...' : '开始模拟考'}
        </button>
      </div>
    )
  }

  // 已完成
  if (finished) {
    const totalBand = questions.reduce((sum, q) => sum + (q.band || 0), 0)
    const avgBand = totalBand / questions.length
    return (
      <div className="flex-1 flex flex-col p-4">
        <div className="text-center mb-4">
          <Trophy size={32} className="text-yellow-400 mx-auto mb-2" />
          <h3 className="text-lg font-semibold">模拟考完成! 🎉</h3>
          <p className="text-subtitle-highlight text-xl font-bold mt-1">
            综合评分: Band {avgBand.toFixed(1)}
          </p>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3">
          {questions.map((q) => (
            <div key={q.index} className="bg-white/5 rounded-lg p-3 text-sm">
              <div className="font-semibold mb-1">Q{q.index + 1}. {q.text}</div>
              <div className="text-gray-400 mb-2">你的回答: {q.answer}</div>
              <div className="bg-white/5 rounded p-2">
                <div className="font-semibold text-subtitle-highlight">Band {q.band?.toFixed(1) || '--'}</div>
                <div className="whitespace-pre-wrap mt-1">{q.feedback}</div>
              </div>
            </div>
          ))}
        </div>
        <button
          onClick={reset}
          className="mt-3 px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
        >
          <RotateCcw size={14} /> 重新开始
        </button>
      </div>
    )
  }

  // 答题中
  const currentQ = questions[currentIndex]
  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-white/10">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-400">
            第 {currentIndex + 1} / {questions.length} 题
          </span>
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
        <div className="w-20 h-1.5 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-subtitle-highlight transition-all"
            style={{ width: `${((currentIndex) / questions.length) * 100}%` }}
          />
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="bg-white/5 rounded-lg p-3">
          <div className="text-sm font-semibold mb-1">Q{currentIndex + 1}. {currentQ.text}</div>
          {currentCue && (
            <div className="text-xs text-gray-500 mt-1">
              📹 当前视频上下文: {currentCue.primaryText.slice(0, 60)}...
            </div>
          )}
        </div>

        {currentQ.answer && (
          <>
            <MessageBubble message={newMessage('user', currentQ.answer)} />
            <MessageBubble
              message={{ ...newMessage('assistant', currentQ.feedback || ''), audio: currentQ.audio }}
              autoPlay={autoPlayAI}
            />
          </>
        )}
      </div>

      <div className="p-3 border-t border-white/10">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="输入你的英语回答..."
            rows={2}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-subtitle-highlight/50 resize-none"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="px-3 py-2 rounded-lg bg-subtitle-highlight/20 text-subtitle-highlight hover:bg-subtitle-highlight/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
          >
            {currentIndex < questions.length - 1 ? (
              <>下一题 <ArrowRight size={14} /></>
            ) : (
              <>提交 <Send size={14} /></>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}