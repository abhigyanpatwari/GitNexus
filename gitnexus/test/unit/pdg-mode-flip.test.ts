/**
 * Integration coverage for the pdg-mode flip → forced-full-writeback wiring
 * (#2099 F1). Sibling of incremental-orchestration.test.ts: real on-disk git
 * repo, real LadybugDB, real `runFullAnalysis`.
 *
 * The P1 these tests pin: the incremental DB writeback persists only
 * changed-file nodes, so before the fix a `--pdg` run against an
 * already-indexed repo silently persisted ZERO BasicBlock rows
 * (`Incremental: changed=0`), and a plain run after a `--pdg` index left
 * zombie blocks. The primary assertion is a direct count over the BasicBlock
 * table — `meta.stats.nodes` aggregates Community/Process rows that are
 * re-derived nondeterministically every run, so it is only used as a
 * secondary signal here, never with exact equality.
 */

import { describe, it, expect } from 'vitest';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { setupMiniRepo as setupSharedMiniRepo } from '../helpers/mini-repo.js';

const setupMiniRepo = () => setupSharedMiniRepo('gitnexus-pdg-flip-');

/** Direct count over the BasicBlock table — the primary truth signal. */
async function countBasicBlocks(repoPath: string): Promise<number> {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      'MATCH (n:BasicBlock) RETURN count(n) AS c',
    )) as Array<{ c: number | bigint }>;
    return Number(rows[0]?.c ?? 0);
  } finally {
    await adapter.closeLbug();
  }
}

describe('runFullAnalysis — pdg-mode flip (#2099 F1)', () => {
  it('off→on flip forces a full writeback that persists the CFG layer; on→off removes it', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const { storagePath } = getStoragePaths(repo.dbPath);
      const logs: string[] = [];
      const cb = { onProgress: () => {}, onLog: (m: string) => logs.push(m) };

      // 1. Plain index — no CFG layer, no stamp.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, cb);
      expect(await countBasicBlocks(repo.dbPath)).toBe(0);
      expect((await loadMeta(storagePath))!.pdg).toBeUndefined();

      // 2. The P1 trigger: --pdg with NO file changes. Pre-fix this hit the
      //    alreadyUpToDate fast path (or the incremental path with changed=0)
      //    and persisted nothing. The flip check must force a full rebuild.
      logs.length = 0;
      const flipOn = await runFullAnalysis(repo.dbPath, { skipAgentsMd: true, pdg: true }, cb);
      expect(flipOn.alreadyUpToDate).toBeUndefined();
      expect(logs.some((m) => m.includes('pdg mode changed'))).toBe(true);
      expect(await countBasicBlocks(repo.dbPath)).toBeGreaterThan(0);
      const stamped = await loadMeta(storagePath);
      expect(stamped!.pdg).toEqual({ maxFunctionLines: 2000, maxEdgesPerFunction: 5000 });
      expect(stamped!.incrementalInProgress).toBeUndefined(); // cleared on success

      // 3. Steady state: a second identical --pdg run takes the fast path —
      //    the flip check must compare equal (KTD5 default resolution).
      logs.length = 0;
      const steady = await runFullAnalysis(repo.dbPath, { skipAgentsMd: true, pdg: true }, cb);
      expect(steady.alreadyUpToDate).toBe(true);
      expect(logs.some((m) => m.includes('pdg mode changed'))).toBe(false);

      // 4. Flip back: a plain run must fully remove the CFG layer (no
      //    zombie BasicBlocks) and clear the stamp.
      logs.length = 0;
      const flipOff = await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, cb);
      expect(flipOff.alreadyUpToDate).toBeUndefined();
      expect(logs.some((m) => m.includes('pdg mode changed'))).toBe(true);
      expect(await countBasicBlocks(repo.dbPath)).toBe(0);
      expect((await loadMeta(storagePath))!.pdg).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('a cap change while pdg stays on forces a rebuild; matching modes keep incremental eligibility', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const { storagePath } = getStoragePaths(repo.dbPath);
      const logs: string[] = [];
      const cb = { onProgress: () => {}, onLog: (m: string) => logs.push(m) };

      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true, pdg: true }, cb);
      const blocks = await countBasicBlocks(repo.dbPath);
      expect(blocks).toBeGreaterThan(0);

      // Cap change with no file changes → mismatch → full rebuild (the
      // emit-time cap shapes the persisted edge set; meta must re-stamp).
      logs.length = 0;
      const capChange = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true, pdg: true, pdgMaxEdgesPerFunction: 1 },
        cb,
      );
      expect(capChange.alreadyUpToDate).toBeUndefined();
      expect(logs.some((m) => m.includes('different caps'))).toBe(true);
      expect((await loadMeta(storagePath))!.pdg).toEqual({
        maxFunctionLines: 2000,
        maxEdgesPerFunction: 1,
      });
      // The CFG layer survives a rebuild under a tighter edge cap (blocks are
      // never capped, only edges).
      expect(await countBasicBlocks(repo.dbPath)).toBe(blocks);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('a dirty flag from a crashed full rebuild composes with the flip check: one rebuild, flag cleared', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const { storagePath } = getStoragePaths(repo.dbPath);
      const logs: string[] = [];
      const cb = { onProgress: () => {}, onLog: (m: string) => logs.push(m) };

      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true, pdg: true }, cb);

      // Simulate a full rebuild that died between the pre-wipe dirty-flag
      // write (KTD2b: toWriteCount 0 sentinel) and the end-of-run saveMeta.
      const meta = (await loadMeta(storagePath))!;
      await saveMeta(storagePath, {
        ...meta,
        incrementalInProgress: { startedAt: Date.now(), toWriteCount: 0 },
      });

      // Next plain run: crash recovery fires (force), the flip ALSO logs its
      // notice (decoupled from the force gate), and exactly one rebuild runs.
      logs.length = 0;
      const recovered = await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, cb);
      expect(recovered.alreadyUpToDate).toBeUndefined();
      expect(logs.some((m) => m.includes('did not complete cleanly'))).toBe(true);
      expect(logs.some((m) => m.includes('pdg mode changed'))).toBe(true);
      const after = await loadMeta(storagePath);
      expect(after!.incrementalInProgress).toBeUndefined();
      expect(after!.pdg).toBeUndefined();
      expect(await countBasicBlocks(repo.dbPath)).toBe(0);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);
});
