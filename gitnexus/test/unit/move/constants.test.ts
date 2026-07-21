import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { moveRepoRelativePath } from '../../../src/core/move/constants.js';

describe('moveRepoRelativePath', () => {
  it('returns a slash-normalized repo-relative path on the host platform', () => {
    const repoRoot = path.resolve('/repo');
    const source = path.join(repoRoot, 'pkg', 'sources', 'module.move');

    expect(moveRepoRelativePath(source, repoRoot)).toBe('pkg/sources/module.move');
  });

  it('does not claim a sibling path that merely shares the repo prefix', () => {
    const repoRoot = path.resolve('/repo/pkg');
    const sibling = path.resolve('/repo/pkg_other/sources/module.move');

    expect(moveRepoRelativePath(sibling, repoRoot)).toBe(sibling);
  });
});
