// types/subtitle.ts
export interface SubtitleCue {
  id: number;
  startTime: number;
  endTime: number;
  duration: number;
  primaryText: string;
  secondaryText: string;
  isPlaceholder?: boolean;
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
}
