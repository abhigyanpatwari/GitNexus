/**
 * E2E Integration Test: impacted_endpoints — #21 Single-Repo Scope Guard
 *
 * Pins the cross-repo guard added in PR #99 (commit 008b7c4) at
 * local-backend.ts:391-395. The guard suppresses auto-expansion to
 * consumer repos when the caller pins `repo=`, so the response shape
 * is the single-repo shape and contains no leakage from other repos.
 *
 * Guard contract (single-repo path):
 *   1. `expandToConsumers` is never called.
 *   2. `callToolMultiRepo` is never reached.
 *   3. Result has no `errors` field (unique to the multi-repo aggregator).
 *   4. summary.changed_files / changed_symbols / impacted_endpoints are
 *      single-key Records keyed only by the pinned repo.
 *   5. No endpoint in any tier carries a `_repoId` attribution.
 *
 * Regression signal: if the guard fails, `findConsumers` is called,
 * `callToolMultiRepo` is reached, the multi-repo aggregator runs, and
 * the response shape changes — `errors` appears, every endpoint gets
 * `_repoId`, and `summary.changed_files` gains the consumer's key.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import {
  IMPACTED_ENDPOINTS_CROSS_REPO_COMBINED_SEED,
  IMPACTED_ENDPOINTS_FTS_INDEXES,
} from '../fixtures/impacted-endpoints-seed.js';

/**
 * Minimal shape of an endpoint entry the test reads. Only fields this
 * test actually touches are named; the index signature keeps
 * forward-compat with the runtime shape (handlers, controllers, file
 * path, etc.).
 */
interface EndpointImpact {
  method: string;
  path: string;
  _repoId?: string;
  [k: string]: unknown;
}

/**
 * Narrow structural type for the cross-repo registry fields that this
 * test inspects/spies on. The real field is `private` on LocalBackend,
 * so the test must widen visibility through `as unknown as`; the
 * surface here matches only what the test actually touches.
 */
interface CrossRepoRegistryLike {
  isInitialized: () => boolean;
  isLoaded: () => boolean;
  findConsumers: (repoId: string) => string[];
  findDepRepo: (packagePrefix: string) => string | null;
  listRepos: () => Array<{ repoId: string; manifest: unknown }>;
  clear: () => void;
}

/**
 * Narrow structural type for the LocalBackend surface this test pokes
 * into. The real fields/methods are `private`; this interface keeps
 * the cast surface explicit and renames/removals will surface as TS
 * errors here instead of silent test rot.
 */
interface LocalBackendLike {
  callToolMultiRepo: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  crossRepoRegistry?: CrossRepoRegistryLike;
  crossRepoInitPromise?: Promise<unknown>;
}

/** Concrete shape the test extends the IndexedDBHandle with. */
interface IndexedDBHandleWithBackend {
  _backend?: LocalBackend;
  [k: string]: unknown;
}

/** Concrete shape the test extends the RegistryEntry with. */
interface RegistryEntryLike {
  name: string;
  path: string;
  storagePath: string;
  indexedAt: string;
  lastCommit: string;
  stats: { files: number; nodes: number; communities: number; processes: number };
}

interface ImpactedEndpointsResult {
  summary: {
    changed_files: Record<string, number>;
    changed_symbols: Record<string, number>;
    impacted_endpoints: Record<string, number>;
    risk_level: string;
  };
  impacted_endpoints: {
    WILL_BREAK: EndpointImpact[];
    LIKELY_AFFECTED: EndpointImpact[];
    MAY_NEED_TESTING: EndpointImpact[];
  };
  changed_symbols: any[];
  affected_processes: any[];
  affected_modules: any[];
  _meta: { version: string; generated_at: string };
  error?: string;
  /** Multi-repo aggregator-only field. Must be absent on single-repo path. */
  errors?: unknown;
}

/** Build a realistic `git diff --unified=0` output string for testing. */
function buildUnifiedDiff(filePath: string, hunks: Array<{ newStart: number; newCount: number }>): string {
  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];
  for (const hunk of hunks) {
    const oldStart = hunk.newStart;
    const oldCount = hunk.newCount;
    lines.push(`@@ -${oldStart},${oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (let i = 0; i < hunk.newCount; i++) {
      lines.push(`+changed line ${hunk.newStart + i}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Mock execFileSync for a single-file diff. */
function mockGitDiff(filePath: string, hunks: Array<{ newStart: number; newCount: number }>): void {
  vi.mocked(execFileSync).mockImplementation(((_cmd: string, args: string[]) => {
    if (args.includes('--unified=0')) {
      return buildUnifiedDiff(filePath, hunks);
    }
    if (args.includes('--name-only')) {
      return `${filePath}\n`;
    }
    return '';
  }) as typeof execFileSync);
}

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';

// ═══════════════════════════════════════════════════════════════════════════
// WI-21: impacted_endpoints single-repo scope guard
// ═══════════════════════════════════════════════════════════════════════════
describe('impacted_endpoints #21 single-repo scope guard (no consumer leak)', () => {
  let backend: LocalBackend;

  withTestLbugDB('wi21-guard', (handle) => {
    beforeAll(async () => {
      const ext = handle as unknown as IndexedDBHandleWithBackend;
      if (!ext._backend) {
        throw new Error('LocalBackend not initialized');
      }
      backend = ext._backend;
    });

    it('WI-21: pinning `repo=test-consumer-a` does not leak test-consumer-b into the response', async () => {
      // UserController.java is the canonical repoA change — its WILL_BREAK
      // chain is route-post-users ← method-createUser (per existing
      // E2E-CR07b). Using it here gives a positive signal that the
      // single-repo path actually executed.
      mockGitDiff('UserController.java', [{ newStart: 42, newCount: 5 }]);

      // Pre-installed at afterSetup. Tripwires — if the guard fails, both
      // are observable: findConsumers is called, and callToolMultiRepo
      // is reached.
      const backendAs = backend as unknown as LocalBackendLike;
      const findConsumersSpy = backendAs.crossRepoRegistry?.findConsumers as
        | ReturnType<typeof vi.fn>
        | undefined;
      const callMultiRepoSpy = vi.spyOn(backendAs, 'callToolMultiRepo');

      const result = await backend.callTool('impacted_endpoints', {
        repo: 'test-consumer-a',
        scope: 'compare',
        base_ref: 'main',
      }) as ImpactedEndpointsResult;

      // 1. The guard must short-circuit auto-expansion. findConsumers
      //    is the first symptom: if it was called, the guard failed.
      if (findConsumersSpy) {
        expect(findConsumersSpy).not.toHaveBeenCalled();
      }
      // 2. callToolMultiRepo is the second symptom: if it was reached,
      //    the guard failed and the multi-repo aggregator ran.
      expect(callMultiRepoSpy).not.toHaveBeenCalled();

      // 3. The result must be the single-repo shape: no `errors` field
      //    (unique to the multi-repo aggregator at local-backend.ts:731).
      expect(result).not.toHaveProperty('error');
      expect(result.errors).toBeUndefined();

      // 4. summary.changed_files / changed_symbols / impacted_endpoints
      //    are single-key Records. Anything beyond 'test-consumer-a'
      //    is a leak.
      const cf = result.summary.changed_files;
      const cs = result.summary.changed_symbols;
      const ie = result.summary.impacted_endpoints;
      expect(Object.keys(cf)).toEqual(['test-consumer-a']);
      expect(Object.keys(cs)).toEqual(['test-consumer-a']);
      expect(Object.keys(ie)).toEqual(['test-consumer-a']);
      expect(cf['test-consumer-a']).toBeGreaterThanOrEqual(1);
      expect(cf['test-consumer-b']).toBeUndefined();
      expect(ie['test-consumer-b']).toBeUndefined();

      // 5. No endpoint in any tier may carry a `_repoId: 'test-consumer-b'`
      //    attribution. The single-repo path never attaches `_repoId`.
      const allEndpoints: EndpointImpact[] = [
        ...(result.impacted_endpoints?.WILL_BREAK || []),
        ...(result.impacted_endpoints?.LIKELY_AFFECTED || []),
        ...(result.impacted_endpoints?.MAY_NEED_TESTING || []),
      ];
      for (const ep of allEndpoints) {
        expect(ep._repoId).toBeUndefined();
      }

      // 6. Positive signal: the actual repoA impact is still produced
      //    (UserController.java change → POST /api/users WILL_BREAK).
      //    This proves the single-repo BFS actually ran end-to-end —
      //    not that we short-circuited to an empty result.
      const postUsers = allEndpoints.find(
        (ep) => ep.path === '/api/users' && ep.method === 'POST',
      );
      expect(postUsers).toBeDefined();
    });
  }, {
    seed: IMPACTED_ENDPOINTS_CROSS_REPO_COMBINED_SEED,
    ftsIndexes: IMPACTED_ENDPOINTS_FTS_INDEXES,
    poolAdapter: true,
    afterSetup: async (handle) => {
      const ext = handle as unknown as IndexedDBHandleWithBackend & {
        tmpHandle: { dbPath: string };
      };
      // Register TWO repos in the registry, both pointing at the same
      // physical DB. The guard's correctness depends on this shape: a
      // multi-repo registry where the caller pins a single repo.
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-consumer-a',
          path: '/test/consumer-a',
          storagePath: ext.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 8, nodes: 30, communities: 3, processes: 2 },
        },
        {
          name: 'test-consumer-b',
          path: '/test/consumer-b',
          storagePath: ext.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 8, nodes: 30, communities: 3, processes: 2 },
        },
      ] satisfies RegistryEntryLike[]);
      const b = new LocalBackend();
      await b.init();

      // Pre-populate the cross-repo registry with a mock whose
      // findConsumers WOULD return repoB if the guard let the call
      // through. The test asserts findConsumers is never called and
      // callToolMultiRepo is never reached, so this mock only matters
      // as a tripwire for the regression.
      const findConsumersSpy = vi.fn().mockReturnValue(['test-consumer-b']);
      const bAs = b as unknown as LocalBackendLike;
      bAs.crossRepoRegistry = {
        isInitialized: () => true,
        isLoaded: () => true,
        findConsumers: findConsumersSpy,
        findDepRepo: (_prefix: string) => null,
        listRepos: () => [
          { repoId: 'test-consumer-a', manifest: null },
          { repoId: 'test-consumer-b', manifest: null },
        ],
        clear: () => {},
      };
      bAs.crossRepoInitPromise = Promise.resolve();

      ext._backend = b;
    },
  });
});
