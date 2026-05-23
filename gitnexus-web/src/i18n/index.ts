import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGE_CODES,
  getLanguageMetadata,
  normalizeSupportedLanguage,
} from './languages';
import { namespaceList, resources } from './resources';

const DEFAULT_NAMESPACE = 'common';
export const LANGUAGE_STORAGE_KEY = 'gitnexus.lng';

function syncDocumentLanguage(language: string | undefined): void {
  if (typeof document === 'undefined') return;
  const metadata = getLanguageMetadata(language);
  document.documentElement.lang = metadata.code;
  document.documentElement.dir = metadata.dir;
}

function convertDetectedLanguage(language: string): string {
  return normalizeSupportedLanguage(language) ?? DEFAULT_LANGUAGE;
}

function persistSupportedLanguage(language: string | undefined): void {
  const normalized = normalizeSupportedLanguage(language);
  if (!normalized || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  } catch {
    // localStorage may be unavailable in restricted browser contexts.
  }
}

export const i18nReady = i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGE_CODES,
    load: 'currentOnly',
    ns: namespaceList,
    defaultNS: DEFAULT_NAMESPACE,
    fallbackNS: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    detection: {
      order: ['querystring', 'localStorage', 'navigator', 'htmlTag'],
      lookupQuerystring: 'lng',
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: [],
      convertDetectedLanguage,
    },
  })
  .then(() => {
    const language = i18n.resolvedLanguage || i18n.language;
    syncDocumentLanguage(language);
    persistSupportedLanguage(language);
  });

i18n.on('languageChanged', (language) => {
  const resolvedLanguage = i18n.resolvedLanguage || language;
  syncDocumentLanguage(resolvedLanguage);
  persistSupportedLanguage(resolvedLanguage);
});

export default i18n;
