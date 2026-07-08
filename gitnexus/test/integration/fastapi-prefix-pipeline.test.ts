/**
 * End-to-end coverage of the FastAPI `include_router(prefix=…)` fix.
 *
 * The PR claims to update both layers — ingestion (graph `Route`
 * nodes) and group (HTTP contracts). The group side is exercised by
 * `test/unit/group/http-route-extractor.test.ts`; this file pins the
 * **ingestion** side by running the full pipeline against a realistic
 * fixture and inspecting the resulting `Route` graph nodes.
 *
 * What this test pins:
 *
 * 1. **Shape A** (`from api import users` +
 *    `application.include_router(users.router, prefix='/users')`)
 *    produces `Route` nodes whose `name` is the prefixed full path
 *    (`/users/list`, `/users/create`) — not the bare decorator path.
 *
 * 2. **Shape B with relative import**
 *    (`from .calls import router as calls_router` +
 *    `application.include_router(calls_router, prefix='/calls')`)
 *    works end-to-end. Before the regex fix, the leading-dot module
 *    path was rejected and the prefix was silently dropped.
 *
 * 3. **Same-name modules in different packages** do not bleed
 *    prefixes. Before the long-key fix, both `api/users.py` and
 *    `admin/users.py` shared the basename `users`, so `admin/users`
 *    routes inherited the `/users` prefix that was only meant for
 *    `api/users.py`.
 *
 * 4. **Non-`app` host names** (`application = FastAPI()`) work in the
 *    ingestion regex. The group-layer counterpart is pinned by the
 *    `non-app host` cases in `http-route-extractor.test.ts`.
 *
 * 5. **Same-file `APIRouter(prefix=…)`** is applied to `@router`
 *    decorators, and stacks with an outer `include_router(prefix=…)`.
 *
 * 6. **Root-file constructor prefixes do not bleed into nested same-stem
 *    files.** A repo-root `users.py` can use `APIRouter(prefix=…)`, but
 *    `admin/users.py` must not inherit that constructor prefix.
 *
 * The fixture lives at `test/fixtures/fastapi-prefix-app/` so the
 * pipeline can scan a real on-disk repo (mirroring how `gitnexus
 * analyze` is used in production) and so reviewers can inspect the
 * inputs without reading test source.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fastapi-prefix-app');

describe('FastAPI include_router(prefix=…) — ingestion pipeline', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    // Force the worker-pool code path on this small fixture (~5
    // files). Without this the pipeline takes the sequential
    // fallback, which historically does NOT run the FastAPI router
    // bindings extractor — the very behaviour we want to pin lives
    // exclusively inside the worker entry point.
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 60_000);

  function routeNames(): string[] {
    const out: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Route') out.push(String(n.properties.name));
    });
    return out.sort();
  }

  it('joins Shape-A `<mod>.router` prefixes with sub-router decorator paths', () => {
    // `application.include_router(users.router, prefix='/users')` in
    // main.py + `@router.get('/list')` / `@router.post('/create')` in
    // api/users.py → `/users/list`, `/users/create`.
    const names = routeNames();
    expect(names).toContain('/users/list');
    expect(names).toContain('/users/create');
    // The bare decorator paths must NOT survive when a prefix
    // mapping exists — one router yields exactly one Route node per
    // prefix, not the prefixed AND the unprefixed copy.
    expect(names.filter((n) => n === '/list')).toHaveLength(0);
    expect(names.filter((n) => n === '/create')).toHaveLength(0);
  });

  it('joins Shape-B with absolute named import (`from api.calls import router as …`)', () => {
    // main.py mounts `api.calls` under `/calls`; api/calls.py has
    // `@router.get('/list')`. Long-key resolution is required here:
    // `users` (under `/users`) and `calls` are distinct module
    // basenames, but the long key (`api/calls`) is what makes the
    // binding deterministic.
    const names = routeNames();
    expect(names).toContain('/calls/list');
  });

  it('joins Shape-B with relative import (`from .relative import router as …`)', () => {
    // FINDING 2: the worker regex `[A-Za-z_][\w.]*` used to reject
    // module paths starting with `.`, silently dropping every
    // leading-dot relative import. relative.py declares `/info`; the
    // expected joined route is `/rel/info`.
    const names = routeNames();
    expect(names).toContain('/rel/info');
  });

  it('joins same-file APIRouter(prefix=…) with router decorator paths', () => {
    const names = routeNames();
    expect(names).toContain('/local');
    expect(names).toContain('/root-users/landing');
    expect(names.filter((n) => n === '/')).toHaveLength(0);
  });

  it('stacks same-file APIRouter(prefix=…) with include_router(prefix=…)', () => {
    // api/items.py declares `APIRouter(dependencies=[Depends(get_db)], prefix="/items")`
    // — a router-level dependency BEFORE prefix=. This pins the balanced-paren
    // scan end-to-end: the old `[^)]*?` regex stopped at the `)` of `Depends(...)`
    // and dropped `/items`, leaving the graph Route node at `/v1/{item_id}`.
    const names = routeNames();
    expect(names).toContain('/v1/items/{item_id}');
    expect(names.filter((n) => n === '/items/{item_id}')).toHaveLength(0);
    expect(names.filter((n) => n === '/v1/{item_id}')).toHaveLength(0);
  });

  it('does NOT bleed `/users` prefix onto the same-name `admin/users.py`', () => {
    // FINDING 3: `api/users.py` and `admin/users.py` collide on the
    // short module key `users`. main.py only mounts the `api/users`
    // router under `/users`, so the admin file's `@router.get('/audit')`
    // must surface as the bare `/audit` — never as `/users/audit`.
    const names = routeNames();
    expect(names).toContain('/audit');
    expect(names.filter((n) => n === '/users/audit')).toHaveLength(0);
  });

  it('does NOT bleed root same-file APIRouter(prefix=…) onto nested same-stem files', () => {
    const names = routeNames();
    expect(names).toContain('/root-users/landing');
    expect(names).toContain('/audit');
    expect(names.filter((n) => n === '/root-users/audit')).toHaveLength(0);
  });

  it('emits exactly one Route node per (router method, prefix) pair', () => {
    // Defence-in-depth: counts the unique route nodes for the
    // prefixed routes to make sure the duplication path in
    // parse-impl (`for prefix of prefixes`) didn't accidentally
    // double-emit when only a single prefix was registered.
    const names = routeNames();
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    expect(counts.get('/users/list')).toBe(1);
    expect(counts.get('/users/create')).toBe(1);
    expect(counts.get('/calls/list')).toBe(1);
    expect(counts.get('/rel/info')).toBe(1);
    expect(counts.get('/local')).toBe(1);
    expect(counts.get('/v1/items/{item_id}')).toBe(1);
    expect(counts.get('/audit')).toBe(1);
  });
});
