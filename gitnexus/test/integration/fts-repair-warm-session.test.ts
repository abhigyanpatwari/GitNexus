/**
 * Integration test for issue #2767: the MCP `query` tool reported "FTS
 * indexes missing" against an index the CLI could search successfully,
 * because a long-lived MCP session's pooled read-only connection had no
 * reliable signal that `gitnexus analyze --repair-fts` changed FTS
 * availability (repair-fts intentionally never restamps `indexedAt`).
 *
 * Everything real: a real writable LadybugDB session builds the initial
 * index WITHOUT FTS (the exact shape implied by the original report — FTS
 * built later), a real `LocalBackend` resolves it via the real registry and
 * issues a real `query` tool call through the real connection pool, then a
 * SEPARATE real writable session performs the repair (real
 * `createSearchFTSIndexes`, real `saveMeta` capability stamp — the same
 * production functions `--repair-fts` calls), and the SAME still-warm
 * `LocalBackend` instance re-queries without any restart.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createTempDir } from '../helpers/test-db.js';
import { resolveAnalyzeInstallPolicy } from '../../src/core/lbug/extension-loader.js';
import {
  getStoragePaths,
  registerRepo,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { closeLbug as poolClose } from '../../src/core/lbug/pool-adapter.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const REQUIRE_FTS = process.env.GITNEXUS_REQUIRE_FTS === '1';

type QueryResult = {
  error?: unknown;
  warning?: string;
  definitions?: Array<{ id: string }>;
  process_symbols?: Array<{ id: string }>;
};

const matchedIds = (r: QueryResult): string[] =>
  [...(r.process_symbols ?? []), ...(r.definitions ?? [])].map((s) => s.id);

const ftsMissing = (r: QueryResult): boolean =>
  typeof r.warning === 'string' && /FTS indexes missing/i.test(r.warning);

/**
 * Poll the SAME warm `LocalBackend` until it stops reporting FTS-missing, or
 * the deadline passes. Exercises the real 5s staleness-check throttle
 * (`ensureInitialized`) rather than sleeping-and-hoping or reaching into
 * backend internals to bypass it — proves the fix holds within the actual
 * production timing window.
 */
async function waitForFtsRecognized(
  backend: LocalBackend,
  query: string,
  // Production throttle is 5s (`lastStalenessCheck`); this deadline leaves a
  // generous margin beyond it for a loaded CI runner, per review feedback
  // that the original 7s deadline left only ~2s of slack (#2767).
  timeoutMs = 15000,
  intervalMs = 300,
): Promise<QueryResult> {
  const deadline = Date.now() + timeoutMs;
  let last: QueryResult;
  do {
    last = await backend.callTool('query', { query });
    if (!ftsMissing(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return last!;
}

describe('warm MCP session observes an in-place --repair-fts rebuild (#2767)', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let repoPath: string;
  let storagePath: string;
  let lbugPath: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gnx-fts-repair-warm-');
    repoPath = tmpHandle.dbPath;
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = path.join(repoPath, '.gitnexus-home');
    ({ storagePath, lbugPath } = getStoragePaths(repoPath));
  });

  afterEach(async () => {
    await poolClose(lbugPath).catch(() => {});
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHandle.cleanup();
  });

  it(
    'a warm session transitions from FTS-unavailable to FTS-available without restarting, after an out-of-band --repair-fts',
    { timeout: 60_000 },
    async (ctx) => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const { createSearchFTSIndexes } = await import('../../src/core/search/fts-indexes.js');

      // ── Step 1: build the index WITHOUT FTS (analyzed before repair) ────
      await adapter.initLbug(lbugPath);

      const ftsAvailable = await adapter.loadFTSExtension(undefined, {
        policy: resolveAnalyzeInstallPolicy(),
      });
      if (!ftsAvailable) {
        if (REQUIRE_FTS) {
          throw new Error(
            'FTS extension is required (GITNEXUS_REQUIRE_FTS=1) but could not be loaded — ' +
              'this FTS-dependent integration test must not be silently skipped in CI.',
          );
        }
        await adapter.closeLbug();
        ctx.skip();
        return;
      }

      await adapter.executeQuery(
        `CREATE (n:Function {id: 'func:login', name: 'login', filePath: 'src/auth.ts', startLine: 1, endLine: 3, content: 'function login() { return true; }'})`,
      );
      await adapter.flushWAL();
      await adapter.closeLbug();

      const indexedAt = new Date().toISOString();
      const baseMeta: RepoMeta = {
        repoPath,
        lastCommit: 'c1',
        indexedAt,
        stats: { files: 1, nodes: 1 },
        capabilities: {
          graph: { provider: 'ladybugdb', status: 'available' },
          fts: { provider: 'ladybugdb-fts', status: 'unavailable' },
          vectorSearch: { provider: 'exact-scan', status: 'unavailable', exactScanLimit: 0 },
        },
      };
      await saveMeta(storagePath, baseMeta);
      await registerRepo(repoPath, baseMeta, { name: 'test-repo' });

      // ── Step 2: a real warm LocalBackend observes "FTS unavailable" ─────
      const backend = new LocalBackend();
      await backend.init();
      const before = await backend.callTool('query', { query: 'login' });
      expect(before.error).toBeUndefined();
      expect(ftsMissing(before)).toBe(true);

      // ── Step 3: out-of-band --repair-fts (separate writable session) ────
      // Same production functions the repair-fts branch of runFullAnalysis
      // calls — real FTS build, then the #2767 capability-only meta stamp
      // (indexedAt/lastCommit deliberately unchanged, R4).
      await adapter.initLbug(lbugPath);
      await createSearchFTSIndexes();
      await adapter.flushWAL();
      await adapter.closeLbug();
      await saveMeta(storagePath, {
        ...baseMeta,
        capabilities: {
          ...baseMeta.capabilities!,
          fts: { provider: 'ladybugdb-fts', status: 'available' },
        },
      });

      // ── Step 4: the SAME still-warm backend re-queries — no restart ─────
      const after = await waitForFtsRecognized(backend, 'login');
      expect(after.error).toBeUndefined();
      expect(ftsMissing(after)).toBe(false);
      expect(matchedIds(after)).toContain('func:login');
    },
  );
});
