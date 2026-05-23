import { beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

const I18N_LANGUAGE_STORAGE_KEY = 'gitnexus.lng';

function ensureStorage(name: 'localStorage' | 'sessionStorage') {
  const current = globalThis[name];
  if (
    current &&
    typeof current.getItem === 'function' &&
    typeof current.removeItem === 'function'
  ) {
    return;
  }

  const store = new Map<string, string>();
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

ensureStorage('localStorage');
ensureStorage('sessionStorage');
localStorage.removeItem(I18N_LANGUAGE_STORAGE_KEY);

// Reset storage between tests
beforeEach(() => {
  sessionStorage.removeItem('gitnexus-llm-settings');
  localStorage.removeItem('gitnexus-llm-settings'); // legacy key (migration)
  localStorage.removeItem(I18N_LANGUAGE_STORAGE_KEY);
});
