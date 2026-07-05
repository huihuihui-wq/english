// api/vocabulary.ts - 与 FastAPI /api/word/* 和 /api/vocabulary 通信

export interface WordLookupResult {
  word: string;
  lemma?: string;
  phonetic?: string;
  pos?: string;
  meaning_en?: string;
  meaning_native?: string;
  native_lang?: string;
  example?: {
    en?: string;
    native?: string;
  };
  roots?: {
    prefix?: string;
    root?: string;
    suffix?: string;
  };
  etymology_en?: string;
  etymology_native?: string;
  family?: string[];
  related?: string[];
}

export interface VocabularyEntry {
  word: string;
  lemma?: string;
  phonetic?: string;
  pos?: string;
  meaning_en?: string;
  meaning_native?: string;
  native_lang?: string;
  example?: {
    en?: string;
    native?: string;
  };
  // SRS fields
  proficiency?: number;
  review_count?: number;
  next_review_at?: string;
  last_reviewed_at?: string;
}

export interface VocabularyStats {
  total: number;
  due: number;
  mastered: number;
}

export interface ReviewQuestion {
  word: string;
  meaning_native?: string;
  meaning_en?: string;
  pos?: string;
  proficiency?: number;
  choices?: string[];
  answer: string;
}

export type ReviewMode = 'choice' | 'spelling' | 'listening';

const API_BASE = '/api';

async function getJSON<T>(path: string): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`);
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.detail) msg = j.detail;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return resp.json() as Promise<T>;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.detail) msg = j.detail;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return resp.json() as Promise<T>;
}

export async function lookupWord(word: string, lang = 'zh'): Promise<WordLookupResult> {
  return getJSON<WordLookupResult>(`/word/lookup?word=${encodeURIComponent(word)}&lang=${lang}`);
}

export async function checkWordSaved(word: string): Promise<{ saved: boolean }> {
  return getJSON<{ saved: boolean }>(`/vocabulary/check/${encodeURIComponent(word)}`);
}

export async function addToVocabulary(entry: VocabularyEntry): Promise<unknown> {
  return postJSON('/vocabulary', entry);
}

export async function removeFromVocabulary(word: string): Promise<unknown> {
  const resp = await fetch(`${API_BASE}/vocabulary/${encodeURIComponent(word)}`, {
    method: 'DELETE',
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json().catch(() => ({}));
}

export async function listVocabulary(): Promise<{ items: VocabularyEntry[]; stats: VocabularyStats }> {
  return getJSON<{ items: VocabularyEntry[]; stats: VocabularyStats }>('/vocabulary');
}

export async function listDueVocabulary(): Promise<{ items: VocabularyEntry[]; stats: VocabularyStats }> {
  return getJSON<{ items: VocabularyEntry[]; stats: VocabularyStats }>('/vocabulary/due');
}

export async function reviewVocabularyWord(word: string, correct: boolean): Promise<VocabularyEntry> {
  const resp = await postJSON<{ item: VocabularyEntry }>('/vocabulary/review', { word, correct });
  return resp.item;
}

export async function generateReviewSession(
  mode: ReviewMode,
  count = 10,
): Promise<{ mode: ReviewMode; questions: ReviewQuestion[]; stats: VocabularyStats }> {
  return postJSON<{ mode: ReviewMode; questions: ReviewQuestion[]; stats: VocabularyStats }>('/vocabulary/review-session', { mode, count });
}

export async function playWordTTS(word: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/word/tts?word=${encodeURIComponent(word)}`);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  await audio.play();
  audio.onended = () => URL.revokeObjectURL(url);
}
