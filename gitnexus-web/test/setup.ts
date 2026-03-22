import { beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
};

const ensureStorage = (kind: 'localStorage' | 'sessionStorage'): void => {
  const browserStorage =
    typeof window !== 'undefined' && typeof window[kind]?.getItem === 'function'
      ? window[kind]
      : undefined;
  const storage = browserStorage ?? createMemoryStorage();

  if (typeof window !== 'undefined') {
    Object.defineProperty(window, kind, {
      value: storage,
      configurable: true,
    });
  }

  Object.defineProperty(globalThis, kind, {
    value: storage,
    configurable: true,
  });
};

ensureStorage('localStorage');
ensureStorage('sessionStorage');

const getStorage = (kind: 'localStorage' | 'sessionStorage'): Storage | undefined => {
  const browserStorage =
    typeof window !== 'undefined' && typeof window[kind]?.removeItem === 'function'
      ? window[kind]
      : undefined;
  if (browserStorage) return browserStorage;

  const globalStorage = globalThis[kind as keyof typeof globalThis];
  return globalStorage && typeof (globalStorage as Storage).removeItem === 'function'
    ? (globalStorage as Storage)
    : undefined;
};

// Reset storage between tests
beforeEach(() => {
  getStorage('sessionStorage')?.removeItem('gitnexus-llm-settings');
  getStorage('localStorage')?.removeItem('gitnexus-llm-settings'); // legacy key (migration)
});
