// utils/export.ts - 导出字幕和生词表
import type { SubtitleCue } from '../types/subtitle';

export interface VocabExportItem {
  word: string;
  phonetic?: string;
  pos?: string;
  meaning_native?: string;
  meaning_en?: string;
}

function msToSrtTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(ms % 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function msToVttTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(ms % 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function exportSubtitlesToSRT(cues: SubtitleCue[], filename = 'subtitles.srt'): void {
  const lines = cues
    .filter((c) => !c.isPlaceholder)
    .map((cue, idx) => {
      return `${idx + 1}\n${msToSrtTime(cue.startTime)} --> ${msToSrtTime(cue.endTime)}\n${cue.primaryText}\n`;
    });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, filename);
}

export function exportBilingualSubtitlesToSRT(
  cues: SubtitleCue[],
  targetLang: string = 'Chinese',
  filename = 'subtitles_bilingual.srt'
): void {
  const lines = cues
    .filter((c) => !c.isPlaceholder)
    .map((cue, idx) => {
      const translated = cue.translations?.[targetLang] || cue.secondaryText;
      const text = translated ? `${cue.primaryText}\n${translated}` : cue.primaryText;
      return `${idx + 1}\n${msToSrtTime(cue.startTime)} --> ${msToSrtTime(cue.endTime)}\n${text}\n`;
    });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, filename);
}

export function exportSubtitlesToVTT(cues: SubtitleCue[], filename = 'subtitles.vtt'): void {
  const lines = ['WEBVTT\n\n'];
  cues
    .filter((c) => !c.isPlaceholder)
    .forEach((cue) => {
      lines.push(`${msToVttTime(cue.startTime)} --> ${msToVttTime(cue.endTime)}`);
      lines.push(cue.primaryText);
      lines.push('');
    });
  const blob = new Blob([lines.join('\n')], { type: 'text/vtt;charset=utf-8' });
  triggerDownload(blob, filename);
}

export function exportVocabularyToCSV(items: VocabExportItem[], filename = 'vocabulary.csv'): void {
  const header = ['单词', '音标', '词性', '中文释义', '英文释义'];
  const rows = items.map((item) => [
    item.word,
    item.phonetic || '',
    item.pos || '',
    (item.meaning_native || '').replace(/\n/g, ' '),
    (item.meaning_en || '').replace(/\n/g, ' '),
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
