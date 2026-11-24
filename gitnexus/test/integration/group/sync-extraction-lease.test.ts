/**
 * Group sync keeps each repo's LadybugDB pool entry leased while its contracts
 * are extracted, by every extractor of that repo.
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
import {
  closeLbug as closeCoreLbug,
  initLbug as initCoreLbug,
} from '../../../src/core/lbug/lbug-adapter.js';
import { withTestLbugDB } from '../../helpers/test-indexed-db.js';

type StubKind = 'http' | 'grpc' | 'thrift' | 'topic' | 'include';

const scenario = vi.hoisted(() => ({
  /** Which stub extractor runs `quietPhase` between its two graph queries. */
  quietIn: 'http' as 'http' | 'grpc' | 'thrift' | 'topic' | 'include',
  quietPhase: async (): Promise<void> => {},
  /** Outcome of each stub's second query: 'ok' or the error message. */
  outcome: {} as Record<string, string>,
}));

/** Query, maybe a query-free phase that yields (as the parse loops do), query again. */
async function stubExtract(kind: StubKind, executor: CypherExecutor) {
  await executor('RETURN 1 AS x');
  if (scenario.quietIn === kind) await scenario.quietPhase();
  try {
    await executor('RETURN 2 AS y');
    scenario.outcome[kind] = 'ok';
  } catch (err) {
    scenario.outcome[kind] = err instanceof Error ? err.message : String(err);
  }
  return [];
}

vi.mock('../../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    readRegistry: vi.fn(async () => []),
    readRegistryStrict: vi.fn(async () => []),
  };
});

vi.mock('../../../src/core/group/extractors/http-route-extractor.js', () => ({
  HttpRouteExtractor: class {
    extract = (executor: CypherExecutor) => stubExtract('http', executor);
  },
}));

// The other extractors run after HTTP in a sync, include last: the lease must
// still be held in each of them.
vi.mock('../../../src/core/group/extractors/grpc-extractor.js', () => ({
  GrpcExtractor: class {
    extract = (executor: CypherExecutor) => stubExtract('grpc', executor);
  },
}));
vi.mock('../../../src/core/group/extractors/thrift-extractor.js', () => ({
  ThriftExtractor: class {
    extract = (executor: CypherExecutor) => stubExtract('thrift', executor);
  },
}));
vi.mock('../../../src/core/group/extractors/topic-extractor.js', () => ({
  TopicExtractor: class {
    extract = (executor: CypherExecutor) => stubExtract('topic', executor);
  },
}));
vi.mock('../../../src/core/group/extractors/include-extractor.js', () => ({
  IncludeExtractor: class {
    extract = (executor: CypherExecutor) => stubExtract('include', executor);
  },
}));

const ALL_OK = { http: 'ok', grpc: 'ok', thrift: 'ok', topic: 'ok', include: 'ok' };

const config = (): GroupConfig => ({
  version: 1,
  name: 'lease',
  description: '',
  repos: { 'app/backend': 'backend-repo' },
  links: [],
  packages: {},
  detect: {
    http: true,
    grpc: true,
    thrift: true,
    topics: true,
    includes: true,
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

  beforeEach(async () => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-lease-group-'));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-lease-repo-'));
    scenario.quietIn = 'http';
    scenario.outcome = {};
    // Release the helper's writable handle first: the pool opens the same file,
    // and on Windows a writable and a read-only handle cannot share a path.
    await closeCoreLbug();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Closes every pool entry and stops the idle timer, so each case starts
    // with a fresh timer.
    const { closeLbug } = await import('../../../src/core/lbug/pool-adapter.js');
    await closeLbug();
    // Reopen the helper's handle for its own cleanup.
    await initCoreLbug(handle.dbPath);
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
    const pool = await import('../../../src/core/lbug/pool-adapter.js');
    // Control: an unleased entry the same sweep must close. Without it this
    // case would also pass if the shortened sweep never ran.
    await pool.initLbug('lease-control', handle.dbPath);
    let controlSwept = false;

    scenario.quietPhase = async () => {
      // The parse phase has now run longer than the pool's 5 min idle timeout.
      skewMs = 6 * 60 * 1000;
      await yieldTurns(20);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      controlSwept = !pool.isLbugReady('lease-control');
    };

    const { syncGroup } = await import('../../../src/core/group/sync.js');
    const result = await syncGroup(config(), {
      groupDir,
      resolveRepoHandle: async () => repoHandle('lease-idle'),
    });

    expect(controlSwept).toBe(true);
    expect(result.failedRepos).toEqual([]);
    expect(scenario.outcome).toEqual(ALL_OK);
  });

  it.each(['http', 'grpc', 'thrift', 'topic', 'include'] as const)(
    'keeps the repo open when a concurrent caller fills the pool during the %s extractor',
    async (kind) => {
      const { initLbug } = await import('../../../src/core/lbug/pool-adapter.js');
      scenario.quietIn = kind;
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
        resolveRepoHandle: async () => repoHandle(`lease-lru-${kind}`),
      });

      expect(result.failedRepos).toEqual([]);
      expect(scenario.outcome).toEqual(ALL_OK);
    },
  );
});
