/**
 * #2841: an incremental writeback must decide whether row-level DML is even
 * legal BEFORE it mutates a row. LadybugDB refuses every write to a table
 * carrying an FTS index while the FTS extension is unloaded — at BIND time, so
 * a DETACH DELETE matching zero rows fails exactly as hard as one matching
 * thousands:
 *
 *   Binder exception: Trying to delete from an index on table File but its
 *   extension is not loaded.
 *
 * and the indexes cannot be cleared in place either (`DROP_FTS_INDEX` is itself
 * an FTS-extension function; LadybugDB has no SQL `DROP INDEX`). So a DB that
 * carries FTS indexes on a machine where the extension stopped loading used to
 * kill every incremental analyze mid-writeback, with an engine message that
 * never mentions FTS.
 *
 * The fix mirrors the VECTOR gate (#2623): probe the index catalog first, load
 * FTS with the analyze policy only when an index actually gates DML, and fall
 * through to the escalation valve's wipe-and-bulk-COPY plan when it cannot be
 * loaded. The VECTOR half of that behaviour is covered by
 * `incremental-vector-extension-ordering.test.ts`; this suite covers the FTS
 * half plus the both-extensions-blocked case, where the reason log has to name
 * both causes rather than only the first one checked.
 *
 * The escalation is a valve, not a wipe switch, so three of its consequences
 * are pinned here as well:
 *   - it must NOT rescue embeddings on the one run whose purpose is to destroy
 *     them (`--drop-embeddings`, review H1) — and must rescue them on every
 *     other forced rebuild (the complement, asserted in the both-blocked case);
 *   - it must be ONE-SHOT: the next run on a machine where FTS loads again goes
 *     back to surgery and rebuilds the search indexes, rather than escalating
 *     forever;
 *   - an extension-forced rebuild is environmental, not repo churn, so it builds
 *     into a staging file beside the live index and publishes it with one rename
 *     (review H2) — an interrupted rebuild must leave the current index intact.
 */
import { readFile, readdir, writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { seedEmbeddingsForFiles } from '../helpers/embedding-seed.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';
import { FTS_INDEXES } from '../../src/core/search/fts-schema.js';
import { EMBEDDING_TABLE_NAME } from '../../src/core/lbug/schema.js';
import { resolveAnalyzeInstallPolicy } from '../../src/core/lbug/extension-loader.js';

const ftsMustBeAvailable = process.env.GITNEXUS_REQUIRE_FTS === '1';
const vectorMustBeAvailable = process.env.GITNEXUS_REQUIRE_VECTOR === '1';

const commitAll = (cwd: string, message: string): void => {
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
 * Append a line to a mini-repo file and commit it — a one-file write set.
 * `relPath` is POSIX-joined for the graph side but filesystem-joined for the
 * write, so callers can target a file the NEXT run will not touch.
 */
const touchAndCommit = async (
  repoPath: string,
  marker: string,
  relPath = 'src/handler.ts',
): Promise<void> => {
  const filePath = path.join(repoPath, ...relPath.split('/'));
  await writeFile(filePath, (await readFile(filePath, 'utf-8')) + `\n// ${marker}\n`, 'utf-8');
  commitAll(repoPath, marker);
};

const readFtsIndexRows = async (lbugPath: string): Promise<Array<Record<string, unknown>>> => {
  const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
  await lbugAdapter.initLbug(lbugPath);
  try {
    const rows = (await lbugAdapter.executeQuery('CALL SHOW_INDEXES() RETURN *')) as Array<
      Record<string, unknown>
    >;
    return rows.filter((r) => r.index_type === 'FTS');
  } finally {
    await lbugAdapter.closeLbug();
  }
};

/** Every File node in the published graph, as rows (duplicates stay visible). */
const readGraphFileRows = async (
  lbugPath: string,
): Promise<Array<{ filePath: string; content: string }>> => {
  const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
  await lbugAdapter.initLbug(lbugPath);
  try {
    const rows = (await lbugAdapter.executeQuery(
      `MATCH (f:File) RETURN f.filePath AS filePath, f.content AS content`,
    )) as Array<{ filePath: string; content: string }>;
    return rows.map((r) => ({ filePath: String(r.filePath), content: String(r.content) }));
  } finally {
    await lbugAdapter.closeLbug();
  }
};

const contentsByPath = (
  rows: ReadonlyArray<{ filePath: string; content: string }>,
): Map<string, string> => new Map(rows.map((r) => [r.filePath, r.content]));

/** Surviving CodeEmbedding nodeIds, read straight from the published DB. */
const readEmbeddingRows = async (lbugPath: string): Promise<string[]> => {
  const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
  await lbugAdapter.initLbug(lbugPath);
  try {
    const rows = (await lbugAdapter.executeQuery(
      `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId`,
    )) as Array<{ nodeId: string }>;
    return rows.map((r) => String(r.nodeId));
  } finally {
    await lbugAdapter.closeLbug();
  }
};

/** `count(e)` straight from the engine — the H1 wipe has to be proven at zero. */
const countEmbeddingRows = async (lbugPath: string): Promise<number> => {
  const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
  await lbugAdapter.initLbug(lbugPath);
  try {
    const rows = (await lbugAdapter.executeQuery(
      `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS total`,
    )) as Array<{ total: number | bigint }>;
    expect(rows.length).toBe(1);
    return Number(rows[0]?.total);
  } finally {
    await lbugAdapter.closeLbug();
  }
};

/** Staging builds sit beside the live index as `lbug.staging.<uuid>` (#2658). */
const readStagingEntries = async (storagePath: string): Promise<string[]> =>
  (await readdir(storagePath)).filter((name) => name.includes('.staging.'));

/**
 * Make every optional extension unloadable for the next run. The env policy is
 * what actually blocks the load (`ExtensionManager.ensure` short-circuits on
 * `'never'` before it consults any cache); `resetExtensionState()` clears the
 * process-wide capability/install memo so the run reports its own verdict
 * rather than one an earlier test in this file settled.
 */
const blockExtensionLoads = async (): Promise<void> => {
  process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
  const { resetExtensionState } = await import('../../src/core/lbug/extension-loader.js');
  resetExtensionState();
};

const restoreExtensionPolicy = async (previous: string | undefined): Promise<void> => {
  if (previous === undefined) delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
  else process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = previous;
  const { resetExtensionState } = await import('../../src/core/lbug/extension-loader.js');
  resetExtensionState();
};

describe('runFullAnalysis incremental writeback — extension-gated DML decided before any DML (#2841)', () => {
  let ftsAvailable = true;
  let vectorAvailable = true;
  let skipWarned = false;
  let vectorSkipWarned = false;

  beforeAll(async () => {
    const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
    // Cheap standalone probe, matching the #2589/#2623 suites: settle
    // availability once, up front, not inside the expensive test body. BOTH
    // extensions are probed on the one throwaway connection (review H6): the
    // both-blocked case builds a REAL HNSW index and asserts it was built, so
    // gating that case on the FTS probe alone made a hard assertion fail on
    // every host that has FTS but not VECTOR.
    const probe = await createTempDir('gitnexus-2841-extension-probe-');
    try {
      await lbugAdapter.initLbug(probe.dbPath);
      const policy = resolveAnalyzeInstallPolicy();
      ftsAvailable = await lbugAdapter.loadFTSExtension(undefined, { policy });
      vectorAvailable = await lbugAdapter.loadVectorExtension(undefined, { policy });
    } finally {
      await lbugAdapter.closeLbug();
      await probe.cleanup();
    }
  }, 120_000);

  // Skip VISIBLY: a silent `return` would report a false pass and hide the
  // regression in exactly the environments least likely to notice.
  beforeEach((ctx) => {
    if (!ftsAvailable) {
      if (ftsMustBeAvailable) {
        throw new Error(
          'GITNEXUS_REQUIRE_FTS=1 but the FTS extension is unavailable — cannot verify the #2841 gate.',
        );
      }
      if (!skipWarned) {
        skipWarned = true;
        console.warn(
          '[incremental-index-extension-dml-gate] Skipping — the LadybugDB FTS extension is unavailable.',
        );
      }
      ctx.skip();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Per-test VECTOR gate (review H6). Only the both-blocked case needs VECTOR;
   * the other cases must keep running on an FTS-only host, so this is called
   * from that one test body instead of widening the suite-level `beforeEach`.
   * Same visibility contract as the FTS gate: a real skip, and a hard failure
   * under `GITNEXUS_REQUIRE_VECTOR=1`.
   */
  const skipUnlessVectorAvailable = (ctx: TestContext): void => {
    if (vectorAvailable) return;
    if (vectorMustBeAvailable) {
      throw new Error(
        'GITNEXUS_REQUIRE_VECTOR=1 but the VECTOR extension is unavailable — cannot verify the #2841 both-blocked escalation.',
      );
    }
    if (!vectorSkipWarned) {
      vectorSkipWarned = true;
      console.warn(
        '[incremental-index-extension-dml-gate] Skipping the both-blocked case — the LadybugDB VECTOR extension is unavailable.',
      );
    }
    ctx.skip();
  };

  it('escalates to a full DB write instead of crashing when the DB carries FTS indexes and FTS cannot be loaded', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const repo = await setupMiniRepo('gitnexus-2841-fts-blocked-');
    const previousPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    try {
      // Run 1 builds the graph WITH FTS available, so the DB ends up carrying
      // the real index set — the precondition the issue reports.
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo.dbPath);
      expect((await readFtsIndexRows(lbugPath)).length).toBe(FTS_INDEXES.length);

      await touchAndCommit(repo.dbPath, '#2841 blocked-path touch');

      // FTS becomes unloadable for this run. Pre-fix this rejects with
      // "Trying to delete from an index on table File but its extension is not
      // loaded" — the run dies mid-writeback.
      await blockExtensionLoads();
      const logs: string[] = [];
      await expect(
        runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true },
          { onProgress: () => {}, onLog: (m: string) => logs.push(m) },
        ),
      ).resolves.toBeDefined();

      // The reason must be stated in FTS terms before the plan switches — the
      // whole issue is that the crash named no extension at all.
      expect(logs.some((m) => m.includes('full DB write'))).toBe(true);
      expect(logs.some((m) => m.includes('FTS'))).toBe(true);

      // The rebuild really happened: the wiped DB carries no FTS index (they
      // cannot be recreated without the extension), and the newly committed
      // content is in the graph.
      expect((await readFtsIndexRows(lbugPath)).length).toBe(0);
      const fileRows = await readGraphFileRows(lbugPath);
      expect(fileRows.filter((r) => r.filePath === 'src/handler.ts').length).toBe(1);
      expect(contentsByPath(fileRows).get('src/handler.ts')).toContain('#2841 blocked-path touch');
    } finally {
      await restoreExtensionPolicy(previousPolicy);
      await repo.cleanup();
    }
  }, 300_000);

  it('keeps the surgical write plan (and the indexes) when FTS is available', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const repo = await setupMiniRepo('gitnexus-2841-fts-available-');
    try {
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      await touchAndCommit(repo.dbPath, '#2841 healthy-path touch');

      const logs: string[] = [];
      await expect(
        runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true },
          { onProgress: () => {}, onLog: (m: string) => logs.push(m) },
        ),
      ).resolves.toBeDefined();

      // No escalation: a one-file write set on a 7-file repo stays surgical,
      // and the gate must not manufacture a rebuild when FTS loads fine.
      expect(logs.some((m) => m.includes('full DB write'))).toBe(false);
      const { lbugPath } = getStoragePaths(repo.dbPath);
      expect((await readFtsIndexRows(lbugPath)).length).toBe(FTS_INDEXES.length);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('does not escalate — or touch the extension machinery — when the DB never carried FTS indexes', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const repo = await setupMiniRepo('gitnexus-2841-fts-never-built-');
    const previousPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    try {
      // Both runs are FTS-less, so no index is ever created. The catalog-first
      // check must settle this without gating the surgical plan — otherwise
      // every incremental analyze on an FTS-less machine would become a full
      // rebuild.
      await blockExtensionLoads();
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo.dbPath);
      expect((await readFtsIndexRows(lbugPath)).length).toBe(0);

      await touchAndCommit(repo.dbPath, '#2841 never-built touch');

      const logs: string[] = [];
      await expect(
        runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true },
          { onProgress: () => {}, onLog: (m: string) => logs.push(m) },
        ),
      ).resolves.toBeDefined();
      expect(logs.some((m) => m.includes('full DB write'))).toBe(false);

      // Test gap 7: "no escalation log" alone would also pass if the surgical
      // write silently did nothing. Prove the write actually landed — the same
      // File.content check the blocked-path case makes. REVERSION: make
      // `ensureFtsRowDmlSafe` fall OPEN on an index row whose type cannot be
      // read (`indexType === undefined || indexType === 'FTS'` → `=== 'FTS'`,
      // review §6.A) and this file still has no FTS index, so the no-escalation
      // half keeps passing while a genuinely blocked DML would reach the engine.
      const contents = contentsByPath(await readGraphFileRows(lbugPath));
      expect(contents.get('src/handler.ts')).toContain('#2841 never-built touch');
    } finally {
      await restoreExtensionPolicy(previousPolicy);
      await repo.cleanup();
    }
  }, 300_000);

  it('names every blocked extension when both FTS and VECTOR gate the write', async (ctx) => {
    skipUnlessVectorAvailable(ctx);
    const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const repo = await setupMiniRepo('gitnexus-2841-both-blocked-');
    const previousPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    try {
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo.dbPath);

      // POSIX literal for the graph-side path: filePaths are stored with
      // forward slashes on every OS (see the note in the #2623 suite).
      // Deliberately NOT stampEmbeddingCount: meta reports zero embeddings
      // while the DB holds these rows, which is exactly the state the forced
      // rebuild's rescue read exists for.
      const seeded = await seedEmbeddingsForFiles(repo.dbPath, ['src/handler.ts'], 2);
      const seededIds = seeded.get('src/handler.ts') ?? [];
      expect(seededIds.length).toBeGreaterThan(0);
      await lbugAdapter.initLbug(lbugPath);
      const vectorIndexBuilt = await lbugAdapter.createVectorIndex();
      await lbugAdapter.closeLbug();
      // Hard assertion, not an environment gap: `skipUnlessVectorAvailable`
      // above already proved VECTOR loads on this host (review H6).
      expect(vectorIndexBuilt).toBe(true);
      expect((await readFtsIndexRows(lbugPath)).length).toBe(FTS_INDEXES.length);

      await touchAndCommit(repo.dbPath, '#2841 both-blocked touch');

      await blockExtensionLoads();
      const logs: string[] = [];
      await expect(
        runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true },
          { onProgress: () => {}, onLog: (m: string) => logs.push(m) },
        ),
      ).resolves.toBeDefined();

      // One escalation, both causes named. Reporting only the first checked
      // extension is how a half-diagnosed failure survives a bug report.
      const escalation = logs.filter((m) => m.includes('full DB write'));
      expect(escalation.length).toBe(1);
      expect(escalation[0]).toContain('FTS');
      expect(escalation[0]).toContain('VECTOR');

      // Test gap 5 — the COMPLEMENT of the `--drop-embeddings` case below: this
      // run never asked to touch embeddings, so the wipe must not eat the rows
      // meta failed to account for. REVERSION: delete the
      // `if (extensionForcedRebuild && !options.dropEmbeddings &&
      // cachedEmbeddings.length === 0)` rescue in run-analyze.ts and every
      // seeded row is destroyed by a rebuild the operator did not ask for,
      // while the run still exits 0.
      const surviving = await readEmbeddingRows(lbugPath);
      const survivingIds = new Set(surviving);
      for (const id of seededIds) {
        expect(survivingIds.has(id)).toBe(true);
      }
      // …and exactly once each — the restore must not double-insert.
      expect(surviving.length).toBe(survivingIds.size);
      expect(logs.some((m) => m.includes('Preserving'))).toBe(true);
    } finally {
      await restoreExtensionPolicy(previousPolicy);
      await repo.cleanup();
    }
  }, 300_000);

  it('lets --drop-embeddings wipe unaccounted embeddings instead of rescuing them (review H1)', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const repo = await setupMiniRepo('gitnexus-2841-drop-embeddings-');
    const previousPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    try {
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo.dbPath);
      expect((await readFtsIndexRows(lbugPath)).length).toBe(FTS_INDEXES.length);

      // Real rows and NO stampEmbeddingCount, so meta reports zero embeddings
      // while the DB holds these — the exact trigger state for the forced
      // rebuild's rescue read. `--drop-embeddings` leaves `cachedEmbeddings`
      // empty by construction (`deriveEmbeddingMode` returns
      // `shouldLoadCache: false`), and without a checkpoint the run stays
      // incremental, so it arrives at the gate looking precisely like the case
      // the rescue was written for.
      const seeded = await seedEmbeddingsForFiles(repo.dbPath, ['src/handler.ts'], 2);
      expect((seeded.get('src/handler.ts') ?? []).length).toBeGreaterThan(0);

      await touchAndCommit(repo.dbPath, '#2841 drop-embeddings touch');
      await blockExtensionLoads();

      const logs: string[] = [];
      await expect(
        runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true, dropEmbeddings: true },
          { onProgress: () => {}, onLog: (m: string) => logs.push(m) },
        ),
      ).resolves.toBeDefined();

      // The FTS block still forces the rebuild — this is the same escalation,
      // reached with the one flag whose entire purpose is to destroy the rows
      // the rescue would restore.
      expect(logs.some((m) => m.includes('full DB write'))).toBe(true);
      // REVERSION: drop `!options.dropEmbeddings` from the rescue predicate in
      // run-analyze.ts (`if (extensionForcedRebuild && !options.dropEmbeddings
      // && cachedEmbeddings.length === 0)`) and the rescue reads the rows back
      // out of the DB, logs `Preserving N embedding row(s) across the forced
      // rebuild` on top of this run's own drop, and Phase 3.5 re-inserts every
      // one of them — `--drop-embeddings` silently becomes a no-op.
      expect(logs.some((m) => m.includes('Preserving'))).toBe(false);
      expect(await countEmbeddingRows(lbugPath)).toBe(0);
    } finally {
      await restoreExtensionPolicy(previousPolicy);
      await repo.cleanup();
    }
  }, 300_000);

  it('escalates once: the next run on a healthy host goes back to surgery and rebuilds the FTS indexes', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const repo = await setupMiniRepo('gitnexus-2841-one-shot-');
    const previousPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    try {
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo.dbPath);
      expect((await readFtsIndexRows(lbugPath)).length).toBe(FTS_INDEXES.length);

      // Run 2: FTS blocked → the forced rebuild, which leaves a DB with no FTS
      // index at all and stamps `capabilities.fts.status = 'unavailable'`.
      await touchAndCommit(repo.dbPath, '#2841 one-shot escalated touch');
      await blockExtensionLoads();
      const escalatedLogs: string[] = [];
      await expect(
        runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true },
          { onProgress: () => {}, onLog: (m: string) => escalatedLogs.push(m) },
        ),
      ).resolves.toBeDefined();
      expect(escalatedLogs.some((m) => m.includes('full DB write'))).toBe(true);
      expect((await readFtsIndexRows(lbugPath)).length).toBe(0);

      // Run 3: FTS loads again and a DIFFERENT file changes. Nothing may carry
      // the escalation forward — the catalog-first gate sees no FTS index, so
      // the surgical plan stands, and Phase 3 rebuilds the whole index set.
      await restoreExtensionPolicy(previousPolicy);
      await touchAndCommit(repo.dbPath, '#2841 one-shot healed touch', 'src/validator.ts');
      const healedLogs: string[] = [];
      await expect(
        runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true },
          { onProgress: () => {}, onLog: (m: string) => healedLogs.push(m) },
        ),
      ).resolves.toBeDefined();

      // The property that makes the whole design a one-shot rebuild rather than
      // a permanent regression: no second escalation, and keyword search is
      // whole again. REVERSION: make the extension-forced escalation sticky
      // (e.g. keep escalating while `capabilities.fts.status === 'unavailable'`,
      // or have `ensureFtsRowDmlSafe` answer from that stamp instead of the
      // catalog) and this run escalates again, forever.
      expect(healedLogs.some((m) => m.includes('full DB write'))).toBe(false);
      expect((await readFtsIndexRows(lbugPath)).length).toBe(FTS_INDEXES.length);

      // Run 2's work survived into run 3's surgical write — i.e. the escalated
      // rebuild was really published at the canonical path, not left behind in
      // a staging file (review H2). handler.ts is untouched by run 3, so its
      // marker can only come from the run that escalated.
      const contents = contentsByPath(await readGraphFileRows(lbugPath));
      expect(contents.get('src/handler.ts')).toContain('#2841 one-shot escalated touch');
      expect(contents.get('src/validator.ts')).toContain('#2841 one-shot healed touch');
    } finally {
      await restoreExtensionPolicy(previousPolicy);
      await repo.cleanup();
    }
  }, 300_000);

  it('builds an extension-forced rebuild into a staging file and swaps it in (review H2)', async () => {
    const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const repo = await setupMiniRepo('gitnexus-2841-staged-rebuild-');
    const previousPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    try {
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { lbugPath, storagePath } = getStoragePaths(repo.dbPath);
      expect((await readFtsIndexRows(lbugPath)).length).toBe(FTS_INDEXES.length);
      // Run 1 was a full rebuild, which always stages — so any staging entry
      // observed below belongs to the escalated run, not to a leftover.
      expect(await readStagingEntries(storagePath)).toEqual([]);

      await touchAndCommit(repo.dbPath, '#2841 staged-rebuild touch');
      await blockExtensionLoads();

      // Observe the build target at the exact moment the full graph is COPYed
      // in. The escalated run reaches `loadGraphToLbug` immediately after
      // `wipeLbugDbFiles(buildPath)` + `initLbug(buildPath)`, so the presence
      // of a `lbug.staging.<uuid>` file there IS the build target.
      let stagingDuringBuild: string[] | undefined;
      const originalLoadGraphToLbug = lbugAdapter.loadGraphToLbug;
      vi.spyOn(lbugAdapter, 'loadGraphToLbug').mockImplementation(
        async (...args: Parameters<typeof originalLoadGraphToLbug>) => {
          stagingDuringBuild ??= await readStagingEntries(storagePath);
          return originalLoadGraphToLbug(...args);
        },
      );

      const logs: string[] = [];
      await expect(
        runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true },
          { onProgress: () => {}, onLog: (m: string) => logs.push(m) },
        ),
      ).resolves.toBeDefined();
      expect(logs.some((m) => m.includes('full DB write'))).toBe(true);

      // REVERSION: delete the `if (!useAtomicSwap && (posixSwap ||
      // windowsSwapOk)) { useAtomicSwap = true; buildPath =
      // `${lbugPath}.staging.${randomUUID()}` }` block in run-analyze.ts and
      // `buildPath` stays the LIVE `lbug` file — frozen ~440 lines earlier while
      // the run was still classified incremental — so the wipe destroys the only
      // complete index before the COPY starts and this list is empty.
      expect(stagingDuringBuild).toBeDefined();
      const observedStaging = stagingDuringBuild ?? [];
      expect(observedStaging.length).toBeGreaterThan(0);
      expect(observedStaging.every((name) => name.startsWith('lbug.staging.'))).toBe(true);

      // Published, not orphaned: the rename put the rebuild at the canonical
      // path, nothing `.staging.` is left beside it, and the live index answers
      // a query carrying this run's content.
      expect(await readStagingEntries(storagePath)).toEqual([]);
      const contents = contentsByPath(await readGraphFileRows(lbugPath));
      expect(contents.get('src/handler.ts')).toContain('#2841 staged-rebuild touch');
    } finally {
      await restoreExtensionPolicy(previousPolicy);
      await repo.cleanup();
    }
  }, 300_000);
});
