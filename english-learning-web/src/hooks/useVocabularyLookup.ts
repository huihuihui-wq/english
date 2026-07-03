// hooks/useVocabularyLookup.ts
import { useState, useCallback, useRef } from 'react';
import { lookupWord, playWordTTS, addToVocabulary, checkWordSaved, type WordLookupResult } from '../api/vocabulary';

interface VocabState {
  data: WordLookupResult | null;
  loading: boolean;
  error: string | null;
  saved: boolean;
}

export function useVocabularyLookup() {
  const [state, setState] = useState<VocabState>({
    data: null,
    loading: false,
    error: null,
    saved: false,
  });

  const cacheRef = useRef<Map<string, WordLookupResult>>(new Map());

  const lookup = useCallback(async (word: string) => {
    const cleanWord = word.trim().toLowerCase().replace(/[^a-zA-Z0-9'-]/g, '');
    if (!cleanWord) {
      setState({ data: null, loading: false, error: '请输入有效单词', saved: false });
      return;
    }

    setState((s) => ({ ...s, loading: true, error: null }));

    try {
      let data = cacheRef.current.get(cleanWord);
      if (!data) {
        data = await lookupWord(cleanWord);
        cacheRef.current.set(cleanWord, data);
      }

      let saved = false;
      try {
        const check = await checkWordSaved(cleanWord);
        saved = check.saved;
      } catch {
        saved = false;
      }

      setState({ data, loading: false, error: null, saved });
    } catch (e: unknown) {
      setState({
        data: null,
        loading: false,
        error: e instanceof Error ? e.message : '查词失败',
        saved: false,
      });
    }
  }, []);

  const play = useCallback(async (word: string) => {
    try {
      await playWordTTS(word);
    } catch (e: unknown) {
      console.error('TTS failed:', e);
    }
  }, []);

  const save = useCallback(async () => {
    if (!state.data) return;
    const { data } = state;
    try {
      await addToVocabulary({
        word: data.word,
        lemma: data.lemma,
        phonetic: data.phonetic,
        pos: data.pos,
        meaning_en: data.meaning_en,
        meaning_native: data.meaning_native,
        native_lang: data.native_lang,
        example: data.example,
      });
      setState((s) => ({ ...s, saved: true }));
    } catch (e: unknown) {
      console.error('Add to vocabulary failed:', e);
    }
  }, [state.data]);

  const clear = useCallback(() => {
    setState({ data: null, loading: false, error: null, saved: false });
  }, []);

  return {
    ...state,
    lookup,
    play,
    save,
    clear,
  };
}
