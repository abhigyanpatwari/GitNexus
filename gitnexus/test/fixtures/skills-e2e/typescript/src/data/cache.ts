
import { runQuery } from './query';

const cache = new Map<string, any>();

export function getCached(key: string) {
  return cache.get(key) || null;
}

export function warmCache(keys: string[]) {
  for (const key of keys) {
    cache.set(key, runQuery(key));
  }
}
