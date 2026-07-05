// components/VideoPlayer/SubtitleOverlay.tsx
import { useMemo } from 'react';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useStudyStore } from '../../stores/studyStore';
import { getCueTranslation } from '../../types/subtitle';

function WordSpan({ word }: { word: string }) {
  const { setSelectedWord, setActivePanel } = useSubtitleStore();

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const clean = word.replace(/[^a-zA-Z0-9'-]/g, '').toLowerCase();
    if (clean) {
      setSelectedWord(clean);
      setActivePanel('vocab');
    }
  };

  return (
    <span
      onClick={handleClick}
      className="cursor-pointer hover:bg-white/20 rounded px-0.5 pointer-events-auto"
      title="点击查词"
    >
      {word}
    </span>
  );
}

function ClickableText({ text }: { text: string }) {
  const words = text.split(/(\s+)/);
  return (
    <>
      {words.map((part, index) => {
        if (/^\s+$/.test(part)) {
          return <span key={index}>{part}</span>;
        }
        return <WordSpan key={index} word={part} />;
      })}
    </>
  );
}

export function SubtitleOverlay() {
  const { getCurrentCue, settings } = useSubtitleStore();
  const { occlusionMode } = useStudyStore();
  const currentCue = getCurrentCue();

  const shouldShowPrimary = settings.displayMode === 'bilingual' || settings.displayMode === 'primary';
  const shouldShowSecondary = settings.displayMode === 'bilingual' || settings.displayMode === 'secondary';

  const isPrimaryOccluded = occlusionMode === 'primary';
  const isSecondaryOccluded = occlusionMode === 'secondary';

  const translatedText = currentCue ? getCueTranslation(currentCue, settings.translateTargetLang) : '';

  const positionStyle = useMemo(() => {
    switch (settings.position) {
      case 'top':
        return { top: '40px', bottom: 'auto', transform: 'none' };
      case 'middle':
        return { top: '50%', bottom: 'auto', transform: 'translateY(-50%)' };
      case 'bottom':
      default:
        return { bottom: '80px', top: 'auto', transform: 'none' };
    }
  }, [settings.position]);

  if (!currentCue || settings.displayMode === 'none') return null;

  const bgOpacity = Math.round(settings.backgroundOpacity * 255).toString(16).padStart(2, '0');

  return (
    <div
      className="absolute left-0 right-0 px-4 py-2 text-center z-10"
      style={positionStyle}
    >
      <div
        className="inline-block px-5 py-3 rounded-lg max-w-[90%] pointer-events-auto"
        style={{
          backgroundColor: `${settings.backgroundColor}${bgOpacity}`,
          fontFamily: settings.fontFamily,
        }}
      >
        {shouldShowPrimary && (
          <p
            className={`subtitle-text font-medium mb-1.5 ${isPrimaryOccluded ? 'blur-[6px] select-none' : ''}`}
            style={{
              color: settings.fontColor,
              fontSize: `${settings.fontSize}px`,
              lineHeight: settings.lineHeight,
              letterSpacing: `${settings.letterSpacing}px`,
            }}
          >
            <ClickableText text={currentCue.primaryText} />
          </p>
        )}

        {shouldShowSecondary && (
          <p
            className={`subtitle-text ${isSecondaryOccluded ? 'blur-[6px] select-none' : ''}`}
            style={{
              color: settings.fontColor,
              fontSize: `${settings.fontSize * 0.85}px`,
              lineHeight: settings.lineHeight,
              opacity: 0.9,
            }}
          >
            {translatedText}
          </p>
        )}
      </div>
    </div>
  );
}
