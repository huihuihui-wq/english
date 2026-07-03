// components/VocabularyPanel/VocabularyPanel.tsx
import { useEffect, useState, useCallback } from 'react';
import { BookOpen, Volume2, Star, Loader2, X, Trash2, Search, ChevronLeft } from 'lucide-react';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useVocabularyLookup } from '../../hooks/useVocabularyLookup';
import { listVocabulary, removeFromVocabulary, playWordTTS, type VocabularyEntry } from '../../api/vocabulary';

export function VocabularyPanel() {
  const { selectedWord, setSelectedWord, setActivePanel } = useSubtitleStore();
  const { data, loading, error, saved, lookup, play, save, clear } = useVocabularyLookup();

  // 词汇列表状态
  const [viewMode, setViewMode] = useState<'detail' | 'list'>('list');
  const [vocabItems, setVocabItems] = useState<VocabularyEntry[]>([]);
  const [vocabStats, setVocabStats] = useState({ total: 0 });
  const [listLoading, setListLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [deletingWord, setDeletingWord] = useState<string | null>(null);

  // 加载词汇列表
  const loadVocabList = useCallback(async () => {
    setListLoading(true);
    try {
      const result = await listVocabulary();
      setVocabItems(result.items);
      setVocabStats(result.stats);
    } catch (e) {
      console.error('Failed to load vocabulary:', e);
    } finally {
      setListLoading(false);
    }
  }, []);

  // 初始加载和单词保存后刷新
  useEffect(() => {
    loadVocabList();
  }, [loadVocabList, saved]);

  // 查词
  useEffect(() => {
    if (selectedWord) {
      lookup(selectedWord);
      setViewMode('detail');
    } else {
      clear();
      setViewMode('list');
    }
  }, [selectedWord, lookup, clear]);

  const handleDelete = async (word: string) => {
    if (!confirm(`确定要从生词本中删除 "${word}" 吗？`)) return;
    setDeletingWord(word);
    try {
      await removeFromVocabulary(word);
      setVocabItems((prev) => prev.filter((w) => w.word !== word));
      setVocabStats((prev) => ({ ...prev, total: prev.total - 1 }));
      if (selectedWord === word) {
        setSelectedWord(null);
      }
    } catch (e) {
      console.error('Failed to delete word:', e);
    } finally {
      setDeletingWord(null);
    }
  };

  const filteredItems = searchQuery.trim()
    ? vocabItems.filter(
        (w) =>
          w.word.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (w.meaning_native || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          (w.pos || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    : vocabItems;

  // 发音播放
  const handlePlay = async (word: string) => {
    try {
      await playWordTTS(word);
    } catch (e) {
      console.error('TTS failed:', e);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          {viewMode === 'detail' && selectedWord && (
            <button
              onClick={() => {
                setSelectedWord(null);
                setViewMode('list');
              }}
              className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white"
            >
              <ChevronLeft size={16} />
            </button>
          )}
          <span className="text-sm font-semibold">
            {viewMode === 'detail' && selectedWord ? `📖 ${selectedWord}` : `📚 生词本 (${vocabStats.total})`}
          </span>
        </div>
        <button
          onClick={() => setActivePanel('subtitles')}
          className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white"
          title="返回字幕"
        >
          <X size={14} />
        </button>
      </div>

      {viewMode === 'list' ? (
        <>
          {/* 搜索栏 */}
          <div className="px-3 py-2 border-b border-white/10">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索单词、释义、词性..."
                className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-subtitle-highlight/50"
              />
            </div>
          </div>

          {/* 列表内容 */}
          <div className="flex-1 overflow-y-auto p-3">
            {listLoading ? (
              <div className="flex items-center justify-center h-full text-gray-400">
                <Loader2 size={24} className="animate-spin mr-2" />
                加载中...
              </div>
            ) : vocabItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500">
                <BookOpen size={40} className="mb-3" />
                <p className="text-center text-sm">生词本还是空的</p>
                <p className="text-center text-xs mt-1">点击字幕中的英文单词即可查询并加入生词本</p>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500">
                <Search size={32} className="mb-2" />
                <p className="text-sm">没有找到匹配的单词</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredItems.map((item) => (
                  <div
                    key={item.word}
                    className="group p-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
                    onClick={() => setSelectedWord(item.word)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white text-sm">{item.word}</span>
                          {item.phonetic && (
                            <span className="text-xs text-gray-500">{item.phonetic}</span>
                          )}
                          {item.pos && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-subtitle-highlight/20 text-subtitle-highlight">
                              {item.pos}
                            </span>
                          )}
                        </div>
                        {(item.meaning_native || item.meaning_en) && (
                          <p className="text-xs text-gray-400 mt-1 truncate">
                            {item.meaning_native || item.meaning_en}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePlay(item.word);
                          }}
                          className="p-1.5 rounded hover:bg-white/10 text-gray-400 hover:text-white"
                          title="发音"
                        >
                          <Volume2 size={14} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(item.word);
                          }}
                          disabled={deletingWord === item.word}
                          className="p-1.5 rounded hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors disabled:opacity-50"
                          title="删除"
                        >
                          {deletingWord === item.word ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        /* 详情视图 */
        <div className="flex-1 overflow-y-auto p-4">
          {!selectedWord && (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <BookOpen size={40} className="mb-3" />
              <p className="text-center text-sm">点击字幕中的英文单词即可查询词义</p>
            </div>
          )}

          {selectedWord && loading && (
            <div className="flex items-center justify-center h-full text-gray-400">
              <Loader2 size={24} className="animate-spin mr-2" />
              正在查询...
            </div>
          )}

          {selectedWord && error && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <p className="text-center text-sm text-red-400">{error}</p>
              <button
                onClick={() => selectedWord && lookup(selectedWord)}
                className="mt-3 px-3 py-1 text-xs bg-white/10 rounded hover:bg-white/20"
              >
                重试
              </button>
            </div>
          )}

          {selectedWord && data && !loading && (
            <div className="space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-2xl font-bold text-white">{data.word}</h3>
                  {data.phonetic && <p className="text-sm text-gray-400 mt-1">{data.phonetic}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => play(data.word)}
                    className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white"
                    title="发音"
                  >
                    <Volume2 size={16} />
                  </button>
                  <button
                    onClick={save}
                    disabled={saved}
                    className={`p-2 rounded-lg transition-colors ${
                      saved
                        ? 'bg-yellow-500/20 text-yellow-400'
                        : 'bg-white/10 hover:bg-white/20 text-white'
                    }`}
                    title={saved ? '已加入生词本' : '加入生词本'}
                  >
                    <Star size={16} fill={saved ? 'currentColor' : 'none'} />
                  </button>
                  {saved && (
                    <button
                      onClick={() => handleDelete(data.word)}
                      disabled={deletingWord === data.word}
                      className="p-2 rounded-lg bg-white/10 hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors"
                      title="从生词本删除"
                    >
                      {deletingWord === data.word ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </button>
                  )}
                </div>
              </div>

              {data.pos && (
                <div className="inline-block px-2 py-0.5 rounded bg-subtitle-highlight/20 text-subtitle-highlight text-xs">
                  {data.pos}
                </div>
              )}

              {(data.meaning_en || data.meaning_native) && (
                <div className="space-y-1">
                  {data.meaning_native && <p className="text-white text-sm">{data.meaning_native}</p>}
                  {data.meaning_en && <p className="text-gray-400 text-xs">{data.meaning_en}</p>}
                </div>
              )}

              {data.example?.en && (
                <div className="bg-white/5 rounded-lg p-3 space-y-1">
                  <p className="text-white text-sm italic">"{data.example.en}"</p>
                  {data.example.native && <p className="text-gray-400 text-xs">{data.example.native}</p>}
                </div>
              )}

              {data.family && data.family.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">词族</p>
                  <div className="flex flex-wrap gap-1">
                    {data.family.map((w) => (
                      <button
                        key={w}
                        onClick={() => setSelectedWord(w)}
                        className="px-2 py-0.5 rounded bg-white/10 text-xs text-gray-300 hover:bg-white/20"
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {data.related && data.related.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">相关词汇</p>
                  <div className="flex flex-wrap gap-1">
                    {data.related.map((w) => (
                      <button
                        key={w}
                        onClick={() => setSelectedWord(w)}
                        className="px-2 py-0.5 rounded bg-white/10 text-xs text-gray-300 hover:bg-white/20"
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {data.etymology_native && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">词源</p>
                  <p className="text-gray-300 text-sm">{data.etymology_native}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
