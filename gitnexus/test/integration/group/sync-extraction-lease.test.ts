/**
 * Group sync keeps each repo's LadybugDB pool entry leased while its contracts
 * are extracted.
 *
 * Extractors now yield to the event loop while they parse source files, so a
 * long, query-free parse phase is no longer one macrotask. Without a lease the
 * pool's idle sweep, or a concurrent caller opening more repos than the pool
 * holds, closes the repo in the middle of extraction. Every later graph query
 * then fails, and the extractors swallow that, so the sync loses its graph
 * enrichment without reporting an error.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CypherExecutor } from '../../../src/core/group/contract-extractor.js';
import type { GroupConfig, RepoHandle } from '../../../src/core/group/types.js';
import { withTestLbugDB } from '../../helpers/test-indexed-db.js';

const scenario = vi.hoisted(() => ({
  /** Runs inside the stub HTTP extractor between two graph queries. */
  quietPhase: async (): Promise<void> => {},
  outcome: '' as string,
}));

vi.mock('../../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    readRegistry: vi.fn(async () => []),
    readRegistryStrict: vi.fn(async () => []),
  };
});

// A stand-in for the HTTP extractor: query, a query-free phase that yields to
// the event loop (as the source-scan parse loops do), then query again.
vi.mock('../../../src/core/group/extractors/http-route-extractor.js', () => ({
  HttpRouteExtractor: class {
    async extract(executor: CypherExecutor) {
      await executor('RETURN 1 AS x');
      await scenario.quietPhase();
      try {
        await executor('RETURN 2 AS y');
        scenario.outcome = 'ok';
      } catch (err) {
        scenario.outcome = err instanceof Error ? err.message : String(err);
      }
      return [];
    }
  },
}));

const config = (): GroupConfig => ({
  version: 1,
  name: 'lease',
  description: '',
  repos: { 'app/backend': 'backend-repo' },
  links: [],
  packages: {},
  detect: {
    http: true,
    grpc: false,
    thrift: false,
    topics: false,
    includes: false,
    workspace_deps: false,
  },
  matching: {},
});

const yieldTurns = async (turns: number): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

withTestLbugDB('group-sync-extraction-lease', (handle) => {
  let groupDir: string;
  let repoDir: string;

  const repoHandle = (id: string): RepoHandle => ({
    id,
    path: repoDir,
    repoPath: repoDir,
    storagePath: path.dirname(handle.dbPath),
  });

  beforeEach(() => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-lease-group-'));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-lease-repo-'));
    scenario.outcome = '';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Closes every pool entry and stops the idle timer, so each case starts
    // with a fresh timer.
    const { closeLbug } = await import('../../../src/core/lbug/pool-adapter.js');
    await closeLbug();
    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('keeps the repo open when the idle sweep runs during a query-free phase', async () => {
    const realSetInterval = globalThis.setInterval;
    // The pool sweeps idle repos every 60 s; run that sweep every 10 ms instead.
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) =>
      realSetInterval(fn, ms === 60_000 ? 10 : ms)) as typeof setInterval);
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);

    scenario.quietPhase = async () => {
      // The parse phase has now run longer than the pool's 5 min idle timeout.
      skewMs = 6 * 60 * 1000;
      await yieldTurns(20);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    };

    const { syncGroup } = await import('../../../src/core/group/sync.js');
    const result = await syncGroup(config(), {
      groupDir,
      resolveRepoHandle: async () => repoHandle('lease-idle'),
    });

    expect(result.failedRepos).toEqual([]);
    expect(scenario.outcome).toBe('ok');
  });

  it('keeps the repo open when a concurrent caller fills the pool', async () => {
    const { initLbug } = await import('../../../src/core/lbug/pool-adapter.js');
    scenario.quietPhase = async () => {
      // Another caller (an MCP tool call, say) opens more repos than the pool
      // holds; each open evicts the least recently used unleased entry.
      for (let i = 0; i < 6; i++) {
        await initLbug(`lease-other-${i}`, handle.dbPath);
        await yieldTurns(1);
      }
    };

    const { syncGroup } = await import('../../../src/core/group/sync.js');
    const result = await syncGroup(config(), {
      groupDir,
      resolveRepoHandle: async () => repoHandle('lease-lru'),
    });

    expect(result.failedRepos).toEqual([]);
    expect(scenario.outcome).toBe('ok');
  });
});
