// utils/timeFormat.ts
export function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function parseTimeToMs(timeStr: string): number {
  // 支持格式: 00:00:00,000 或 00:00.000
  const cleaned = timeStr.trim().replace('.', ',');
  const parts = cleaned.split(':');
  
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let milliseconds = 0;
  
  if (parts.length === 3) {
    hours = parseInt(parts[0], 10);
    minutes = parseInt(parts[1], 10);
    const secParts = parts[2].split(',');
    seconds = parseInt(secParts[0], 10);
    milliseconds = parseInt(secParts[1] || '0', 10);
  } else if (parts.length === 2) {
    minutes = parseInt(parts[0], 10);
    const secParts = parts[1].split(',');
    seconds = parseInt(secParts[0], 10);
    milliseconds = parseInt(secParts[1] || '0', 10);
  }
  
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + milliseconds;
}
