// types/ai.ts
export type AIMode = 'chat' | 'exam' | 'explain' | 'generate'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface ExamQuestion {
  index: number
  text: string
  answer?: string
  feedback?: string
  band?: number | null
}

export interface AIHealth {
  ok: boolean
  configured: boolean
  model: string
  base_url: string
}

export interface ChatRequest {
  message: string
  context?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface ExamChatRequest {
  message: string
  question: string
  question_index: number
  total_questions: number
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface ExplainRequest {
  text: string
  context?: string
}