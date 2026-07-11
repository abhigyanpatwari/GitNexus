import { describe, expect, it, vi } from 'vitest';

// The helper lives in App.tsx, whose import chain pulls in WebGL-backed
// rendering (sigma via GraphCanvas) that jsdom cannot load — stub it out;
// this suite only exercises the pure pickRestoreRepo helper.
vi.mock('../../src/components/GraphCanvas', () => ({
  GraphCanvas: () => null,
}));

import { pickRestoreRepo } from '../../src/App';

describe('pickRestoreRepo (URL restore param preference, #2419)', () => {
  it('prefers the repo path identity when both params are present', () => {
    const params = new URLSearchParams('repo=%2Fws%2Fgroup-b%2Freels&project=reels');

    expect(pickRestoreRepo(params)).toBe('/ws/group-b/reels');
  });

  it('falls back to the project display name for legacy project-only URLs', () => {
    const params = new URLSearchParams('project=reels');

    expect(pickRestoreRepo(params)).toBe('reels');
  });

  it('uses the repo path identity when only repo is present', () => {
    const params = new URLSearchParams('repo=%2Fws%2Fgroup-b%2Freels');

    expect(pickRestoreRepo(params)).toBe('/ws/group-b/reels');
  });

  it('returns undefined when neither param is present', () => {
    const params = new URLSearchParams('server=http%3A%2F%2Flocalhost%3A4747');

    expect(pickRestoreRepo(params)).toBeUndefined();
  });
});
