// utils/youtube.ts - YouTube URL 解析与视频 ID 提取

export function isYouTubeUrl(url: string): boolean {
  if (!url) return false;
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)/i.test(url);
}

export function extractYouTubeVideoId(url: string): string | null {
  if (!url) return null;

  // youtu.be/VIDEO_ID
  const shortMatch = url.match(/youtu\.be\/([^?&]+)/);
  if (shortMatch) return shortMatch[1];

  // youtube.com/watch?v=VIDEO_ID
  const watchMatch = url.match(/[?&]v=([^?&]+)/);
  if (watchMatch) return watchMatch[1];

  // youtube.com/embed/VIDEO_ID
  const embedMatch = url.match(/youtube\.com\/embed\/([^?&]+)/);
  if (embedMatch) return embedMatch[1];

  // youtube.com/live/VIDEO_ID
  const liveMatch = url.match(/youtube\.com\/live\/([^?&]+)/);
  if (liveMatch) return liveMatch[1];

  return null;
}
