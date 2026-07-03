import { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, Link, History, FileText, X, Loader2, Film, Headphones, AlertCircle, Clock, BookOpen } from 'lucide-react';
import {
  transcribeFile,
  generateSubtitles,
  loadSubtitleFile,
  listHistory,
  getHistory,
  createOrUpdateHistory,
  convertSubtitles,
  testASR,
  type TranscribeResponse,
  type HistoryItem,
} from '../../api/content';
import type { VideoInfo } from '../../types/player';
import type { SubtitleCue } from '../../types/subtitle';

interface VideoSource {
  video: VideoInfo;
  subtitles: SubtitleCue[];
  historyId?: string;
  progressSeconds?: number;
}

interface WelcomeScreenProps {
  onLoad: (source: VideoSource) => void;
}

type Tab = 'upload' | 'link' | 'history';

export function WelcomeScreen({ onLoad }: WelcomeScreenProps) {
  const [activeTab, setActiveTab] = useState<Tab>('upload');
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [asrReady, setAsrReady] = useState<boolean | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const subInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingSub, setPendingSub] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [language, setLanguage] = useState('en');

  // 检测 ASR 状态
  useEffect(() => {
    testASR()
      .then(() => setAsrReady(true))
      .catch(() => setAsrReady(false));
  }, []);

  // 加载历史记录
  useEffect(() => {
    if (activeTab === 'history') {
      loadHistory();
    }
  }, [activeTab]);

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const items = await listHistory();
      setHistoryItems(items);
    } catch (e) {
      console.error('Failed to load history:', e);
    } finally {
      setHistoryLoading(false);
    }
  };

  // 拖拽处理
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  }, []);

  const handleFiles = (files: File[]) => {
    const videoFile = files.find(f => f.type.startsWith('video/') || f.type.startsWith('audio/'));
    const subFile = files.find(f => f.name.endsWith('.srt') || f.name.endsWith('.vtt'));
    if (videoFile) setPendingFile(videoFile);
    if (subFile) setPendingSub(subFile);
  };

  const handleUpload = async () => {
    if (!pendingFile) return;
    setLoading(true);
    setError(null);
    setUploadProgress(0);

    try {
      let subtitles: SubtitleCue[] = [];

      // 如果用户上传了字幕文件，优先使用
      if (pendingSub) {
        setLoadingMsg('正在解析字幕文件...');
        subtitles = await loadSubtitleFile(pendingSub);
      } else {
        // 否则用后端 ASR 转录
        setLoadingMsg('正在转录音频（首次加载需要下载模型，请耐心等待）...');
        const result: TranscribeResponse = await transcribeFile(pendingFile, language, (p) => {
          setUploadProgress(p);
          if (p < 100) setLoadingMsg(`正在上传... ${p}%`);
          else setLoadingMsg('正在转录音频...');
        });
        subtitles = convertSubtitles(result.subtitles);
      }

      const videoUrl = URL.createObjectURL(pendingFile);

      const videoInfo: VideoInfo = {
        id: `local-${Date.now()}`,
        title: pendingFile.name,
        videoUrl,
        duration: subtitles.length > 0 ? subtitles[subtitles.length - 1].endTime : 0,
      };

      // 保存到历史记录
      const historyResult = await createOrUpdateHistory({
        type: 'local',
        title: pendingFile.name,
        source: pendingFile.name,
        size_bytes: pendingFile.size,
        duration: videoInfo.duration / 1000,
        subtitles: subtitles.map(s => ({
          start: s.startTime / 1000,
          end: s.endTime / 1000,
          en: s.primaryText,
          zh: s.secondaryText,
          source_lang: language,
          is_placeholder: s.isPlaceholder,
        })),
        raw_text: subtitles.map(s => s.primaryText).join(' '),
        source_lang: language,
      });

      setLoadingMsg('正在加载...');
      onLoad({
        video: videoInfo,
        subtitles,
        historyId: historyResult.id,
      });

    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLoadingMsg('');
      setUploadProgress(0);
    }
  };

  const handleLoadFromUrl = async () => {
    if (!videoUrl.trim()) return;
    setLoading(true);
    setError(null);
    setLoadingMsg('正在获取视频字幕...');

    try {
      const result = await generateSubtitles(videoUrl.trim(), language);
      const subtitles = convertSubtitles(result.subtitles);

      const videoInfo: VideoInfo = {
        id: `url-${Date.now()}`,
        title: result.source?.startsWith('youtube') ? 'YouTube Video' : videoUrl,
        videoUrl: videoUrl.trim(),
        duration: Math.round(result.duration * 1000),
      };

      // 保存到历史记录
      const historyResult = await createOrUpdateHistory({
        type: videoUrl.includes('youtube') || videoUrl.includes('youtu.be') ? 'youtube' : 'online_url',
        title: videoInfo.title,
        source: videoUrl,
        duration: result.duration,
        subtitles: result.subtitles,
        raw_text: result.raw_text || '',
        source_lang: result.source_lang || language,
      });

      onLoad({
        video: videoInfo,
        subtitles,
        historyId: historyResult.id,
      });

    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  };

  const handleLoadHistory = async (item: HistoryItem) => {
    setLoading(true);
    setError(null);
    setLoadingMsg('正在加载历史记录...');

    try {
      const record = await getHistory(item.id);
      const subtitles = convertSubtitles(record.subtitles || []);

      const videoInfo: VideoInfo = {
        id: record.id,
        title: record.title,
        videoUrl: record.source,
        duration: Math.round(record.duration * 1000),
      };

      onLoad({
        video: videoInfo,
        subtitles,
        historyId: record.id,
        progressSeconds: record.progress_seconds,
      });

    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  };

  return (
    <div className="min-h-screen bg-app-bg text-white flex flex-col items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="text-5xl mb-4">🎧</div>
          <h1 className="text-3xl font-bold mb-2">Shadow Reader</h1>
          <p className="text-gray-400">AI 驱动的英语口语影子跟读练习</p>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="mb-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-3">
            <AlertCircle className="text-red-400 shrink-0 mt-0.5" size={18} />
            <div>
              <p className="text-red-400 text-sm">{error}</p>
              <button
                onClick={() => setError(null)}
                className="text-red-400/60 text-xs hover:text-red-400 mt-1"
              >
                清除
              </button>
            </div>
          </div>
        )}

        {/* 加载状态 */}
        {loading && (
          <div className="mb-6 p-6 bg-white/5 rounded-lg border border-white/10 text-center">
            <Loader2 className="animate-spin mx-auto mb-3 text-subtitle-highlight" size={32} />
            <p className="text-gray-300">{loadingMsg}</p>
            {uploadProgress > 0 && uploadProgress < 100 && (
              <div className="mt-3 w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-subtitle-highlight transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* 标签栏 */}
        {!loading && (
          <>
            <div className="flex gap-1 mb-6 bg-white/5 rounded-lg p-1">
              {[
                { key: 'upload' as Tab, label: '上传文件', icon: Upload },
                { key: 'link' as Tab, label: '视频链接', icon: Link },
                { key: 'history' as Tab, label: '历史记录', icon: History },
              ].map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-md text-sm transition-all ${
                    activeTab === key
                      ? 'bg-white/10 text-white font-medium'
                      : 'text-gray-400 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>

            {/* 内容区域 */}
            <div className="bg-white/5 rounded-xl border border-white/10 p-6">
              {activeTab === 'upload' && (
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold">上传本地文件</h2>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-400">语言</label>
                      <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white"
                      >
                        <option value="en">English</option>
                        <option value="zh">中文</option>
                        <option value="ja">日本語</option>
                        <option value="ko">한국어</option>
                        <option value="es">Español</option>
                        <option value="fr">Français</option>
                        <option value="de">Deutsch</option>
                      </select>
                    </div>
                  </div>

                  {/* ASR 状态 */}
                  {asrReady === false && (
                    <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-xs text-yellow-400">
                      ⚠️ 本地 ASR 模型尚未就绪。首次使用需要下载模型文件，请稍后再试，或上传已有字幕文件。
                    </div>
                  )}

                  {/* 拖拽区域 */}
                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-lg p-8 text-center transition-all cursor-pointer ${
                      isDragging
                        ? 'border-subtitle-highlight bg-subtitle-highlight/5'
                        : 'border-gray-600 hover:border-gray-500'
                    }`}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="audio/*,video/*"
                      className="hidden"
                      onChange={(e) => e.target.files && handleFiles(Array.from(e.target.files))}
                    />
                    <div className="text-3xl mb-3">
                      {isDragging ? '📁' : pendingFile ? '✅' : '📂'}
                    </div>
                    <p className="text-gray-300 text-sm mb-1">
                      {pendingFile
                        ? `已选择: ${pendingFile.name}`
                        : '拖拽音频/视频文件到这里，或点击选择'}
                    </p>
                    <p className="text-gray-500 text-xs">
                      支持 MP3, WAV, MP4, M4A, MKV 等格式，大文件处理需要一些时间
                    </p>
                  </div>

                  {/* 字幕文件选择 */}
                  <div className="mt-4">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => subInputRef.current?.click()}
                        className="flex items-center gap-2 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-300 hover:bg-white/10 transition-colors"
                      >
                        <FileText size={14} />
                        {pendingSub ? `字幕: ${pendingSub.name}` : '可选：上传字幕文件 (SRT/VTT)'}
                      </button>
                      {pendingSub && (
                        <button
                          onClick={() => setPendingSub(null)}
                          className="text-gray-500 hover:text-gray-300"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                    <input
                      ref={subInputRef}
                      type="file"
                      accept=".srt,.vtt"
                      className="hidden"
                      onChange={(e) => e.target.files && setPendingSub(e.target.files[0])}
                    />
                  </div>

                  {/* 开始按钮 */}
                  {pendingFile && (
                    <button
                      onClick={handleUpload}
                      disabled={loading}
                      className="mt-6 w-full py-3 bg-subtitle-highlight text-black font-semibold rounded-lg hover:bg-subtitle-highlight/90 transition-colors disabled:opacity-50"
                    >
                      {pendingSub ? '使用已有字幕开始学习' : '开始转录并学习'}
                    </button>
                  )}
                </div>
              )}

              {activeTab === 'link' && (
                <div>
                  <h2 className="text-lg font-semibold mb-4">输入视频链接</h2>
                  <div className="mb-4">
                    <label className="text-xs text-gray-400 mb-1.5 block">语言</label>
                    <select
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white mb-4"
                    >
                      <option value="en">English</option>
                      <option value="zh">中文</option>
                      <option value="ja">日本語</option>
                      <option value="ko">한국어</option>
                      <option value="es">Español</option>
                      <option value="fr">Français</option>
                      <option value="de">Deutsch</option>
                    </select>
                  </div>
                  <input
                    type="url"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=... 或直接视频链接"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-subtitle-highlight/50 mb-4"
                  />
                  <div className="flex gap-2 mb-4">
                    <button
                      onClick={() => setVideoUrl('https://www.youtube.com/watch?v=vP4iY1TtS3s')}
                      className="text-xs text-gray-500 hover:text-gray-300 underline"
                    >
                      YouTube 示例
                    </button>
                    <button
                      onClick={() => setVideoUrl('https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4')}
                      className="text-xs text-gray-500 hover:text-gray-300 underline"
                    >
                      MP4 示例
                    </button>
                  </div>
                  <button
                    onClick={handleLoadFromUrl}
                    disabled={!videoUrl.trim() || loading}
                    className="w-full py-3 bg-subtitle-highlight text-black font-semibold rounded-lg hover:bg-subtitle-highlight/90 transition-colors disabled:opacity-50"
                  >
                    加载视频
                  </button>
                </div>
              )}

              {activeTab === 'history' && (
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold">历史记录</h2>
                    <button
                      onClick={loadHistory}
                      disabled={historyLoading}
                      className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
                    >
                      <History size={12} />
                      {historyLoading ? '加载中...' : '刷新'}
                    </button>
                  </div>

                  {historyItems.length === 0 ? (
                    <div className="text-center py-12 text-gray-500">
                      <BookOpen size={40} className="mx-auto mb-3 opacity-50" />
                      <p>暂无历史记录</p>
                      <p className="text-xs mt-1">上传文件或输入视频链接后会自动保存</p>
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                      {historyItems.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => handleLoadHistory(item)}
                          className="w-full text-left p-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors group"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                {item.type === 'youtube' ? (
                                  <Film size={14} className="text-red-400 shrink-0" />
                                ) : item.type === 'online_url' ? (
                                  <Link size={14} className="text-blue-400 shrink-0" />
                                ) : (
                                  <Headphones size={14} className="text-green-400 shrink-0" />
                                )}
                                <span className="font-medium text-sm truncate">{item.title}</span>
                              </div>
                              <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                                <span className="flex items-center gap-1">
                                  <Clock size={10} />
                                  {formatDuration(item.duration)}
                                </span>
                                {item.subtitle_count !== undefined && (
                                  <span>{item.subtitle_count} 句字幕</span>
                                )}
                                {item.progress_seconds && item.progress_seconds > 1 && (
                                  <span className="text-subtitle-highlight">
                                    已学 {formatDuration(item.progress_seconds)}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="text-xs text-gray-600 shrink-0">
                              {item.last_opened?.slice(0, 10)}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}
