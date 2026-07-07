/**
 * End-to-end coverage of imported/composed FastAPI route path constants (#2391).
 *
 * `@router.post(API_V1_WIDGETS_GET)` — where the path is an imported constant
 * built by `+`-concatenation in another module — must index as
 * `POST /api/v1/widgets/get` in the ingestion `Route` graph nodes (which drive
 * `route_map` / `api_impact`), NOT as `POST /`. An argument that cannot be folded
 * to a literal is skipped entirely (KTD5 floor), never recorded as `/`.
 *
 * The group HTTP-contract parity, multi-hop chains, the module-collision floor,
 * and the warm-cache guard are added by U5/U6 (see the sibling describe blocks
 * and `http-route-extractor.test.ts`).
 *
 * Fixture: `test/fixtures/fastapi-composed-app/`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fastapi-composed-app');

describe('FastAPI composed route constants — ingestion pipeline (#2391)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 60_000);

  function routes(): { method: string | undefined; url: string }[] {
    const out: { method: string | undefined; url: string }[] = [];
    result.graph.forEachNode((n) => {
      if (n.label !== 'Route') return;
      const method = n.properties.method;
      out.push({
        method: method === undefined ? undefined : String(method),
        url: String(n.properties.name),
      });
    });
    return out;
  }
  const urls = (): string[] =>
    routes()
      .map((r) => r.url)
      .sort();

  it('resolves the imported composed constant to its full path', () => {
    expect(routes()).toContainEqual({ method: 'POST', url: '/api/v1/widgets/get' });
  });

  it('never records a phantom `/` for a non-literal path', () => {
    expect(urls()).not.toContain('/');
  });

  it('leaves an ordinary string-literal sibling route unchanged', () => {
    expect(routes()).toContainEqual({ method: 'GET', url: '/literal/health' });
  });

  it('skips an unresolvable constant argument (no Route node, not `/`)', () => {
    // `@router.delete(UNKNOWN_ROUTE_CONST)` — the constant is defined nowhere, so
    // it folds to null and the route is dropped rather than indexed as `DELETE /`.
    expect(routes().some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('joins an APIRouter(prefix=…) with a resolved composed path', () => {
    // prefixed.py: `router = APIRouter(prefix="/v2")` + `@router.post(COMPOSED)`.
    expect(routes()).toContainEqual({ method: 'POST', url: '/v2/api/v1/widgets/get' });
  });

  it('keeps two composed routes at distinct paths as distinct nodes', () => {
    const composed = routes().filter((r) => r.url.endsWith('/api/v1/widgets/get'));
    expect(composed.map((r) => r.url).sort()).toEqual([
      '/api/v1/widgets/get',
      '/v2/api/v1/widgets/get',
    ]);
  });
});
