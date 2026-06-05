/**
 * Issue #81: document-endpoint's fallback handler matcher must respect the HTTP
 * method.
 *
 * The Method-search Cypher in findHandlerByPathPattern matches any controller
 * method whose content contains the mapping annotation + a path fragment, so a
 * @GetMapping handler can surface as a candidate for a DELETE request. The fix
 * uses the concrete verb that parseMethodLevelMapping already recovers and drops
 * candidates whose verb disagrees with the request (while keeping genuinely
 * method-ambiguous bare @RequestMapping handlers).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/mcp/core/lbug-adapter.js', () => ({
  executeParameterized: vi.fn(),
  initLbug: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(),
}));

import { findHandlerByPathPattern } from '../../src/mcp/local/document-endpoint.js';
import { executeParameterized } from '../../src/mcp/core/lbug-adapter.js';

const repo = { id: 'test-repo' } as any;

/**
 * Mock the method-candidate search to return exactly one handler with the given
 * content, and no class-level @RequestMapping prefix. This reproduces the
 * over-broad match that #81 describes.
 */
function mockMethodSearch(handlerContent: string, handler: string) {
  (executeParameterized as any).mockImplementation(async (_id: string, query: string) => {
    if (query.includes('CONTAINS $mappingAnnotation')) {
      return [{ handler, filePath: '/src/main/java/com/x/OrdersController.java', line: 10, content: handlerContent }];
    }
    if (query.includes('MATCH (c:Class)')) {
      return []; // no class-level prefix
    }
    return [];
  });
}

describe('findHandlerByPathPattern HTTP-method gate (#81)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a GET handler when the request is DELETE (the #81 bug)', async () => {
    // Without the gate this @GetMapping("/orders") handler would structurally
    // match DELETE /orders and be returned as the (wrong) handler.
    mockMethodSearch('@GetMapping("/orders") public Order getOrders() {}', 'getOrders');
    const result = await findHandlerByPathPattern(repo, 'DELETE', '/orders');
    expect(result).toBeUndefined();
  });

  it('accepts a genuine DELETE handler for a DELETE request', async () => {
    mockMethodSearch('@DeleteMapping("/orders") public void deleteOrder() {}', 'deleteOrder');
    const result = await findHandlerByPathPattern(repo, 'DELETE', '/orders');
    expect(result?.handler).toBe('deleteOrder');
    expect(result?.method).toBe('DELETE');
  });

  it('still accepts a bare @RequestMapping handler (method-ambiguous) for DELETE', async () => {
    mockMethodSearch('@RequestMapping("/orders") public void handle() {}', 'handle');
    const result = await findHandlerByPathPattern(repo, 'DELETE', '/orders');
    expect(result?.handler).toBe('handle');
  });

  it('accepts a GET handler for a GET request (no false rejection)', async () => {
    mockMethodSearch('@GetMapping("/orders") public Order getOrders() {}', 'getOrders');
    const result = await findHandlerByPathPattern(repo, 'GET', '/orders');
    expect(result?.handler).toBe('getOrders');
    expect(result?.method).toBe('GET');
  });
});
