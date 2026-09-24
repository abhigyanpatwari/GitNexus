import { useState } from 'react';
import { Key } from '@/lib/lucide-icons';
import { useTranslation } from 'react-i18next';
import { getAuthToken, setAuthToken } from '../services/backend-client';
import { SecretInput } from './settings/SecretInput';

interface AccessTokenPromptProps {
  /** Called after the token is stored, so the caller can re-probe immediately. */
  onSubmit?: () => void;
}

/**
 * Shown instead of the "start a server" guide when the backend answers 401:
 * the deploy is up, it just needs the access token its operator generated.
 *
 * The token is held in sessionStorage for this browser session only — see
 * AUTH_TOKEN_STORAGE_KEY. Nothing here logs it or puts it in a URL.
 */
export const AccessTokenPrompt = ({ onSubmit }: AccessTokenPromptProps) => {
  const { t } = useTranslation('settings');
  const [token, setToken] = useState(getAuthToken);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setAuthToken(token);
    onSubmit?.();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="animate-fade-in rounded-3xl border border-border-default bg-surface p-7"
    >
      <div className="mb-5 text-center">
        <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-accent/20">
          <Key className="h-5 w-5 text-accent" />
        </div>
        <h2 className="text-lg leading-snug font-semibold text-text-primary">
          {t('accessToken.title')}
        </h2>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          {t('accessToken.promptHint')}
        </p>
      </div>

      <SecretInput
        value={token}
        onChange={setToken}
        label={t('accessToken.label')}
        placeholder={t('accessToken.placeholder')}
        revealLabel={t('accessToken.reveal')}
        hideLabel={t('accessToken.hide')}
      />

      <button
        type="submit"
        className="mt-4 w-full cursor-pointer rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white shadow-glow-soft transition-all hover:bg-accent/90 hover:shadow-glow"
      >
        {t('accessToken.connect')}
      </button>

      <p className="mt-4 border-t border-border-subtle pt-4 text-center text-xs leading-relaxed text-text-muted">
        {t('accessToken.sessionNote')}
      </p>
    </form>
  );
};
