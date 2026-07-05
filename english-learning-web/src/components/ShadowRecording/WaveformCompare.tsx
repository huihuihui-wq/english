import { useEffect, useRef, useState } from 'react';

interface WaveformData {
  peaks: number[];
  duration: number;
}

interface WaveformCompareProps {
  originalAudioUrl?: string;
  userAudioBlob?: Blob;
  height?: number;
  barWidth?: number;
  gap?: number;
}

async function extractWaveform(audioUrl: string, barCount: number): Promise<WaveformData> {
  const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  try {
    const res = await fetch(audioUrl);
    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const channel = audioBuffer.getChannelData(0);
    const duration = audioBuffer.duration;

    const blockSize = Math.floor(channel.length / barCount);
    const peaks: number[] = [];
    for (let i = 0; i < barCount; i++) {
      const start = i * blockSize;
      const end = Math.min(start + blockSize, channel.length);
      let sum = 0;
      for (let j = start; j < end; j++) {
        sum += Math.abs(channel[j]);
      }
      peaks.push(sum / (end - start));
    }

    const maxPeak = Math.max(...peaks, 0.001);
    return {
      peaks: peaks.map((p) => p / maxPeak),
      duration,
    };
  } finally {
    await audioCtx.close();
  }
}

export function WaveformCompare({
  originalAudioUrl,
  userAudioBlob,
  height = 80,
  barWidth = 2,
  gap = 1,
}: WaveformCompareProps) {
  const [originalData, setOriginalData] = useState<WaveformData | null>(null);
  const [userData, setUserData] = useState<WaveformData | null>(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const load = async () => {
      const barCount = containerRef.current
        ? Math.floor(containerRef.current.clientWidth / (barWidth + gap))
        : 100;

      if (originalAudioUrl) {
        try {
          const data = await extractWaveform(originalAudioUrl, barCount);
          if (!cancelled) setOriginalData(data);
        } catch (err) {
          console.error('Failed to extract original waveform:', err);
        }
      }

      if (userAudioBlob) {
        try {
          const url = URL.createObjectURL(userAudioBlob);
          const data = await extractWaveform(url, barCount);
          URL.revokeObjectURL(url);
          if (!cancelled) setUserData(data);
        } catch (err) {
          console.error('Failed to extract user waveform:', err);
        }
      }

      if (!cancelled) setLoading(false);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [originalAudioUrl, userAudioBlob, barWidth, gap]);

  const renderBars = (data: WaveformData | null, color: string) => {
    if (!data) return null;
    return (
      <div className="flex items-end justify-between w-full" style={{ height }}>
        {data.peaks.map((peak, i) => (
          <div
            key={i}
            style={{
              width: barWidth,
              height: `${Math.max(4, peak * 100)}%`,
              backgroundColor: color,
              borderRadius: 1,
              marginRight: gap,
            }}
          />
        ))}
      </div>
    );
  };

  return (
    <div ref={containerRef} className="w-full space-y-2">
      {loading && (
        <p className="text-xs text-gray-400">正在生成波形...</p>
      )}
      {originalAudioUrl && (
        <div className="space-y-1">
          <p className="text-[10px] text-gray-400">原音 {originalData ? `${originalData.duration.toFixed(1)}s` : ''}</p>
          {renderBars(originalData, '#22d3ee')}
        </div>
      )}
      {userAudioBlob && (
        <div className="space-y-1">
          <p className="text-[10px] text-gray-400">你的录音 {userData ? `${userData.duration.toFixed(1)}s` : ''}</p>
          {renderBars(userData, '#f472b6')}
        </div>
      )}
    </div>
  );
}
