/**
 * Package-ownership attribution in the moveIngest phase: a .move file belongs
 * to a package only when it lives UNDER the package root. A sibling directory
 * sharing a name prefix ('pkg_ab' next to root 'pkg_a') must never match - a
 * bare startsWith('/repo/pkg_a') would claim '/repo/pkg_ab/sources/x.move'.
 */
import { describe, it, expect } from 'vitest';
import type { MoveFlowClient } from '../../../src/core/move/mcp-client.js';
import { runMoveIngestPhase } from '../../helpers/move-ingest-harness.js';

/** Client returning empty facts for every package, without a status tool. */
function emptyFactsClient(): MoveFlowClient {
  return {
    facts: async () => ({}),
    callGraph: async () => ({}),
    packageStatus: async () => ({ ok: true, diagnostics: '' }),
    capabilities: async () => ({ hasFactsQuery: true, hasStatusTool: false }),
    shutdown: async () => {},
  };
}

describe('moveIngest package-ownership attribution', () => {
  it('attributes each file to its own package across sibling packages pkg_a / pkg_ab', async () => {
    const output = await runMoveIngestPhase(emptyFactsClient(), '/repo', [
      'pkg_a/Move.toml',
      'pkg_a/sources/a.move',
      'pkg_ab/Move.toml',
      'pkg_ab/sources/ab.move',
    ]);

    const issues = output.consistencyIssues.filter((i) => i.code === 'empty-package-facts');
    expect(issues.map((i) => i.details?.packageRoot).sort()).toEqual([
      '/repo/pkg_a',
      '/repo/pkg_ab',
    ]);
    // Exactly one owned .move file each - no prefix bleed between siblings.
    expect(issues.map((i) => i.details?.moveFileCount)).toEqual([1, 1]);
  });

  it('does not attribute files of a prefix-sharing non-package sibling (pkg_ab) to pkg_a', async () => {
    // pkg_ab has no Move.toml, so its file belongs to NO package. With a bare
    // startsWith ownership test it would count towards pkg_a's empty-facts
    // diagnostics (moveFileCount 2 instead of 1).
    const output = await runMoveIngestPhase(emptyFactsClient(), '/repo', [
      'pkg_a/Move.toml',
      'pkg_a/sources/a.move',
      'pkg_ab/sources/x.move',
    ]);

    const issues = output.consistencyIssues.filter((i) => i.code === 'empty-package-facts');
    expect(issues).toHaveLength(1);
    expect(issues[0].details?.packageRoot).toBe('/repo/pkg_a');
    expect(issues[0].details?.moveFileCount).toBe(1);
  });
});
