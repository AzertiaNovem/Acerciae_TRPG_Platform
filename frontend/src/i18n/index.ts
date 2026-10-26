import { create } from 'zustand';
import catalog from './catalog.json';

export const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어',
  es: 'Español', fr: 'Français', de: 'Deutsch', ru: 'Русский', pt: 'Português', it: 'Italiano',
};
export const LOCALES = Object.keys(LANGUAGE_LABELS);
let initial = 'en';
try { const stored = localStorage.getItem('acerciae.ui-language'); if (stored && LOCALES.includes(stored)) initial = stored; } catch { /* storage may be disabled */ }
export const useLocale = create<{ language: string; setLanguage: (language: string) => void }>((set) => ({
  language: initial,
  setLanguage: (language) => {
    if (!LOCALES.includes(language)) language = 'en';
    try { localStorage.setItem('acerciae.ui-language', language); } catch { /* account preference still works */ }
    document.documentElement.lang = language;
    set({ language });
  },
}));
// Catalog entries contain translations in the same order as LOCALES, excluding English.
// Only application-owned labels are passed here. Never translate chat, character names or log content.
const entries = catalog as Record<string, string[]>;
const normalized = Object.fromEntries(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
export function t(source: string, values: Record<string, string | number> = {}, language = useLocale.getState().language): string {
  const index = LOCALES.indexOf(language) - 1;
  const translation = index >= 0 ? (entries[source.trim()] || normalized[source.trim().toLowerCase()])?.[index] : undefined;
  return (translation ? source.replace(source.trim(), translation) : source).replace(/\{(\w+)\}/g, (match, key) => key in values ? String(values[key]) : match);
}

export const currentLocale = () => useLocale.getState().language;
