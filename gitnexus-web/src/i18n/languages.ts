export type SupportedLanguage = 'en' | 'zh-CN';

export interface LanguageMetadata {
  code: SupportedLanguage;
  nativeName: string;
  englishName: string;
  dir: 'ltr' | 'rtl';
}

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

export const SUPPORTED_LANGUAGES: LanguageMetadata[] = [
  { code: 'en', nativeName: 'English', englishName: 'English', dir: 'ltr' },
  { code: 'zh-CN', nativeName: '简体中文', englishName: 'Simplified Chinese', dir: 'ltr' },
];

export const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((language) => language.code);

export function getLanguageMetadata(code: string | undefined): LanguageMetadata {
  const normalized = code?.toLowerCase();
  return (
    SUPPORTED_LANGUAGES.find((language) => language.code.toLowerCase() === normalized) ??
    SUPPORTED_LANGUAGES[0]
  );
}
