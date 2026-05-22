import { Globe } from '@/lib/lucide-icons';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n/languages';

export const LanguageSwitcher = () => {
  const { t, i18n } = useTranslation('header');
  const currentLanguage = i18n.resolvedLanguage || i18n.language;
  const currentLanguageMetadata =
    SUPPORTED_LANGUAGES.find(
      (language) => language.code.toLowerCase() === currentLanguage.toLowerCase(),
    ) ?? SUPPORTED_LANGUAGES[0];

  const handleChange = (language: SupportedLanguage) => {
    void i18n.changeLanguage(language);
  };

  return (
    <label
      className="flex h-9 items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2 text-text-secondary transition-colors hover:border-border-default hover:bg-hover hover:text-text-primary"
      title={t('selectLanguage')}
    >
      <Globe className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{t('language')}</span>
      <select
        data-testid="language-switcher"
        value={currentLanguageMetadata.code}
        aria-label={t('selectLanguage')}
        onChange={(event) => handleChange(event.target.value as SupportedLanguage)}
        className="cursor-pointer border-none bg-transparent text-xs font-medium outline-none"
      >
        {SUPPORTED_LANGUAGES.map((language) => (
          <option
            key={language.code}
            value={language.code}
            className="bg-surface text-text-primary"
          >
            {language.nativeName}
          </option>
        ))}
      </select>
    </label>
  );
};
