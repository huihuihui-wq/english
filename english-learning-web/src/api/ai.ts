// api/ai.ts - 与 FastAPI /api/ai/* 通信 (含 SSE 流式)

import type {
  AIHealth,
  ChatMessage,
  ChatRequest,
  ExamChatRequest,
  ExplainRequest,
} from '../types/ai'

const API_BASE = '/api/ai'

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try {
      const j = await resp.json()
      if (j?.detail) msg = j.detail
    } catch {
      // ignore
    }
    throw new Error(msg)
  }
  return resp.json() as Promise<T>
}

export async function getAIHealth(): Promise<AIHealth> {
  const resp = await fetch(`${API_BASE}/health`)
  return resp.json() as Promise<AIHealth>
}

export async function sendChat(req: ChatRequest): Promise<{ reply: string; model: string }> {
  const data = await postJSON<{ ok: boolean; reply: string; model: string }>('/chat', {
    message: req.message,
    context: req.context || '',
    history: (req.history || []).map(({ role, content }) => ({ role, content })),
  })
  return { reply: data.reply, model: data.model }
}

export async function sendExamChat(req: ExamChatRequest): Promise<{ reply: string; model: string }> {
  const data = await postJSON<{ ok: boolean; reply: string; model: string }>('/exam', {
    message: req.message,
    question: req.question,
    question_index: req.question_index,
    total_questions: req.total_questions,
    history: (req.history || []).map(({ role, content }) => ({ role, content })),
  })
  return { reply: data.reply, model: data.model }
}

export async function generateExamQuestions(
  subtitles: Array<Record<string, unknown> | object> = [],
  count = 3,
  rawText = ''
): Promise<{ questions: string[]; model: string }> {
  const data = await postJSON<{ ok: boolean; questions: string[]; model: string }>(
    '/exam/generate',
    { subtitles, count, raw_text: rawText }
  )
  return { questions: data.questions, model: data.model }
}

export async function sendExplain(req: ExplainRequest): Promise<{ explanation: string; model: string }> {
  const data = await postJSON<{ ok: boolean; explanation: string; model: string }>('/explain', {
    text: req.text,
    context: req.context || '',
  })
  return { explanation: data.explanation, model: data.model }
}

// ---------------------------------------------------------------------------
// 流式 (SSE) - 真正流式，通过 /api/ai/chat/stream 获取
// ---------------------------------------------------------------------------
export interface StreamEvent {
  type: 'delta' | 'done' | 'error'
  content: string
}

export async function* streamChat(
  req: ChatRequest,
  signal?: AbortSignal
): AsyncGenerator<StreamEvent, void, void> {
  const response = await fetch(`${API_BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: req.message,
      context: req.context || '',
      history: (req.history || []).map(({ role, content }) => ({ role, content })),
    }),
    signal,
  })

  if (!response.ok) {
    let msg = `HTTP ${response.status}`
    try {
      const j = await response.json()
      if (j?.detail) msg = j.detail
      if (j?.error) msg = j.error
    } catch {
      // ignore
    }
    yield { type: 'error', content: msg }
    return
  }

  const reader = response.body?.getReader()
  if (!reader) {
    yield { type: 'error', content: 'No response body' }
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') return

        try {
          const event = JSON.parse(data) as StreamEvent
          yield event
          if (event.type === 'error') return
        } catch {
          // 忽略解析失败的行
        }
      }
    }

    // 处理剩余的 buffer
    if (buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6)
      try {
        const event = JSON.parse(data) as StreamEvent
        yield event
      } catch {
        // 忽略
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export type { ChatMessage }