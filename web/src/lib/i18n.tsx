import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Lang = 'vi-VN' | 'en-US';

const KEY = 'lang';
export function currentLang(): Lang {
  try {
    return localStorage.getItem(KEY) === 'en-US' ? 'en-US' : 'vi-VN';
  } catch {
    return 'vi-VN';
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
