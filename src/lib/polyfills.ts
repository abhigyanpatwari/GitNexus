// Browser polyfill for Node.js AsyncLocalStorage
export class AsyncLocalStorage<T> {
  private storage = new Map<string, T>();
  private currentId = 0;

  constructor() {}

  run<R>(store: T, callback: () => R): R {
    const id = (++this.currentId).toString();
    this.storage.set(id, store);
    try {
      return callback();
    } finally {
      this.storage.delete(id);
    }
  }

  getStore(): T | undefined {
    // In browser context, we can't truly replicate AsyncLocalStorage
    // Return undefined as fallback
    return undefined;
  }
}

// Export as both named and default to match different import styles
export { AsyncLocalStorage as default };

// Polyfill for global async_hooks if not available
if (typeof globalThis !== 'undefined' && !(globalThis as any).AsyncLocalStorage) {
  (globalThis as any).AsyncLocalStorage = AsyncLocalStorage;
} 