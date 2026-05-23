import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_START_EMBEDDINGS_STORAGE_KEY,
  shouldAutoStartEmbeddings,
} from '../../src/hooks/useAppState';

describe('embedding auto-start gate', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to disabled so connecting a repo remains read-only', () => {
    expect(shouldAutoStartEmbeddings()).toBe(false);
  });

  it('allows opt-in through localStorage', () => {
    window.localStorage.setItem(AUTO_START_EMBEDDINGS_STORAGE_KEY, 'true');
    expect(shouldAutoStartEmbeddings()).toBe(true);
  });

  it('treats any non-true value as disabled', () => {
    window.localStorage.setItem(AUTO_START_EMBEDDINGS_STORAGE_KEY, 'false');
    expect(shouldAutoStartEmbeddings()).toBe(false);
  });
});
