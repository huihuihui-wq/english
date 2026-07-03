// hooks/usePanelShortcuts.ts
import { useEffect } from 'react';
import { useSubtitleStore } from '../stores/subtitleStore';

export function usePanelShortcuts() {
  const { activePanel, setActivePanel, setSearchQuery } = useSubtitleStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        // 在输入框内只响应 Escape 关闭面板
        if (e.key === 'Escape' && activePanel !== 'subtitles') {
          setActivePanel('subtitles');
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setActivePanel('search');
        return;
      }

      switch (e.key.toLowerCase()) {
        case 's':
          e.preventDefault();
          setActivePanel(activePanel === 'search' ? 'subtitles' : 'search');
          break;
        case 'v':
          e.preventDefault();
          setActivePanel(activePanel === 'vocab' ? 'subtitles' : 'vocab');
          break;
        case 'a':
          e.preventDefault();
          setActivePanel(activePanel === 'ai' ? 'subtitles' : 'ai');
          break;
        case 'escape':
          if (activePanel !== 'subtitles') {
            setActivePanel('subtitles');
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activePanel, setActivePanel, setSearchQuery]);
}
