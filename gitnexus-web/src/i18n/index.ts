import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES, getLanguageMetadata } from './languages';
import { namespaceList, resources } from './resources';

const DEFAULT_NAMESPACE = 'common';
const FALLBACK_NAMESPACES = namespaceList.filter((namespace) => namespace !== DEFAULT_NAMESPACE);

function syncDocumentLanguage(language: string | undefined): void {
  if (typeof document === 'undefined') return;
  const metadata = getLanguageMetadata(language);
  document.documentElement.lang = metadata.code;
  document.documentElement.dir = metadata.dir;
}

export const i18nReady = i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...SUPPORTED_LANGUAGE_CODES, 'zh-cn', 'zh'],
    nonExplicitSupportedLngs: true,
    load: 'currentOnly',
    ns: namespaceList,
    defaultNS: DEFAULT_NAMESPACE,
    fallbackNS: FALLBACK_NAMESPACES,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    detection: {
      order: ['querystring', 'localStorage', 'navigator', 'htmlTag'],
      lookupQuerystring: 'lng',
      lookupLocalStorage: 'gitnexus.lng',
      caches: ['localStorage'],
    },
  })
  .then(() => syncDocumentLanguage(i18n.resolvedLanguage || i18n.language));

i18n.on('languageChanged', (language) => syncDocumentLanguage(language));

export default i18n;
