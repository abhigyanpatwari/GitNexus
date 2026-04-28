import { describe, expect, it } from 'vitest';
import { diffFileHashes } from '../../src/storage/file-hasher.js';

describe('diffFileHashes', () => {
  it('treats all current files as changed when no previous hashes exist', () => {
    expect(
      diffFileHashes(
        {
          'src/a.ts': 'hash-a',
          'src/b.ts': 'hash-b',
        },
        undefined,
      ),
    ).toEqual({
      changed: ['src/a.ts', 'src/b.ts'],
      removed: [],
      unchanged: 0,
    });
  });

  it('reports changed, unchanged, and removed files', () => {
    expect(
      diffFileHashes(
        {
          'src/changed.ts': 'new-hash',
          'src/unchanged.ts': 'same-hash',
          'src/added.ts': 'added-hash',
        },
        {
          'src/changed.ts': 'old-hash',
          'src/unchanged.ts': 'same-hash',
          'src/removed.ts': 'removed-hash',
        },
      ),
    ).toEqual({
      changed: ['src/changed.ts', 'src/added.ts'],
      removed: ['src/removed.ts'],
      unchanged: 1,
    });
  });

  it('reports no changes when hashes match exactly', () => {
    expect(
      diffFileHashes(
        {
          'src/a.ts': 'hash-a',
          'src/b.ts': 'hash-b',
        },
        {
          'src/a.ts': 'hash-a',
          'src/b.ts': 'hash-b',
        },
      ),
    ).toEqual({
      changed: [],
      removed: [],
      unchanged: 2,
    });
  });
});
