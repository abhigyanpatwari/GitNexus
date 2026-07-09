/**
 * Integration coverage for the `runFullAnalysis` incremental-orchestration
 * wiring (Claude PR-review Finding 2).
 *
 * These tests exercise the *real runtime path* — they call
 * `runFullAnalysis` against a real on-disk git repo backed by a real
 * LadybugDB at `<repo>/.gitnexus/`, and assert behaviours that pure
 * unit tests on `diffFileHashes` / `extractChangedSubgraph` cannot
 * catch:
 *
 *   - the `isIncremental` decision (post-pipeline eligibility check)
 *   - `incrementalInProgress` dirty-flag set-before-mutation and
 *     clear-on-success
 *   - the importer-closure expansion (1-hop reached via the writable
 *     set, transitive reachable via bounded BFS)
 *   - the "forced full rebuild on dirty-flag-from-prior-crash" path
 *
 * Each test creates a temporary git repo, runs the analyzer, and asserts
 * on the resulting `meta.json` and graph state. Cleanup is best-effort
 * (Windows LadybugDB handle release can lag; `cleanupTempDir` retries).
 */

import { execSync } from 'child_process';
import { writeFile, readFile } from 'fs/promises';
import path from 'path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  INCREMENTAL_SCHEMA_VERSION,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { setupMiniRepo as setupSharedMiniRepo } from '../helpers/mini-repo.js';

const setupMiniRepo = () => setupSharedMiniRepo('gitnexus-incr-orch-');

/** Stage + commit everything in the temp repo (mirrors mini-repo.ts's git calls). */
const gitCommitAll = (cwd: string, message: string): void => {
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A', {
    cwd,
    stdio: 'pipe',
  });
  execSync(
    `git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m "${message}"`,
    { cwd, stdio: 'pipe' },
  );
};

/**
 * Direct count over INJECTS CodeRelation rows — mirrors pdg-mode-flip's
 * countBasicBlocks: reopen the repo DB, count, close (runFullAnalysis closes
 * the singleton on completion, so each count owns its own open/close).
 */
async function countInjects(repoPath: string): Promise<number> {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      `MATCH ()-[r:CodeRelation]->() WHERE r.type = 'INJECTS' RETURN count(r) AS c`,
    )) as Array<{ c: number | bigint }>;
    return Number(rows[0]?.c ?? 0);
  } finally {
    await adapter.closeLbug();
  }
}

/** Java DI fixture (#2200): `@Autowired List<IFoo>` + 2 implementers ⇒ exactly
 *  2 INJECTS edges (Consumer→FooA, Consumer→FooB). Same shapes as the
 *  spring-di-pipeline integration fixture. */
const JAVA_DI_FIXTURE: ReadonlyArray<readonly [string, string]> = [
  ['IFoo.java', 'package com.example;\n\npublic interface IFoo {}\n'],
  ['FooA.java', 'package com.example;\n\npublic class FooA implements IFoo {}\n'],
  ['FooB.java', 'package com.example;\n\npublic class FooB implements IFoo {}\n'],
  [
    'Consumer.java',
    'package com.example;\n' +
      'import java.util.List;\n' +
      'import org.springframework.beans.factory.annotation.Autowired;\n' +
      '\n' +
      'public class Consumer {\n' +
      '  @Autowired private List<IFoo> foos;\n' +
      '}\n',
  ],
];

describe('runFullAnalysis — incremental orchestration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('first run populates fileHashes + schemaVersion and clears incrementalInProgress on success', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta).not.toBeNull();
      expect(meta!.schemaVersion).toBe(INCREMENTAL_SCHEMA_VERSION);
      expect(meta!.fileHashes).toBeDefined();
      expect(Object.keys(meta!.fileHashes ?? {}).length).toBeGreaterThan(0);
      // Dirty flag MUST be cleared after a successful run.
      expect(meta!.incrementalInProgress).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  }, 180_000);

  it('second run on unchanged state takes the alreadyUpToDate fast path', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const first = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      expect(first.alreadyUpToDate).toBeUndefined();

      const second = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      // lastCommit==HEAD && working tree clean (mod GitNexus output) →
      // early-return fast path.
      expect(second.alreadyUpToDate).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('second run after a comment-only edit takes the incremental path, clears the dirty flag, and preserves graph stats exactly', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const firstMeta = await loadMeta(storagePath);

      // Modify a source file with a COMMENT-ONLY edit — by construction
      // this changes the content hash (driving the incremental code path)
      // without changing any symbol, scope binding, call edge, import,
      // or community membership. Therefore every graph-stat invariant
      // (files / nodes / edges / communities / processes) MUST be
      // bit-identical to the first run. Anything else is a regression.
      const target = path.join(repo.dbPath, 'src', 'logger.ts');
      const before = await readFile(target, 'utf-8');
      await writeFile(target, before + '\n// touched by test\n', 'utf-8');

      const second = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      // The early-return alreadyUpToDate path must NOT fire (the dirty
      // tree should kick the run through to incremental writeback).
      expect(second.alreadyUpToDate).toBeUndefined();

      const secondMeta = await loadMeta(storagePath);
      expect(secondMeta).not.toBeNull();
      // Dirty flag must be cleared on success.
      expect(secondMeta!.incrementalInProgress).toBeUndefined();
      // fileHashes[logger.ts] must have rotated to the new content.
      expect(secondMeta!.fileHashes?.['src/logger.ts']).toBeDefined();
      expect(secondMeta!.fileHashes?.['src/logger.ts']).not.toBe(
        firstMeta!.fileHashes?.['src/logger.ts'],
      );
      // Exact-equality stats invariant. DoD §2.7: avoid bounds-only
      // assertions that would mask a regression dropping half the graph.
      expect(secondMeta!.stats?.files).toBe(firstMeta!.stats?.files);
      expect(secondMeta!.stats?.nodes).toBe(firstMeta!.stats?.nodes);
      expect(secondMeta!.stats?.edges).toBe(firstMeta!.stats?.edges);
      expect(secondMeta!.stats?.communities).toBe(firstMeta!.stats?.communities);
      expect(secondMeta!.stats?.processes).toBe(firstMeta!.stats?.processes);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('incremental output is byte-equivalent to a full rebuild (incremental ≡ --force on the same repo state)', async () => {
    // The central correctness contract of this PR: an incremental run
    // and a full rebuild from the same repo state must produce identical
    // graph stats. We exercise it end-to-end:
    //
    //   1. setup mini-repo + run analyze (populates the index)
    //   2. edit one source file (comment-only — same graph)
    //   3. run incremental analyze → record secondMeta
    //   4. run analyze --force from the same state → record forceMeta
    //   5. assert every stats invariant is exactly equal.
    //
    // Steps 3 and 4 share the same on-disk file contents, so any
    // divergence is purely an artifact of the writeback strategy. If
    // any invariant differs, the PR's load-bearing claim is violated.
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      // Step 1: initial index.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      // Step 2: comment-only edit, same as the test above.
      const target = path.join(repo.dbPath, 'src', 'logger.ts');
      const original = await readFile(target, 'utf-8');
      await writeFile(target, original + '\n// equivalence test touch\n', 'utf-8');

      // Step 3: incremental writeback for the edited file.
      const incremental = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      expect(incremental.alreadyUpToDate).toBeUndefined();
      const { storagePath } = getStoragePaths(repo.dbPath);
      const secondMeta = await loadMeta(storagePath);
      expect(secondMeta).not.toBeNull();

      // Step 4: force a full rebuild from the SAME on-disk file state.
      const forced = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true, force: true },
        { onProgress: () => {} },
      );
      expect(forced.alreadyUpToDate).toBeUndefined();
      const forceMeta = await loadMeta(storagePath);
      expect(forceMeta).not.toBeNull();

      // Step 5: exact-equality across every stat. `toEqual` would also
      // work but `toBe` per-field makes a failure pinpoint the field.
      expect(secondMeta!.stats?.files).toBe(forceMeta!.stats?.files);
      expect(secondMeta!.stats?.nodes).toBe(forceMeta!.stats?.nodes);
      expect(secondMeta!.stats?.edges).toBe(forceMeta!.stats?.edges);
      expect(secondMeta!.stats?.communities).toBe(forceMeta!.stats?.communities);
      expect(secondMeta!.stats?.processes).toBe(forceMeta!.stats?.processes);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('a stale incrementalInProgress flag at startup forces a full rebuild that clears it', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      // First run lays down a normal index.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      // Manually corrupt meta.json with a stale dirty flag — simulates
      // a crashed previous incremental run.
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta).not.toBeNull();
      const tampered: RepoMeta = {
        ...meta!,
        incrementalInProgress: {
          startedAt: Date.now() - 60_000,
          toWriteCount: 3,
          phase: 'load-graph',
          importerExpansion: 153,
          effectiveWriteCount: 167,
          deleteCount: 169,
        },
      };
      await saveMeta(storagePath, tampered);
      const logs: string[] = [];

      // Next run must detect the flag, force a full rebuild (which
      // overwrites meta), and clear the flag.
      const recovered = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );
      // A full rebuild was taken — the alreadyUpToDate fast path
      // explicitly cannot fire because the dirty-flag check rewrote
      // `options.force` to true.
      expect(recovered.alreadyUpToDate).toBeUndefined();

      const after = await loadMeta(storagePath);
      expect(after!.incrementalInProgress).toBeUndefined();
      expect(logs.join('\n')).toContain(
        'last dirty state: phase=load-graph, toWrite=3, importerExpansion=153, effectiveWrite=167, deleteCount=169',
      );
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  // Regression for #2289 review P1: a pre-v5 stamp (e.g. v4 with url-only
  // Route ids) re-analyzed on the SAME commit must NOT early-return on the
  // `alreadyUpToDate` fast path — otherwise the v5 schema bump's
  // re-keyed-Route migration is silently bypassed and stale URL-only Route
  // rows persist alongside any new composite-keyed writes. The schemaVersion
  // gate (mirrors pdgModeMismatch's slot above the fast path) must force a
  // full rebuild before lastCommit-equality short-circuits the pipeline.
  it('a pre-v5 schemaVersion stamp forces a full rebuild on an unchanged-commit re-analyze', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      // First run stamps schemaVersion = INCREMENTAL_SCHEMA_VERSION (v5).
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta).not.toBeNull();
      expect(meta!.schemaVersion).toBe(INCREMENTAL_SCHEMA_VERSION);

      // Simulate a repo indexed at the SAME commit by a pre-v5 GitNexus
      // build: rewrite meta.json with schemaVersion = 4. lastCommit and
      // working tree are untouched, so without the schemaVersion gate the
      // run-analyze fast path would early-return `alreadyUpToDate=true`
      // and never touch the stale Route rows.
      const downgraded: RepoMeta = { ...meta!, schemaVersion: 4 };
      await saveMeta(storagePath, downgraded);

      const reanalyzed = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      // Pipeline actually ran (schemaVersion mismatch → force=true).
      expect(reanalyzed.alreadyUpToDate).toBeUndefined();
      // And the meta is stamped back to v5 (the rebuild path runs saveMeta).
      const restamped = await loadMeta(storagePath);
      expect(restamped!.schemaVersion).toBe(INCREMENTAL_SCHEMA_VERSION);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  // #2331/#2339: mirrors the schemaVersion mismatch test above, but for the
  // CJK segmentation mode stamp. Uses a non-default mode ('bigram') rather
  // than 'none' — with the default, (undefined ?? 'none') !== 'none' is
  // false regardless of whether the stamp was ever actually written, so a
  // dropped-stamp bug would pass this test vacuously. 'bigram' makes an
  // omitted stamp manifest as a real comparator mismatch instead.
  it('a stale cjkSegmentation stamp forces a full rebuild on an unchanged-commit re-analyze', async () => {
    const repo = await setupMiniRepo();
    try {
      vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { storagePath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta).not.toBeNull();
      expect(meta!.cjkSegmentation).toBe('bigram');

      // Simulate a repo indexed under 'none' (or a pre-#2339 build with no
      // stamp at all) that's now being served/re-analyzed with bigram mode.
      const downgraded: RepoMeta = { ...meta!, cjkSegmentation: 'none' };
      await saveMeta(storagePath, downgraded);

      const reanalyzed = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      // Pipeline actually ran (cjkSegmentation mismatch → force=true).
      expect(reanalyzed.alreadyUpToDate).toBeUndefined();
      // And the meta is restamped to the live resolved mode.
      const restamped = await loadMeta(storagePath);
      expect(restamped!.cjkSegmentation).toBe('bigram');
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('first-ever analyze of a brand-new repo proceeds without a spurious CJK mode force-rebuild', async () => {
    const repo = await setupMiniRepo();
    try {
      const { storagePath } = getStoragePaths(repo.dbPath);
      // No meta.json exists yet — existingMeta is falsy, so the
      // cjkSegmentationModeMismatch guard is skipped entirely (never calls
      // the comparator), same as the pdg/schemaVersion guards above it.
      expect(await loadMeta(storagePath)).toBeNull();

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      expect(result.alreadyUpToDate).toBeUndefined();

      const meta = await loadMeta(storagePath);
      expect(meta!.cjkSegmentation).toBe('none');
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  // U7 (#2200): the INJECTS delete-before-writeback must be UNCONDITIONAL.
  // extractChangedSubgraph re-includes ALL INJECTS edges from the fresh graph
  // on every incremental run (isGraphWideRelType), and CodeRelation has no PK
  // and no read-side dedup — so a pdg-gated delete (literal TAINT_PATH
  // mirroring) would append without deleting on every non-pdg incremental
  // run: N runs = N copies of every INJECTS row. This test is the assertion
  // that catches exactly that mistake.
  it('incremental runs neither strand nor duplicate INJECTS edges (delete-all is not pdg-gated) (#2200)', async () => {
    const repo = await setupMiniRepo();
    try {
      const src = path.join(repo.dbPath, 'src');
      for (const [name, content] of JAVA_DI_FIXTURE) {
        await writeFile(path.join(src, name), content, 'utf-8');
      }
      gitCommitAll(repo.dbPath, 'add java di fixture');

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

      // Full index: Consumer.foos fans out to the two IFoo implementers.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      expect(await countInjects(repo.dbPath)).toBe(2);

      // Incremental run 1: comment-only touch of an UNRELATED file (none of
      // the Java DI files change), committed so lastCommit moves.
      const target = path.join(src, 'logger.ts');
      const beforeFirstTouch = await readFile(target, 'utf-8');
      await writeFile(target, beforeFirstTouch + '\n// di idempotency touch 1\n', 'utf-8');
      gitCommitAll(repo.dbPath, 'unrelated touch 1');
      const run1 = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      expect(run1.alreadyUpToDate).toBeUndefined();
      expect(await countInjects(repo.dbPath)).toBe(2);

      // Incremental run 2: second unrelated touch. A gated delete would have
      // appended two more rows per writeback (4 by now) — must still be 2.
      const beforeSecondTouch = await readFile(target, 'utf-8');
      await writeFile(target, beforeSecondTouch + '\n// di idempotency touch 2\n', 'utf-8');
      gitCommitAll(repo.dbPath, 'unrelated touch 2');
      const run2 = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {} },
      );
      expect(run2.alreadyUpToDate).toBeUndefined();
      expect(await countInjects(repo.dbPath)).toBe(2);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);
});
