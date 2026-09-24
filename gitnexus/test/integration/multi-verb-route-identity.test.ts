/**
 * End-to-end coverage of multi-verb Route node identity (#2289).
 *
 * A declarative route's graph identity is `(method, url)`: a same-URL
 * `GET /x` + `POST /x` pair becomes TWO Route nodes (keyed `routeNodeKey`),
 * each carrying its own verb + resolved handler. Filesystem routes
 * (Next.js/Expo/PHP) have no structural verb, so they keep their URL-only id —
 * byte-identical to the pre-#2289 behavior — and coexist with a same-URL
 * decorator route as a separate node. A verb-less `fetch()` consumer matches by
 * URL and connects to EVERY Route node at that URL.
 *
 * Fixture: `test/fixtures/multi-verb-route-app/`
 *   - ItemController.java: GET /api/items, POST /api/items, GET /api/widgets
 *   - app/api/widgets/route.ts: Next.js filesystem route → /api/widgets
 *   - api/widgetsController.ts: NestJS `@All` → method-agnostic /api/widgets,
 *     plus `@Get('gadgets')` → GET /api/gadgets (the non-colliding witness)
 *   - web/itemsClient.ts: verb-less fetch() consumers of both URLs
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { generateId } from '../../src/lib/utils.js';
import { routeNodeKey } from '../../src/core/ingestion/route-extractors/route-path.js';
import type { PipelineResult } from '../../types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'multi-verb-route-app');

const routeId = (method: string | undefined, url: string) =>
  generateId('Route', routeNodeKey(method, url));

describe('Multi-verb Route node identity (#2289)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 60_000);

  function routeNode(id: string) {
    return result.graph.getNode(id);
  }

  it('splits a same-URL GET/POST pair into two distinct Route nodes', () => {
    const get = routeNode(routeId('GET', '/api/items'));
    const post = routeNode(routeId('POST', '/api/items'));

    expect(get, 'GET /api/items Route node should exist').toBeTruthy();
    expect(post, 'POST /api/items Route node should exist').toBeTruthy();

    // Both nodes keep the URL as their display name; the verb distinguishes them.
    expect(get!.properties.name).toBe('/api/items');
    expect(post!.properties.name).toBe('/api/items');
    expect(get!.properties.method).toBe('GET');
    expect(post!.properties.method).toBe('POST');
  });

  it('resolves each verb to its own handler symbol (re-keyed routeHandlerSymbols)', () => {
    const get = routeNode(routeId('GET', '/api/items'));
    const post = routeNode(routeId('POST', '/api/items'));

    const getHandler = result.graph.getNode(String(get!.properties.handlerSymbolId));
    const postHandler = result.graph.getNode(String(post!.properties.handlerSymbolId));

    expect(getHandler?.properties.name).toBe('listItems');
    expect(postHandler?.properties.name).toBe('createItem');
  });

  it('keeps a filesystem route URL-only (byte-identical pre-#2289 id)', () => {
    const fsNode = routeNode(generateId('Route', '/api/widgets'));
    expect(fsNode, 'filesystem Route node /api/widgets should exist').toBeTruthy();
    expect(fsNode!.properties.name).toBe('/api/widgets');
    // Filesystem routes carry no structural verb.
    expect(fsNode!.properties.method).toBeUndefined();
  });

  it('lets a filesystem route and a same-URL decorator route coexist as separate nodes', () => {
    const fsNode = routeNode(generateId('Route', '/api/widgets'));
    const decoratorNode = routeNode(routeId('GET', '/api/widgets'));

    expect(fsNode, 'URL-only filesystem node').toBeTruthy();
    expect(decoratorNode, 'GET /api/widgets decorator node').toBeTruthy();
    // Distinct ids — no collision, no first-writer-wins eviction across keys.
    expect(fsNode!.id).not.toBe(decoratorNode!.id);
    expect(decoratorNode!.properties.method).toBe('GET');
  });

  it("never stamps a losing route's handler onto a filesystem node (#3049)", () => {
    // The NestJS `@All('widgets')` route keys by URL alone (routeNodeKey drops
    // '*'), so it collides with the filesystem route, claims the key unopposed
    // in claim(), and is then dropped here by first-writer-wins. Its handler
    // must not survive that loss: a Next.js Route node carrying a NestJS
    // controller method is a fabricated fact, not a missing one, and
    // api_impact is documented to be run BEFORE editing a route handler.
    const fsNode = routeNode(generateId('Route', '/api/widgets'));

    expect(fsNode, 'filesystem Route node /api/widgets should exist').toBeTruthy();
    expect(fsNode!.properties.handlerSymbolId).toBeUndefined();
  });

  it('extracts a NON-colliding NestJS route (the witness that #3049 suppressed a REAL claim)', () => {
    // Load-bearing for the assertion above it, which cannot stand alone:
    // `handlerSymbolId === undefined` passes identically whether the guard
    // correctly dropped a real NestJS `@All` claim or whether NestJS
    // extraction produced nothing at all. Disproved by experiment — commenting
    // out `...extractNestRoutes(...args)` in `languages/typescript.ts` and
    // rebuilding `dist/` left the whole suite green.
    //
    // Asserting that the `WidgetsController` class and its `handleEveryVerb`
    // method exist does NOT repair that, and is the first thing the next
    // reader will try: those nodes come from the definitions phase, which runs
    // regardless, while `extractNestRoutes` is wired only as the
    // `decoratorRoutes` hook and contributes no class or method node.
    // `@All('widgets')` also cannot witness its own extraction — it collides
    // on `routeNodeKey`, is dropped as a duplicate, and leaves no graph trace.
    // A second route at a URL nothing else claims is the only evidence the
    // graph can carry, so this node existing IS the proof the `@All` claim the
    // guard suppressed was real.
    const gadgets = routeNode(routeId('GET', '/api/gadgets'));

    expect(gadgets, 'NestJS GET /api/gadgets Route node should exist').toBeTruthy();

    const handler = result.graph.getNode(String(gadgets!.properties.handlerSymbolId));
    expect(String(handler?.properties.name)).toBe('listGadgets');
  });

  it('still resolves a same-URL route that did NOT lose its key', () => {
    // The guard above is scoped to pre-seeded sources, so the Java
    // `GET /api/widgets` node — a different key, resolved for itself — keeps
    // its handler. Without this, the fix reads as "filesystem collisions are
    // handler-less" when the real rule is "a route that lost donates nothing".
    const decoratorNode = routeNode(routeId('GET', '/api/widgets'));
    const handler = result.graph.getNode(String(decoratorNode!.properties.handlerSymbolId));

    expect(String(handler?.properties.name)).toBe('getWidgets');
  });

  it('connects a verb-less fetch() consumer to every Route node at the URL', () => {
    const consumerFileId = generateId('File', 'web/itemsClient.ts');
    // Collect FETCHES targets without a test-level conditional: pass the
    // shape filter as a Set membership check on the relationship type +
    // sourceId, then materialize unique targetIds.
    const fetchTargets = new Set(
      result.graph.relationships
        .filter((r) => r.type === 'FETCHES' && r.sourceId === consumerFileId)
        .map((r) => r.targetId),
    );

    // /api/items: the verb-less consumer reaches BOTH the GET and POST nodes.
    expect(fetchTargets.has(routeId('GET', '/api/items'))).toBe(true);
    expect(fetchTargets.has(routeId('POST', '/api/items'))).toBe(true);
    // /api/widgets: reaches both the filesystem node and the decorator node.
    expect(fetchTargets.has(generateId('Route', '/api/widgets'))).toBe(true);
    expect(fetchTargets.has(routeId('GET', '/api/widgets'))).toBe(true);
  });
});
