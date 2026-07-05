import { useEffect, useState, useCallback, useRef } from 'react';
import { ArrowLeft, Volume2, Check, X, Loader2, Brain, Keyboard, Headphones } from 'lucide-react';
import {
  generateReviewSession,
  reviewVocabularyWord,
  playWordTTS,
  type ReviewMode,
  type ReviewQuestion,
  type VocabularyStats,
} from '../../api/vocabulary';

interface VocabularyReviewProps {
  onClose: () => void;
  onStatsUpdate?: (stats: VocabularyStats) => void;
}

export function VocabularyReview({ onClose, onStatsUpdate }: VocabularyReviewProps) {
  const [mode, setMode] = useState<ReviewMode | null>(null);
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const [spellingInput, setSpellingInput] = useState('');
  const [result, setResult] = useState<'correct' | 'wrong' | null>(null);
  const [finished, setFinished] = useState(false);
  const [stats, setStats] = useState({ correct: 0, wrong: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const currentQuestion = questions[currentIndex];

  const startSession = useCallback(async (selectedMode: ReviewMode) => {
    setLoading(true);
    setError(null);
    setMode(selectedMode);
    try {
      const session = await generateReviewSession(selectedMode, 10);
      setQuestions(session.questions);
      setCurrentIndex(0);
      setStats({ correct: 0, wrong: 0 });
      setFinished(false);
      onStatsUpdate?.(session.stats);
    } catch (e) {
      setError('加载复习题目失败');
    } finally {
      setLoading(false);
    }
  }, [onStatsUpdate]);

  const handleAnswer = async (answer: string) => {
    if (!currentQuestion || result) return;

    const correct = answer.trim().toLowerCase() === currentQuestion.answer.trim().toLowerCase();
    setResult(correct ? 'correct' : 'wrong');
    setStats((s) => ({
      correct: s.correct + (correct ? 1 : 0),
      wrong: s.wrong + (correct ? 1 : 0),
    }));

    try {
      const updated = await reviewVocabularyWord(currentQuestion.word, correct);
      // Optimistically update proficiency in the question list
      setQuestions((prev) =>
        prev.map((q, i) => (i === currentIndex ? { ...q, proficiency: updated.proficiency } : q))
      );
    } catch (e) {
      console.error('Failed to record review:', e);
    }
  };

  const nextQuestion = () => {
    if (currentIndex >= questions.length - 1) {
      setFinished(true);
      return;
    }
    setCurrentIndex((i) => i + 1);
    setSelectedChoice(null);
    setSpellingInput('');
    setResult(null);
  };

  useEffect(() => {
    if (mode === 'spelling' && !result) {
      inputRef.current?.focus();
    }
  }, [currentIndex, mode, result]);

  const playCurrentWord = async () => {
    if (!currentQuestion) return;
    try {
      await playWordTTS(currentQuestion.word);
    } catch (e) {
      console.error('TTS failed:', e);
    }
  };

  if (!mode) {
    return (
      <div className="flex flex-col h-full p-4">
        <div className="flex items-center gap-2 mb-6">
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-gray-400">
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-lg font-semibold">选择复习模式</h2>
        </div>

        <div className="grid grid-cols-1 gap-3">
          <ModeCard
            icon={Brain}
            title="中英选择"
            desc="看英文，选择正确的中文释义"
            onClick={() => startSession('choice')}
          />
          <ModeCard
            icon={Headphones}
            title="听音辨词"
            desc="听发音，选择正确的单词"
            onClick={() => startSession('listening')}
          />
          <ModeCard
            icon={Keyboard}
            title="拼写练习"
            desc="看释义，拼写出英文单词"
            onClick={() => startSession('spelling')}
          />
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400">
        <Loader2 size={28} className="animate-spin mb-3" />
        加载复习题目...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 p-4">
        <p className="text-red-400 mb-3">{error}</p>
        <button onClick={() => setMode(null)} className="px-3 py-1.5 bg-white/10 rounded text-sm">
          返回
        </button>
      </div>
    );
  }

  if (finished || questions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4 text-center">
        <h3 className="text-xl font-bold mb-2">{questions.length === 0 ? '没有到期单词' : '复习完成！'}</h3>
        {questions.length > 0 && (
          <div className="flex gap-4 mb-6">
            <div className="text-green-400">✓ 正确 {stats.correct}</div>
            <div className="text-red-400">✗ 错误 {stats.wrong}</div>
          </div>
        )}
        <div className="flex gap-3">
          <button onClick={() => setMode(null)} className="px-4 py-2 bg-white/10 rounded-lg text-sm">
            返回模式选择
          </button>
          <button onClick={onClose} className="px-4 py-2 bg-subtitle-highlight text-black rounded-lg text-sm">
            关闭
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => setMode(null)} className="p-1 rounded hover:bg-white/10 text-gray-400">
          <ArrowLeft size={18} />
        </button>
        <span className="text-sm text-gray-400">
          {currentIndex + 1} / {questions.length}
        </span>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center space-y-6">
        <div className="text-center space-y-2">
          {mode === 'listening' ? (
            <button
              onClick={playCurrentWord}
              className="w-16 h-16 rounded-full bg-subtitle-highlight/20 text-subtitle-highlight flex items-center justify-center hover:bg-subtitle-highlight/30"
            >
              <Volume2 size={28} />
            </button>
          ) : (
            <>
              <h3 className="text-2xl font-bold">{currentQuestion.word}</h3>
              {currentQuestion.pos && (
                <span className="text-xs px-2 py-0.5 rounded bg-subtitle-highlight/20 text-subtitle-highlight">
                  {currentQuestion.pos}
                </span>
              )}
            </>
          )}

          {mode !== 'listening' && currentQuestion.meaning_native && (
            <p className="text-sm text-gray-400">{currentQuestion.meaning_native}</p>
          )}
        </div>

        {mode === 'spelling' ? (
          <div className="w-full max-w-sm space-y-3">
            <input
              ref={inputRef}
              type="text"
              value={spellingInput}
              onChange={(e) => setSpellingInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !result) {
                  handleAnswer(spellingInput);
                } else if (e.key === 'Enter' && result) {
                  nextQuestion();
                }
              }}
              disabled={!!result}
              placeholder="输入英文单词"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-center text-white placeholder-gray-500 focus:outline-none focus:border-subtitle-highlight/50 disabled:opacity-50"
            />
            {!result && (
              <button
                onClick={() => handleAnswer(spellingInput)}
                disabled={!spellingInput.trim()}
                className="w-full py-2 bg-subtitle-highlight text-black rounded-lg font-medium disabled:opacity-50"
              >
                提交
              </button>
            )}
          </div>
        ) : (
          <div className="w-full max-w-sm space-y-2">
            {currentQuestion.choices?.map((choice) => {
              let btnClass = 'w-full p-3 rounded-lg border text-left text-sm transition-colors ';
              if (result) {
                const isAnswer = choice === currentQuestion.answer;
                const isSelected = choice === selectedChoice;
                if (isAnswer) {
                  btnClass += 'bg-green-500/20 border-green-500/50 text-green-300';
                } else if (isSelected) {
                  btnClass += 'bg-red-500/20 border-red-500/50 text-red-300';
                } else {
                  btnClass += 'bg-white/5 border-white/10 text-gray-400';
                }
              } else {
                btnClass += 'bg-white/5 border-white/10 text-white hover:bg-white/10';
              }

              return (
                <button
                  key={choice}
                  disabled={!!result}
                  onClick={() => {
                    setSelectedChoice(choice);
                    handleAnswer(choice);
                  }}
                  className={btnClass}
                >
                  {choice}
                </button>
              );
            })}
          </div>
        )}

        {result && (
          <div className="flex flex-col items-center gap-2">
            <div className={`flex items-center gap-1 ${result === 'correct' ? 'text-green-400' : 'text-red-400'}`}>
              {result === 'correct' ? <Check size={18} /> : <X size={18} />}
              <span>{result === 'correct' ? '回答正确' : '回答错误'}</span>
            </div>
            {result === 'wrong' && (
              <p className="text-sm text-gray-400">正确答案：{currentQuestion.answer}</p>
            )}
            <button
              onClick={nextQuestion}
              className="mt-2 px-6 py-2 bg-subtitle-highlight text-black rounded-lg text-sm font-medium"
            >
              下一题
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeCard({
  icon: Icon,
  title,
  desc,
  onClick,
}: {
  icon: typeof Brain;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-4 p-4 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 transition-colors text-left"
    >
      <div className="w-10 h-10 rounded-lg bg-subtitle-highlight/20 flex items-center justify-center text-subtitle-highlight">
        <Icon size={20} />
      </div>
      <div>
        <h3 className="font-medium text-white">{title}</h3>
        <p className="text-xs text-gray-400">{desc}</p>
      </div>
    </button>
  );
}
