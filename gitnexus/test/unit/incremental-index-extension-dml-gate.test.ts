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
 */
import { readFile, writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { seedEmbeddingsForFiles } from '../helpers/embedding-seed.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';
import { FTS_INDEXES } from '../../src/core/search/fts-schema.js';
import { resolveAnalyzeInstallPolicy } from '../../src/core/lbug/extension-loader.js';

const ftsMustBeAvailable = process.env.GITNEXUS_REQUIRE_FTS === '1';

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

/** Append a line to a mini-repo file and commit it — a one-file write set. */
const touchAndCommit = async (repoPath: string, marker: string): Promise<void> => {
  const handlerPath = path.join(repoPath, 'src', 'handler.ts');
  await writeFile(
    handlerPath,
    (await readFile(handlerPath, 'utf-8')) + `\n// ${marker}\n`,
    'utf-8',
  );
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

describe('runFullAnalysis incremental writeback — extension-gated DML decided before any DML (#2841)', () => {
  let ftsAvailable = true;
  let skipWarned = false;

  beforeAll(async () => {
    const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
    // Cheap standalone probe, matching the #2589/#2623 suites: settle
    // availability once, up front, not inside the expensive test body.
    const probe = await createTempDir('gitnexus-2841-fts-probe-');
    try {
      await lbugAdapter.initLbug(probe.dbPath);
      ftsAvailable = await lbugAdapter.loadFTSExtension(undefined, {
        policy: resolveAnalyzeInstallPolicy(),
      });
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

  it('escalates to a full DB write instead of crashing when the DB carries FTS indexes and FTS cannot be loaded', async () => {
    const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
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
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
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
      await lbugAdapter.initLbug(lbugPath);
      try {
        const files = (await lbugAdapter.executeQuery(
          `MATCH (f:File) WHERE f.filePath = 'src/handler.ts' RETURN f.content AS content`,
        )) as Array<{ content: string }>;
        expect(files.length).toBe(1);
        expect(String(files[0]?.content)).toContain('#2841 blocked-path touch');
      } finally {
        await lbugAdapter.closeLbug();
      }
    } finally {
      if (previousPolicy === undefined) delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      else process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = previousPolicy;
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
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
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
    } finally {
      if (previousPolicy === undefined) delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      else process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = previousPolicy;
      await repo.cleanup();
    }
  }, 300_000);

  it('names every blocked extension when both FTS and VECTOR gate the write', async () => {
    const lbugAdapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const repo = await setupMiniRepo('gitnexus-2841-both-blocked-');
    const previousPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    try {
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo.dbPath);

      // POSIX literal for the graph-side path: filePaths are stored with
      // forward slashes on every OS (see the note in the #2623 suite).
      const seeded = await seedEmbeddingsForFiles(repo.dbPath, ['src/handler.ts'], 2);
      expect((seeded.get('src/handler.ts') ?? []).length).toBeGreaterThan(0);
      await lbugAdapter.initLbug(lbugPath);
      const vectorIndexBuilt = await lbugAdapter.createVectorIndex();
      await lbugAdapter.closeLbug();
      expect(vectorIndexBuilt).toBe(true);
      expect((await readFtsIndexRows(lbugPath)).length).toBe(FTS_INDEXES.length);

      await touchAndCommit(repo.dbPath, '#2841 both-blocked touch');

      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
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
    } finally {
      if (previousPolicy === undefined) delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      else process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = previousPolicy;
      await repo.cleanup();
    }
  }, 300_000);
});
