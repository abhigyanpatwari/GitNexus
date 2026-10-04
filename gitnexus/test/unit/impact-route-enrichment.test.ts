/**
 * `impact` names the HTTP routes in its blast radius (#3402).
 *
 * The routes reach the result through (handler)-[HANDLES_ROUTE]->Route, read for
 * the target and every impacted symbol. Before this, a service method's upstream
 * impact stopped at the handler: the route and its frontend callers never
 * appeared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeParameterizedMock = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    initLbug: vi.fn(),
    executeQuery: vi.fn(async () => []),
    executeParameterized: (...args: unknown[]) => executeParameterizedMock(...args),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    initLbug: vi.fn(),
    executeQuery: vi.fn(async () => []),
    executeParameterized: (...args: unknown[]) => executeParameterizedMock(...args),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend';

const REPO = {
  id: 'repo',
  name: 'repo',
  repoPath: '/tmp/repo',
  storagePath: '/tmp/repo/.gitnexus',
  lbugPath: '/tmp/repo/.gitnexus/lbug',
  indexedAt: 'now',
  lastCommit: 'c',
  stats: {},
};

interface RouteRow {
  readonly hid: string;
  readonly url: string;
  readonly method?: string;
}

/**
 * Target `svc` is called by `handler` (depth 1). `routeRows` answers the
 * HANDLES_ROUTE query; `routeQueryFails` makes it reject.
 */
async function runImpact(routeRows: readonly RouteRow[], routeQueryFails = false) {
  executeParameterizedMock.mockImplementation(async (...args: unknown[]) => {
    const query = String(args[1] ?? '');
    const params = (args[2] ?? {}) as { ids?: string[]; frontierIds?: string[] };
    if (query.includes("'HANDLES_ROUTE'")) {
      if (routeQueryFails) throw new Error('route query failed');
      return routeRows.filter((row) => params.ids?.includes(row.hid));
    }
    if (query.includes('$frontierIds')) {
      return (params.frontierIds ?? []).includes('svc')
        ? [
            {
              sourceId: 'svc',
              id: 'handler',
              name: 'Handle',
              type: 'Method',
              filePath: 'h.go',
              relType: 'CALLS',
              confidence: 1,
            },
          ]
        : [];
    }
    if (query.includes('STEP_IN_PROCESS') || query.includes('MEMBER_OF')) return [];
    if (query.includes('n.id AS id')) {
      return [{ id: 'svc', name: 'UnfinalizeRound', filePath: 'svc.go', type: 'Method' }];
    }
    return [];
  });

  const backend = new LocalBackend();
  (backend as unknown as { repos: Map<string, unknown> }).repos.set(REPO.id, REPO);
  (backend as unknown as { ensureInitialized: () => Promise<void> }).ensureInitialized = vi
    .fn()
    .mockResolvedValue(undefined);
  return (
    backend as unknown as {
      _impactImpl: (repo: unknown, params: unknown) => Promise<Record<string, unknown>>;
    }
  )._impactImpl(REPO, { target: 'UnfinalizeRound', direction: 'upstream', maxDepth: 2 });
}

const depthOneItems = (res: Record<string, unknown>) =>
  ((res.byDepth as Record<number, Array<Record<string, unknown>>>)[1] ?? []).map((item) => ({
    id: item.id,
    routes: item.routes,
  }));

describe('impact: route enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists the route an impacted handler serves, top-level and on the item', async () => {
    const res = await runImpact([
      { hid: 'handler', url: '/api/v1/rounds/:id/unfinalize', method: 'POST' },
    ]);

    expect(res.affected_routes).toEqual([{ url: '/api/v1/rounds/:id/unfinalize', method: 'POST' }]);
    expect(depthOneItems(res)).toEqual([
      { id: 'handler', routes: [{ url: '/api/v1/rounds/:id/unfinalize', method: 'POST' }] },
    ]);
  });

  it('includes a route the target itself serves, deduplicated by method and url', async () => {
    const res = await runImpact([
      { hid: 'svc', url: '/x', method: 'GET' },
      { hid: 'handler', url: '/x', method: 'GET' },
      { hid: 'handler', url: '/x', method: 'POST' },
    ]);

    expect(res.affected_routes).toEqual([
      { url: '/x', method: 'GET' },
      { url: '/x', method: 'POST' },
    ]);
  });

  it('keeps the result and flags it partial when the route query fails', async () => {
    const res = await runImpact([], true);

    expect({
      impactedCount: res.impactedCount,
      affected_routes: res.affected_routes,
      partial: res.partial,
    }).toEqual({ impactedCount: 1, affected_routes: [], partial: true });
  });
});
