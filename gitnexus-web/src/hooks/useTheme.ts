import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'gitnexus.theme';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

const isPreference = (v: unknown): v is ThemePreference =>
  v === 'system' || v === 'dark' || v === 'light';

const readStoredPreference = (): ThemePreference => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isPreference(v) ? v : 'system';
  } catch {
    return 'system';
  }
};

const resolve = (pref: ThemePreference): ResolvedTheme => {
  if (pref === 'system') {
    return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
  }
  return pref;
};

const apply = (resolved: ResolvedTheme) => {
  document.documentElement.dataset.theme = resolved;
};

export const useTheme = () => {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readStoredPreference()));

  useEffect(() => {
    const next = resolve(preference);
    setResolved(next);
    apply(next);
  }, [preference]);

  // When tracking the OS, follow live changes to the system preference.
  useEffect(() => {
    if (preference !== 'system') return;
    const mq = window.matchMedia(LIGHT_QUERY);
    const onChange = () => {
      const next: ResolvedTheme = mq.matches ? 'light' : 'dark';
      setResolved(next);
      apply(next);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preference]);

  const setPreference = useCallback((p: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      // localStorage may be unavailable (private mode); fall through.
    }
    setPreferenceState(p);
  }, []);

  return { preference, resolved, setPreference };
};
