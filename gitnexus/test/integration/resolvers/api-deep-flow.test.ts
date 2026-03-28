/**
 * Pipeline-level integration tests for deep flow detection features.
 *
 * Runs runPipelineFromRepo on the api-e2e-test fixture and verifies
 * that the extraction pipeline produces correct Route node properties
 * (responseKeys, errorKeys, middleware) and FETCHES edge reason encoding
 * (consumer accessed keys, multi-fetch attribution).
 *
 * This complements the seed-based api-impact-e2e.test.ts which tests
 * the query/tool layer. Together they cover extraction → storage → query.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('deep flow detection pipeline', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'api-e2e-test'), () => {});
  }, 60000);

  // ─── Route nodes ────────────────────────────────────────────────

  it('creates Route nodes for /api/grants and /api/secure', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/grants');
    expect(routes).toContain('/api/secure');
  });

  // ─── Response shape extraction ─────────────────────────────────

  it('extracts responseKeys from NextResponse.json() success path', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const grants = routes.find((r) => r.name === '/api/grants');
    expect(grants).toBeDefined();
    expect(grants!.properties.responseKeys).toEqual(expect.arrayContaining(['data', 'pagination']));
  });

  it('extracts errorKeys from NextResponse.json() with status >= 400', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const grants = routes.find((r) => r.name === '/api/grants');
    expect(grants).toBeDefined();
    expect(grants!.properties.errorKeys).toEqual(expect.arrayContaining(['error', 'message']));
  });

  it('keeps success and error keys separate (no cross-contamination)', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const grants = routes.find((r) => r.name === '/api/grants');
    expect(grants).toBeDefined();

    const successKeys = new Set(grants!.properties.responseKeys ?? []);
    const errorKeys = new Set(grants!.properties.errorKeys ?? []);

    // 'error' and 'message' should only be in errorKeys
    expect(successKeys.has('error')).toBe(false);
    expect(successKeys.has('message')).toBe(false);
    // 'data' and 'pagination' should only be in responseKeys
    expect(errorKeys.has('data')).toBe(false);
    expect(errorKeys.has('pagination')).toBe(false);
  });

  // ─── Middleware chain extraction ───────────────────────────────

  it('extracts middleware chain for withAuth(withRateLimit(...)) wrapper', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const secure = routes.find((r) => r.name === '/api/secure');
    expect(secure).toBeDefined();
    expect(secure!.properties.middleware).toBeDefined();
    expect(secure!.properties.middleware).toContain('withAuth');
    expect(secure!.properties.middleware).toContain('withRateLimit');
  });

  it('stores middleware in outermost-first order', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const secure = routes.find((r) => r.name === '/api/secure');
    expect(secure).toBeDefined();
    const mw = secure!.properties.middleware ?? [];
    const authIdx = mw.indexOf('withAuth');
    const rlIdx = mw.indexOf('withRateLimit');
    // withAuth wraps withRateLimit, so withAuth should come first
    expect(authIdx).toBeLessThan(rlIdx);
  });

  // ─── FETCHES edges ────────────────────────────────────────────

  it('creates FETCHES edges from consumer files to Route nodes', () => {
    const edges = getRelationships(result, 'FETCHES');
    expect(edges.length).toBeGreaterThanOrEqual(2);

    // GrantsList → /api/grants
    const grantsListEdge = edges.find(
      (e) => e.sourceFilePath.includes('GrantsList') && e.target === '/api/grants',
    );
    expect(grantsListEdge).toBeDefined();
  });

  it('encodes consumer accessed keys in FETCHES reason field', () => {
    const edges = getRelationships(result, 'FETCHES');

    // GrantsList destructures { data, pagination } from the response
    const grantsListEdge = edges.find(
      (e) => e.sourceFilePath.includes('GrantsList') && e.target === '/api/grants',
    );
    expect(grantsListEdge).toBeDefined();
    expect(grantsListEdge!.rel.reason).toContain('keys:');

    // Parse the keys from the reason field
    const keysMatch = grantsListEdge!.rel.reason?.match(/keys:([^|]+)/);
    expect(keysMatch).not.toBeNull();
    const keys = keysMatch![1].split(',');
    expect(keys).toContain('data');
    expect(keys).toContain('pagination');
  });

  it('encodes multi-fetch count when consumer fetches multiple routes', () => {
    const edges = getRelationships(result, 'FETCHES');

    // useMulti fetches both /api/grants and /api/secure
    const useMultiGrants = edges.find(
      (e) => e.sourceFilePath.includes('useMulti') && e.target === '/api/grants',
    );
    const useMultiSecure = edges.find(
      (e) => e.sourceFilePath.includes('useMulti') && e.target === '/api/secure',
    );
    expect(useMultiGrants).toBeDefined();
    expect(useMultiSecure).toBeDefined();

    // Both edges should have fetches:2 in reason
    expect(useMultiGrants!.rel.reason).toContain('fetches:2');
    expect(useMultiSecure!.rel.reason).toContain('fetches:2');
  });

  // ─── HANDLES_ROUTE edges ──────────────────────────────────────

  it('creates HANDLES_ROUTE edges from handler functions to Route nodes', () => {
    const edges = getRelationships(result, 'HANDLES_ROUTE');
    expect(edges.length).toBeGreaterThanOrEqual(2);

    const grantsHandler = edges.find((e) => e.target === '/api/grants');
    expect(grantsHandler).toBeDefined();
    expect(grantsHandler!.sourceFilePath).toContain('app/api/grants/route.ts');
  });

  // ─── Mismatch-detectable data ─────────────────────────────────

  it('useGrants accesses items which is NOT in grants responseKeys (mismatch scenario)', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const grants = routes.find((r) => r.name === '/api/grants');
    const edges = getRelationships(result, 'FETCHES');
    const useGrantsEdge = edges.find(
      (e) => e.sourceFilePath.includes('useGrants') && e.target === '/api/grants',
    );
    expect(useGrantsEdge).toBeDefined();

    // useGrants.ts does data.items — 'items' should be in consumer keys
    const keysMatch = useGrantsEdge!.rel.reason?.match(/keys:([^|]+)/);
    expect(keysMatch).not.toBeNull();
    const consumerKeys = keysMatch![1].split(',');
    expect(consumerKeys).toContain('items');

    // But /api/grants responseKeys are [data, pagination] — 'items' is NOT there
    const responseKeys = new Set(grants!.properties.responseKeys ?? []);
    expect(responseKeys.has('items')).toBe(false);
    // This is the mismatch the api_impact tool would detect
  });
});
