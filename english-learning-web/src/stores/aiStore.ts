// stores/aiStore.ts - AI 助手全局状态 (Zustand) + localStorage 持久化
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AIMode, ChatMessage, ExamQuestion } from '../types/ai'

interface AIStore {
  mode: AIMode
  setMode: (m: AIMode) => void

  // 全局 AI 设置
  autoPlayAI: boolean
  toggleAutoPlayAI: () => void

  // Chat 模式
  chatMessages: ChatMessage[]
  appendChatMessage: (m: ChatMessage) => void
  updateLastAssistant: (text: string, audio?: string) => void
  clearChat: () => void

  // Exam 模式
  examQuestions: ExamQuestion[]
  examCurrentIndex: number
  examFinished: boolean
  setExamQuestions: (qs: ExamQuestion[]) => void
  setExamAnswer: (index: number, answer: string, feedback: string, band: number | null, audio?: string) => void
  advanceExam: () => void
  resetExam: () => void

  // Explain 模式
  lastExplainText: string
  lastExplainResult: string
  lastExplainAudio?: string
  setExplainText: (t: string) => void
  setExplainResult: (r: string, audio?: string) => void
}

export const useAIStore = create<AIStore>()(
  persist(
    (set) => ({
      mode: 'chat',
      setMode: (m) => set({ mode: m }),

      autoPlayAI: false,
      toggleAutoPlayAI: () => set((s) => ({ autoPlayAI: !s.autoPlayAI })),

      chatMessages: [],
      appendChatMessage: (m) => set((s) => ({ chatMessages: [...s.chatMessages, m] })),
      updateLastAssistant: (text, audio) =>
        set((s) => {
          const msgs = [...s.chatMessages]
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') {
              msgs[i] = { ...msgs[i], content: text, audio }
              break
            }
          }
          return { chatMessages: msgs }
        }),
      clearChat: () => set({ chatMessages: [] }),

      examQuestions: [],
      examCurrentIndex: 0,
      examFinished: false,
      setExamQuestions: (qs) =>
        set({ examQuestions: qs, examCurrentIndex: 0, examFinished: qs.length === 0 }),
      setExamAnswer: (index, answer, feedback, band, audio) =>
        set((s) => {
          const questions = s.examQuestions.map((q) =>
            q.index === index ? { ...q, answer, feedback, band, audio } : q
          )
          return { examQuestions: questions }
        }),
      advanceExam: () =>
        set((s) => {
          const next = s.examCurrentIndex + 1
          return {
            examCurrentIndex: next,
            examFinished: next >= s.examQuestions.length,
          }
        }),
      resetExam: () =>
        set({ examQuestions: [], examCurrentIndex: 0, examFinished: false }),

      lastExplainText: '',
      lastExplainResult: '',
      lastExplainAudio: undefined,
      setExplainText: (t) => set({ lastExplainText: t }),
      setExplainResult: (r, audio) => set({ lastExplainResult: r, lastExplainAudio: audio }),
    }),
    {
      name: 'ai-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        mode: s.mode,
        autoPlayAI: s.autoPlayAI,
        chatMessages: s.chatMessages,
        examQuestions: s.examQuestions,
        examCurrentIndex: s.examCurrentIndex,
        examFinished: s.examFinished,
        lastExplainText: s.lastExplainText,
        lastExplainResult: s.lastExplainResult,
        lastExplainAudio: s.lastExplainAudio,
      }),
    }
  )
)

export const newMessage = (role: 'user' | 'assistant', content: string): ChatMessage => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  role,
  content,
  createdAt: Date.now(),
})