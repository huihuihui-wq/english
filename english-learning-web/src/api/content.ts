// api/content.ts - 与 FastAPI 后端内容加载相关 API 通信

import { parseSRT } from '../utils/subtitleParser';
import type { SubtitleCue } from '../types/subtitle';

const API_BASE = '/api';

export interface TranscribeResponse {
  duration: number;
  subtitles: Array<{
    start: number;
    end: number;
    en: string;
    zh?: string;
    source_lang?: string;
    is_placeholder?: boolean;
  }>;
  raw_text: string;
  aligned?: boolean;
  alignment_source?: string;
  alignment_reason?: string;
}

export interface GenerateSubtitlesResponse {
  subtitles: Array<{
    start: number;
    end: number;
    en: string;
    zh?: string;
    source_lang?: string;
    is_placeholder?: boolean;
  }>;
  duration: number;
  raw_text?: string;
  source?: string;
  is_auto_generated?: boolean;
  source_lang?: string;
  aligned?: boolean;
  alignment_source?: string;
  alignment_reason?: string;
  fallback_reason?: string;
}

export interface HistoryItem {
  id: string;
  type: string;
  title: string;
  source: string;
  size_bytes?: number;
  duration: number;
  has_subtitles?: boolean;
  subtitle_count?: number;
  progress_seconds?: number;
  source_lang?: string;
  created_at?: string;
  last_opened?: string;
  open_count?: number;
}

export interface HistoryRecord {
  id: string;
  type: string;
  title: string;
  source: string;
  duration: number;
  subtitles: Array<{
    start: number;
    end: number;
    en: string;
    zh?: string;
    source_lang?: string;
    is_placeholder?: boolean;
  }>;
  raw_text?: string;
  progress_seconds?: number;
  source_lang?: string;
}

// 转录本地音视频文件
export async function transcribeFile(
  file: File,
  language: string = 'en',
  onProgress?: (percent: number) => void
): Promise<TranscribeResponse> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('language', language);

  const xhr = new XMLHttpRequest();
  
  return new Promise((resolve, reject) => {
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data);
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      } else {
        let msg = `HTTP ${xhr.status}`;
        try {
          const j = JSON.parse(xhr.responseText);
          if (j?.detail) msg = j.detail;
          if (j?.error) msg = j.error;
        } catch {
          // ignore
        }
        reject(new Error(msg));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

    xhr.open('POST', `${API_BASE}/transcribe`);
    xhr.send(formData);
  });
}

// 生成在线视频字幕（YouTube / 直接链接）
export async function generateSubtitles(
  videoUrl: string,
  language: string = 'en'
): Promise<GenerateSubtitlesResponse> {
  const resp = await fetch(`${API_BASE}/generate-subtitles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: videoUrl, language }),
  });

  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.detail) msg = j.detail;
      if (j?.error) msg = j.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  return resp.json();
}

// 加载字幕文件（SRT/VTT）
export async function loadSubtitleFile(file: File): Promise<SubtitleCue[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const ext = file.name.toLowerCase();
        if (ext.endsWith('.vtt')) {
          // VTT 格式处理：先简单去掉 WEBVTT 头
          const cleaned = content.replace(/^WEBVTT[\s\S]*?\n\n/, '');
          resolve(parseSRT(cleaned));
        } else {
          resolve(parseSRT(content));
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Failed to parse subtitle file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read subtitle file'));
    reader.readAsText(file);
  });
}

// 历史记录 API
export async function listHistory(): Promise<HistoryItem[]> {
  const resp = await fetch(`${API_BASE}/history`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data.items || [];
}

export async function getHistory(historyId: string): Promise<HistoryRecord> {
  const resp = await fetch(`${API_BASE}/history/${encodeURIComponent(historyId)}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function createOrUpdateHistory(record: {
  type: 'local' | 'youtube' | 'online_url';
  title: string;
  source: string;
  size_bytes?: number;
  duration: number;
  subtitles?: Array<Record<string, unknown>>;
  raw_text?: string;
  progress_seconds?: number;
  source_lang?: string;
}): Promise<{ id: string; open_count: number }> {
  const resp = await fetch(`${API_BASE}/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function updateHistoryProgress(historyId: string, progressSeconds: number): Promise<void> {
  await fetch(`${API_BASE}/history/${encodeURIComponent(historyId)}/progress`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ progress_seconds: progressSeconds }),
  });
}

// 将后端字幕格式转换为前端 SubtitleCue 格式
export function convertSubtitles(items: Array<{
  start: number;
  end: number;
  en: string;
  zh?: string;
  source_lang?: string;
  is_placeholder?: boolean;
}>): SubtitleCue[] {
  return items.map((s, i) => ({
    id: i + 1,
    startTime: Math.round(s.start * 1000),
    endTime: Math.round(s.end * 1000),
    duration: Math.round((s.end - s.start) * 1000),
    primaryText: s.en || '',
    secondaryText: s.zh || '',
    isPlaceholder: !!s.is_placeholder,
  }));
}

// 测试后端 ASR 是否就绪
export async function testASR(): Promise<{ ok: boolean; asr: string }> {
  const resp = await fetch(`${API_BASE}/transcribe/test`);
  return resp.json();
}
