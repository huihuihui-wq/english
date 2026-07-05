// utils/subtitleParser.ts
import type { SubtitleCue } from '../types/subtitle';
import { parseTimeToMs } from './timeFormat';

export function parseSRT(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = content.trim().split(/\n\s*\n/);
  
  blocks.forEach((block, index) => {
    const lines = block.trim().split('\n');
    if (lines.length < 3) return;
    
    // 第一行可能是序号，也可能直接是时间
    let timeLineIndex = 0;
    if (lines[0].match(/^\d+$/)) {
      timeLineIndex = 1;
    }
    
    const timeLine = lines[timeLineIndex];
    const timeMatch = timeLine.match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/);
    if (!timeMatch) return;
    
    const startTime = parseTimeToMs(timeMatch[1]);
    const endTime = parseTimeToMs(timeMatch[2]);
    
    // 剩余行是文本，可能包含空行分隔中英文
    const textLines = lines.slice(timeLineIndex + 1);
    const text = textLines.join('\n').trim();
    
    // 尝试分离中英文（通过空行或特定分隔符）
    let primaryText = text;
    let secondaryText = '';
    
    const splitIndex = textLines.findIndex(line => line.trim() === '');
    if (splitIndex !== -1) {
      primaryText = textLines.slice(0, splitIndex).join(' ').trim();
      secondaryText = textLines.slice(splitIndex + 1).join(' ').trim();
    } else if (textLines.length >= 2) {
      // 如果没有空行，假设第一行是英文，其余是中文
      primaryText = textLines[0].trim();
      secondaryText = textLines.slice(1).join(' ').trim();
    }
    
    const isPlaceholder = !primaryText.trim() || /^\[(Music|Applause|Silence|Sound|NOISE|MUSIC|APPLAUSE|SILENCE)\]$/i.test(primaryText.trim());

    const translations: Record<string, string> = {};
    if (secondaryText) translations['Chinese'] = secondaryText;

    cues.push({
      id: index + 1,
      startTime,
      endTime,
      duration: endTime - startTime,
      primaryText,
      secondaryText,
      translations,
      isPlaceholder,
    });
  });
  
  return cues;
}

export function parseVTT(content: string): SubtitleCue[] {
  // VTT 格式与 SRT 类似，但有 WEBVTT 头部
  const cleaned = content.replace(/^WEBVTT[\s\S]*?\n\n/, '');
  return parseSRT(cleaned);
}

export function loadSubtitlesFromFile(file: File): Promise<SubtitleCue[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const ext = file.name.toLowerCase();
        if (ext.endsWith('.vtt')) {
          resolve(parseVTT(content));
        } else {
          resolve(parseSRT(content));
        }
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
