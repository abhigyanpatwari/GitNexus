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

export function normalizeSupportedLanguage(
  code: string | undefined | null,
): SupportedLanguage | null {
  const normalized = code?.trim().split('.')[0]?.replace(/_/g, '-').toLowerCase();
  if (!normalized) return null;
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (
    normalized === 'zh' ||
    normalized === 'zh-cn' ||
    normalized.startsWith('zh-cn-') ||
    normalized === 'zh-hans' ||
    normalized.startsWith('zh-hans-')
  ) {
    return 'zh-CN';
  }
  return null;
}

export function getLanguageMetadata(code: string | undefined): LanguageMetadata {
  const normalized = normalizeSupportedLanguage(code);
  return (
    SUPPORTED_LANGUAGES.find((language) => language.code === normalized) ?? SUPPORTED_LANGUAGES[0]
  );
}
