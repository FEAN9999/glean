import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Lang = 'vi-VN' | 'en-US';

/** A text in both languages, kept so it can be shown again after the language is changed: t(x.vi, x.en). */
export interface Both {
  vi: string;
  en: string;
}

const KEY = 'lang';
export function currentLang(): Lang {
  try {
    return localStorage.getItem(KEY) === 'en-US' ? 'en-US' : 'vi-VN';
  } catch {
    return 'vi-VN';
  }
}

/**
 * A text the server wrote in both languages (`pack` in server/bilingual.ts): a sieve failure
 * reason, a sync log line, a backup error. A plain text is shown as it is.
 */
export function unpack(text: string, lang: Lang): string {
  if (!text.startsWith('{"vi":')) return text;
  try {
    const both = JSON.parse(text) as { vi: string; en: string };
    return lang === 'en-US' ? both.en : both.vi;
  } catch {
    return text;
  }
}

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Inline pair: t('Tiếng Việt', 'English') */
  t: (vi: string, en: string) => string;
}

const Ctx = createContext<I18n>({ lang: 'vi-VN', setLang: () => {}, t: (vi) => vi });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(currentLang());
  useEffect(() => {
    document.documentElement.lang = lang === 'en-US' ? 'en' : 'vi';
  }, [lang]);
  const setLang = (l: Lang) => {
    try {
      localStorage.setItem(KEY, l);
    } catch {
      /* ignore */
    }
    setLangState(l);
  };
  const t = (vi: string, en: string) => (lang === 'en-US' ? en : vi);
  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
