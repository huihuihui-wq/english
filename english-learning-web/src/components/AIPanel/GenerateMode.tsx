// components/AIPanel/GenerateMode.tsx - 生成雅思口语题
import { useState, useCallback } from 'react'
import { Sparkles, ArrowRight, Loader2, RefreshCw } from 'lucide-react'
import { generateExamQuestions, getAIHealth } from '../../api/ai'
import { useAIStore } from '../../stores/aiStore'
import { useSubtitleStore } from '../../stores/subtitleStore'

export function GenerateMode() {
  const [count, setCount] = useState(3)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<string[]>([])
  const [configured, setConfigured] = useState(true)
  const [isChecking, setIsChecking] = useState(true)

  const cues = useSubtitleStore((s) => s.cues)
  const setMode = useAIStore((s) => s.setMode)
  const setQuestions = useAIStore((s) => s.setExamQuestions)

  useState(() => {
    getAIHealth()
      .then((h) => setConfigured(h.configured))
      .catch(() => setConfigured(false))
      .finally(() => setIsChecking(false))
  })

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    setResult([])
    try {
      const res = await generateExamQuestions(cues.slice(0, 30), count)
      setResult(res.questions)
    } catch (e: unknown) {
      alert(`生成失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGenerating(false)
    }
  }, [cues, count])

  const handleUseQuestions = useCallback(() => {
    if (result.length === 0) return
    const qs = result.map((q, i) => ({
      index: i,
      text: q,
    }))
    setQuestions(qs)
    setMode('exam')
  }, [result, setQuestions, setMode])

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
        ⚠️ DashScope API Key 未配置，无法生成题目
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full p-3">
      <div className="text-center mb-4">
        <Sparkles size={28} className="text-subtitle-highlight mx-auto mb-2" />
        <h3 className="text-base font-semibold">基于字幕生成 IELTS 口语题</h3>
        <p className="text-xs text-gray-400 mt-1">AI 会从视频内容中提取主题，生成 Part 1-3 渐进式问题</p>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <label className="text-sm text-gray-400">生成数量:</label>
        <select
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          className="bg-white/5 border border-white/10 rounded px-2 py-1 text-sm text-white"
        >
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
            <option key={n} value={n}>{n} 道</option>
          ))}
        </select>
        <button
          onClick={handleGenerate}
          disabled={generating || cues.length === 0}
          className="ml-auto flex items-center gap-1 px-4 py-1.5 rounded-lg bg-subtitle-highlight/20 text-subtitle-highlight hover:bg-subtitle-highlight/30 transition-colors disabled:opacity-50 text-sm"
        >
          {generating ? (
            <><Loader2 className="animate-spin" size={14} /> 生成中...</>
          ) : (
            <><RefreshCw size={14} /> 生成题目</>
          )}
        </button>
      </div>

      {cues.length === 0 && (
        <div className="text-center text-gray-500 text-sm">
          ⚠️ 当前没有字幕数据，请先加载视频
        </div>
      )}

      {result.length > 0 && (
        <>
          <div className="flex-1 overflow-y-auto space-y-2">
            {result.map((q, i) => (
              <div
                key={i}
                className="bg-white/5 rounded-lg p-3 text-sm hover:bg-white/10 transition-colors cursor-pointer"
                onClick={() => {
                  const qs = result.map((text, idx) => ({ index: idx, text }))
                  setQuestions(qs)
                  setMode('exam')
                }}
              >
                <div className="flex items-start gap-2">
                  <span className="shrink-0 w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-xs">
                    {i + 1}
                  </span>
                  <span className="flex-1">{q}</span>
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={handleUseQuestions}
            className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-subtitle-highlight/20 text-subtitle-highlight hover:bg-subtitle-highlight/30 transition-colors text-sm"
          >
            使用这些题目开始考试 <ArrowRight size={14} />
          </button>
        </>
      )}
    </div>
  )
}