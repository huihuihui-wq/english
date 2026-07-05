// types/subtitle.ts
export interface SubtitleCue {
  id: number;
  startTime: number;
  endTime: number;
  duration: number;
  primaryText: string;
  secondaryText: string;
  translations: Record<string, string>;
  isPlaceholder?: boolean;
}

export function getCueTranslation(cue: SubtitleCue, targetLang: string): string {
  return cue.translations?.[targetLang] || cue.secondaryText || '';
}

export type SubtitleDisplayMode = 'bilingual' | 'primary' | 'secondary' | 'none';

export interface SubtitleSettings {
  fontFamily: string;
  fontSize: number;
  fontColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  position: 'bottom' | 'top' | 'middle';
  lineHeight: number;
  letterSpacing: number;
  displayMode: SubtitleDisplayMode;
  autoScroll: boolean;
  highlightColor: string;
  translateTargetLang: string;
  subtitleOffset: number; // 毫秒，范围 -2000 ~ 2000
}
