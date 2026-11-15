/**
 * Unit Tests: Fetch reason field parsing
 *
 * Tests the reason field format used by processNextjsFetchRoutes and
 * parsed by fetchRoutesWithConsumers. Verifies that multi-fetch count
 * encoding and keys extraction work correctly with the updated regex.
 */
import { describe, it, expect } from 'vitest';

/**
 * Extracted parsing logic matching fetchRoutesWithConsumers in local-backend.ts.
 * This mirrors the regex patterns used at runtime.
 */
function parseReasonField(fetchReason: string | null): {
  accessedKeys?: string[];
  fetchCount?: number;
  viaSymbolIds?: string[];
} {
  let accessedKeys: string[] | undefined;
  let fetchCount: number | undefined;
  let viaSymbolIds: string[] | undefined;
  if (fetchReason) {
    const keysMatch = fetchReason.match(/\|keys:([^|]+)/);
    if (keysMatch) {
      accessedKeys = keysMatch[1].split(',').filter((k) => k.length > 0);
    }
    const fetchesMatch = fetchReason.match(/\|fetches:(\d+)/);
    if (fetchesMatch) {
      fetchCount = parseInt(fetchesMatch[1], 10);
    }
    const via = [...fetchReason.matchAll(/\|via:([^|]+)/g)].map((m) => m[1]);
    if (via.length > 0) viaSymbolIds = via;
  }
  return {
    ...(accessedKeys ? { accessedKeys } : {}),
    ...(fetchCount && fetchCount > 1 ? { fetchCount } : {}),
    ...(viaSymbolIds ? { viaSymbolIds } : {}),
  };
}

describe('fetch reason field parsing', () => {
  it('parses basic reason with no keys or fetches', () => {
    const result = parseReasonField('fetch-url-match');
    expect(result.accessedKeys).toBeUndefined();
    expect(result.fetchCount).toBeUndefined();
  });

  it('parses keys without fetches suffix', () => {
    const result = parseReasonField('fetch-url-match|keys:data,pagination');
    expect(result.accessedKeys).toEqual(['data', 'pagination']);
    expect(result.fetchCount).toBeUndefined();
  });

  it('parses keys with fetches suffix', () => {
    const result = parseReasonField('fetch-url-match|keys:data,pagination|fetches:3');
    expect(result.accessedKeys).toEqual(['data', 'pagination']);
    expect(result.fetchCount).toBe(3);
  });

  it('parses fetches without keys', () => {
    const result = parseReasonField('fetch-url-match|fetches:2');
    expect(result.accessedKeys).toBeUndefined();
    expect(result.fetchCount).toBe(2);
  });

  it('does not set fetchCount when value is 1', () => {
    // fetchCount=1 means single route, no need to flag
    const result = parseReasonField('fetch-url-match|keys:data|fetches:1');
    expect(result.accessedKeys).toEqual(['data']);
    expect(result.fetchCount).toBeUndefined();
  });

  it('handles null reason', () => {
    const result = parseReasonField(null);
    expect(result.accessedKeys).toBeUndefined();
    expect(result.fetchCount).toBeUndefined();
  });

  it('old greedy regex would have included |fetches: in keys — new regex does not', () => {
    // This is the regression test: the old regex /\|keys:(.+)$/ would match
    // "data,pagination|fetches:3" as keys, including the fetches suffix
    const reason = 'fetch-url-match|keys:data,pagination|fetches:3';
    const result = parseReasonField(reason);
    // Keys should NOT contain "fetches:3" or "pagination|fetches:3"
    expect(result.accessedKeys).not.toContain('pagination|fetches:3');
    expect(result.accessedKeys).toEqual(['data', 'pagination']);
  });

  // #3644: one field per requesting function; ids carry ':' and '#'.
  it('parses every via field, after keys and fetches', () => {
    const result = parseReasonField(
      'fetch-url-match|keys:data|fetches:2|via:Function:src/api.ts:getGrants#0|via:Method:src/api.ts:Api.list#1',
    );
    expect(result.accessedKeys).toEqual(['data']);
    expect(result.fetchCount).toBe(2);
    expect(result.viaSymbolIds).toEqual([
      'Function:src/api.ts:getGrants#0',
      'Method:src/api.ts:Api.list#1',
    ]);
  });

  it('leaves viaSymbolIds out of a reason written before the attribution', () => {
    const result = parseReasonField('fetch-url-match|keys:data,pagination|fetches:3');
    expect(result.viaSymbolIds).toBeUndefined();
    expect(result.accessedKeys).toEqual(['data', 'pagination']);
  });
});

describe('confidence derivation from fetchCount', () => {
  it('high confidence when fetchCount is undefined (single fetch)', () => {
    const fetchCount: number | undefined = undefined;
    const isMultiFetch = (fetchCount ?? 1) > 1;
    expect(isMultiFetch).toBe(false);
  });

  it('low confidence when fetchCount > 1', () => {
    const fetchCount = 3;
    const isMultiFetch = (fetchCount ?? 1) > 1;
    expect(isMultiFetch).toBe(true);
  });
});

describe('middlewareDetection partial flag', () => {
  it('flags partial when middleware exists and handler has multiple routes', () => {
    const middleware = ['withAuth'];
    const handlerRouteCount = 2;
    const middlewarePartial = middleware.length > 0 && handlerRouteCount > 1;
    expect(middlewarePartial).toBe(true);
  });

  it('does not flag partial when middleware exists but handler has single route', () => {
    const middleware = ['withAuth'];
    const handlerRouteCount = 1;
    const middlewarePartial = middleware.length > 0 && handlerRouteCount > 1;
    expect(middlewarePartial).toBe(false);
  });

  it('does not flag partial when no middleware even with multiple routes', () => {
    const middleware: string[] = [];
    const handlerRouteCount = 3;
    const middlewarePartial = middleware.length > 0 && handlerRouteCount > 1;
    expect(middlewarePartial).toBe(false);
  });
});
