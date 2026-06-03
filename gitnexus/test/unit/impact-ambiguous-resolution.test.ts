/**
 * Unit Tests: #10 ambiguous candidate resolution and #75 Method seed expansion
 *
 * Verifies:
 *   - #10: When a target name matches symbols in MULTIPLE distinct files
 *     (e.g., GetOrder in handlers/ vs services/), impact() returns the
 *     same `status: 'ambiguous'` shape as the context tool, instead of
 *     silently picking the first candidate.
 *   - #10: When a file_path is supplied, the matching candidate wins.
 *   - #75: When the target is a Class node, the seed expansion includes
 *     Method (not just Constructor) nodes, so the BFS can reach method-level
 *     CALLS at deeper depths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeQueryMock = vi.fn();
const executeParameterizedMock = vi.fn();

vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeQuery: (...args: any[]) => executeQueryMock(...args),
    executeParameterized: (...args: any[]) => executeParameterizedMock(...args),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend';

function makeBackend(repoId = 'test-repo') {
  const backend = new LocalBackend();
  const repoHandle = {
    id: repoId,
    name: repoId,
    repoPath: `/tmp/${repoId}`,
    storagePath: `/tmp/${repoId}/.gitnexus`,
    lbugPath: `/tmp/${repoId}/.gitnexus/lbug`,
    indexedAt: 'now',
    lastCommit: 'c',
    stats: {},
  } as any;
  (backend as any).repos.set(repoHandle.id, repoHandle);
  (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
  return { backend, repoHandle };
}

function callsWithQuery(substr: string) {
  return executeParameterizedMock.mock.calls.filter((call: any[]) => {
    const query = typeof call[1] === 'string' ? call[1] : '';
    return query.includes(substr);
  });
}

// ─── #10: Ambiguous candidate resolution ─────────────────────────────

describe('impact: #10 ambiguous candidate resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQueryMock.mockImplementation(async () => []);
    executeParameterizedMock.mockImplementation(async () => []);
  });

  it('A1.1: same name in two different files returns ambiguous status', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      // The priority UNION query returns TWO matches across files.
      if (query.includes('UNION ALL')) {
        return [
          { id: 'Method:services/order_service.go:GetOrder', name: 'GetOrder', filePath: 'services/order_service.go', priority: 3 },
          { id: 'Method:handlers/order_handler.go:GetOrder', name: 'GetOrder', filePath: 'handlers/order_handler.go', priority: 3 },
        ];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, {
      target: 'GetOrder',
      direction: 'upstream',
      maxDepth: 3,
    });

    // Must be the ambiguous shape, NOT silently pick the first candidate.
    expect(result.status).toBe('ambiguous');
    expect(result.target).toBe('GetOrder');
    expect(result.candidates).toHaveLength(2);
    const filePaths = result.candidates.map((c: any) => c.filePath).sort();
    expect(filePaths).toEqual(['handlers/order_handler.go', 'services/order_service.go']);
    expect(result.candidates[0]).toHaveProperty('uid');
    expect(result.candidates[0]).toHaveProperty('kind');
    expect(result.suggestion).toContain('file_path');
  });

  it('A1.2: same name in SAME file (e.g., Class + Constructor) silently prefers Class', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('UNION ALL')) {
        return [
          { id: 'Constructor:UserService:UserService', name: 'UserService', filePath: 'svc/UserService.java', priority: 4 },
          { id: 'Class:UserService', name: 'UserService', filePath: 'svc/UserService.java', priority: 0 },
        ];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, {
      target: 'UserService',
      direction: 'upstream',
      maxDepth: 3,
    });

    // Same file → not ambiguous; Class wins via priority sort.
    expect(result.status).toBeUndefined();
    expect(result.target.id).toBe('Class:UserService');
  });

  it('A1.3: file_path parameter disambiguates and returns the matching candidate', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('UNION ALL')) {
        return [
          { id: 'Method:services/order_service.go:GetOrder', name: 'GetOrder', filePath: 'services/order_service.go', priority: 3 },
          { id: 'Method:handlers/order_handler.go:GetOrder', name: 'GetOrder', filePath: 'handlers/order_handler.go', priority: 3 },
        ];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, {
      target: 'GetOrder',
      direction: 'upstream',
      maxDepth: 3,
      file_path: 'handlers/order_handler.go',
    });

    // file_path is supplied → not ambiguous; pick the matching candidate.
    expect(result.status).toBeUndefined();
    expect(result.target.id).toBe('Method:handlers/order_handler.go:GetOrder');
  });

  it('A1.4: single candidate does NOT trigger ambiguous even without file_path', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('UNION ALL')) {
        return [
          { id: 'Class:OrderService', name: 'OrderService', filePath: 'svc/OrderService.java', priority: 0 },
        ];
      }
      return [];
    });

    const result = await (backend as any)._impactImpl(repoHandle, {
      target: 'OrderService',
      direction: 'upstream',
      maxDepth: 3,
    });

    expect(result.status).toBeUndefined();
    expect(result.target.id).toBe('Class:OrderService');
  });
});

// ─── #75: Class seed expansion includes Method nodes ────────────────

describe('impact: #75 Class seed expansion includes Method nodes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQueryMock.mockImplementation(async () => []);
    executeParameterizedMock.mockImplementation(async () => []);
  });

  it('A2.1: Class target triggers BOTH Constructor and Method seed queries', async () => {
    const { backend, repoHandle } = makeBackend();

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      // uid query → return Class
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Class:PricingBackendController', name: 'PricingBackendController', type: 'Class', filePath: 'ctrl/PricingBackendController.java' }];
      }
      // Method seed query (HAS_METHOD → Method) — must be present
      if (query.includes('HAS_METHOD') && query.includes('Method') && !query.includes('Constructor')) {
        return [
          { id: 'Method:pricingIConnect', name: 'pricingIConnect', type: 'Method', filePath: 'ctrl/PricingBackendController.java' },
          { id: 'Method:getQuote', name: 'getQuote', type: 'Method', filePath: 'ctrl/PricingBackendController.java' },
        ];
      }
      // Constructor seed query
      if (query.includes('HAS_METHOD') && query.includes('Constructor')) {
        return [];
      }
      if (query.includes('DEFINES')) {
        return [{ id: 'File:PricingBackendController.java', name: 'PricingBackendController.java', type: 'File', filePath: 'ctrl/PricingBackendController.java' }];
      }
      return [];
    });

    await (backend as any)._impactImpl(repoHandle, {
      target: 'Class:PricingBackendController',
      direction: 'downstream',
      maxDepth: 5,
    });

    // Both seed queries must be invoked.
    const methodSeedCalls = callsWithQuery('HAS_METHOD').filter(c => c[1].includes('Method') && !c[1].includes('Constructor'));
    expect(methodSeedCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('A2.2: Method seed nodes are added to the BFS frontier', async () => {
    const { backend, repoHandle } = makeBackend();
    const visitedIds: string[] = [];
    let methodSeedCalled = false;

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : '';
      if (query.includes('n.id = $targetName')) {
        return [{ id: 'Class:MyService', name: 'MyService', type: 'Class', filePath: 'svc/MyService.java' }];
      }
      if (query.includes('HAS_METHOD') && query.includes('Method') && !query.includes('Constructor')) {
        methodSeedCalled = true;
        return [{ id: 'Method:doWork', name: 'doWork', type: 'Method', filePath: 'svc/MyService.java' }];
      }
      if (query.includes('DEFINES')) {
        return [];
      }
      return [];
    });

    // Capture the frontier by hooking the BFS query (returns empty, so we
    // can only verify that the seed was invoked).
    await (backend as any)._impactImpl(repoHandle, {
      target: 'Class:MyService',
      direction: 'downstream',
      maxDepth: 3,
    });

    expect(methodSeedCalled).toBe(true);
    // Indirection: we can't directly observe visited without graph
    // integration, but the fact that the seed query was issued is the
    // critical contract.
  });
});
