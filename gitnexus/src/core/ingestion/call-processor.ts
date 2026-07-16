/**
 * Route / fetch edge emission + exported-type-map helpers.
 *
 * The legacy call-resolution DAG that previously lived here (per-file type
 * inference → receiver inference → dispatch selection → MRO walk over the
 * legacy heritage map) was deleted in RING4-1 (#942): all languages now resolve
 * calls through the scope-resolution registry pipeline. What remains are the
 * language-agnostic edge emitters that are NOT part of call resolution:
 *
 *   - `processRoutesFromExtracted` — CALLS edges from framework routes
 *     (e.g. Laravel) to their controller methods.
 *   - `processNextjsFetchRoutes` / `extractConsumerAccessedKeys` — FETCHES edges
 *     from `fetch()` calls to Next.js Route nodes.
 *   - `buildExportedTypeMapFromGraph` — exported symbol → return/declared type
 *     map, consumed by the cross-file enrichment pass.
 */

import { KnowledgeGraph } from '../graph/types.js';
import type { SemanticModel, SymbolTableReader } from './model/index.js';
import { generateId } from '../../lib/utils.js';
import type { SymbolDefinition } from 'gitnexus-shared';
import { yieldToEventLoop } from './utils/event-loop.js';
import type { ExtractedRoute, ExtractedFetchCall } from './workers/parse-worker.js';
import type { ExtractedDecoratorRoute } from './workers/parse-worker.js';
import { normalizeFetchURL, routeMatches } from './route-extractors/nextjs.js';
import {
  normalizeExtractedRoutePath,
  normalizeRouteMethod,
  routeNodeKey,
} from './route-extractors/route-path.js';
import { extractReturnTypeName } from './type-extractors/shared.js';

const MAX_EXPORTS_PER_FILE = 500;
const MAX_TYPE_NAME_LENGTH = 256;

/** Per-file resolved type bindings for exported symbols.
 *  Consumed by the cross-file re-resolution / enrichment pass. */
export type ExportedTypeMap = Map<string, Map<string, string>>;

/** Record one exported graph node into the incremental ExportedTypeMap. */
export const accumulateExportedTypesFromParsedNode = (
  result: ExportedTypeMap,
  node: { id: string; properties?: Record<string, unknown> },
  symbolTable: SymbolTableReader,
): void => {
  if (!node.properties?.isExported) return;
  if (!node.properties?.filePath || !node.properties?.name) return;
  const filePath = node.properties.filePath as string;
  const name = node.properties.name as string;
  if (!name || name.length > MAX_TYPE_NAME_LENGTH) return;
  const defs = symbolTable.lookupExactAll(filePath, name);
  const def = defs.find((d) => d.nodeId === node.id) ?? defs[0];
  if (!def) return;
  const typeName = def.returnType ?? def.declaredType;
  if (!typeName || typeName.length > MAX_TYPE_NAME_LENGTH) return;
  const simpleType = extractReturnTypeName(typeName) ?? typeName;
  if (!simpleType) return;
  let fileExports = result.get(filePath);
  if (!fileExports) {
    fileExports = new Map();
    result.set(filePath, fileExports);
  }
  if (fileExports.size < MAX_EXPORTS_PER_FILE) {
    fileExports.set(name, simpleType);
  }
};

/** Build ExportedTypeMap from graph nodes — used for the worker path where the
 *  sequential TypeEnv is not available in the main thread. Collects
 *  returnType/declaredType from exported symbols with known types. */
export function buildExportedTypeMapFromGraph(
  graph: KnowledgeGraph,
  symbolTable: SymbolTableReader,
): ExportedTypeMap {
  const result: ExportedTypeMap = new Map();
  graph.forEachNode((node) => {
    accumulateExportedTypesFromParsedNode(result, node, symbolTable);
  });
  return result;
}

/**
 * Confidence for route → controller-method CALLS edges. Framework-route
 * controller references (e.g. `OrderController::class` in `routes/web.php`)
 * resolve by global class name, so this matches the legacy `global`-tier
 * confidence the tiered resolver previously assigned these edges.
 */
const ROUTE_EDGE_CONFIDENCE = 0.5;

/**
 * Resolve a route's controller class from its normalized dot-joined
 * fully-qualified name (threaded by the Laravel extractor from a `use`/`::class`
 * reference). Two strategies, in order:
 *
 *   1. Direct qualified lookup — works when the type registry keys the class by
 *      its FQN (block-form namespaces, non-PHP frameworks, seeded test models).
 *   2. PSR-4 file-path disambiguation — PHP's common statement-form namespace
 *      (`namespace App\Http\Controllers;`) leaves the structure-phase
 *      `qualifiedName` as the *short* class name, so the registry has no FQN
 *      key. Instead, take the FQN's last segment as the class name, fetch the
 *      same-short-name candidates, and pick the one whose file path's tail
 *      matches the FQN's namespace tail (e.g. `App.Admin.OrderController` ↔
 *      `app/Admin/OrderController.php`). Requires ≥2 trailing segments (class +
 *      ≥1 namespace segment) and a unique winner — conservative, so a
 *      non-PSR-4 layout falls through to short-name resolution rather than
 *      guessing.
 *
 * Returns the resolved class, or `undefined` when the FQN cannot be uniquely
 * resolved (the caller then falls back to bare short-name resolution).
 */
function resolveControllerByQualifiedName(
  model: SemanticModel,
  fqn: string,
): SymbolDefinition | undefined {
  const direct = model.types.lookupClassByQualifiedName(fqn);
  if (direct.length === 1) return direct[0];

  const fqnSegments = fqn.split('.');
  const shortName = fqnSegments[fqnSegments.length - 1];
  if (!shortName) return undefined;

  const candidates = model.types.lookupClassByName(shortName);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return undefined;

  let best: SymbolDefinition | undefined;
  let bestScore = 0;
  let tie = false;
  for (const candidate of candidates) {
    // Compare the FQN's namespace tail against the file path's directory tail
    // (PSR-4: `App\Admin\OrderController` ↔ `app/Admin/OrderController.php`).
    // Split on `/` (a path separator normalizeQualifiedName does not touch).
    const fileBase = candidate.filePath.replace(/\.[^./]+$/, '');
    const fileSegments = fileBase.split('/').filter((s) => s.length > 0);
    let score = 0;
    while (
      score < fqnSegments.length &&
      score < fileSegments.length &&
      fqnSegments[fqnSegments.length - 1 - score].toLowerCase() ===
        fileSegments[fileSegments.length - 1 - score].toLowerCase()
    ) {
      score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
      tie = false;
    } else if (score === bestScore) {
      tie = true;
    }
  }
  // Need the class name + at least one namespace segment to disambiguate, and a
  // single unambiguous winner.
  return bestScore >= 2 && !tie ? best : undefined;
}

/**
 * Create CALLS edges from extracted framework routes (e.g. Laravel) to their
 * controller methods. Runs for all languages — independent of call resolution.
 *
 * Resolution is registry-based (RING4-2 #943 retired the tiered resolver):
 *   - Controller: **qualified-first** (see {@link resolveControllerByQualifiedName}).
 *     When the routes file disambiguated the controller, the Laravel extractor
 *     threads `route.controllerQualifiedName` (a `use` import — incl. aliased
 *     `use … as X;` — or an inline qualified `::class`, normalized to the dot-
 *     joined key shape). The emitter resolves it by direct qualified lookup, or
 *     by PSR-4 file-path disambiguation when PHP's statement-form namespace left
 *     the registry keyed only by the short name — either way picking the
 *     specific class even when the short name is globally duplicated (the common
 *     admin/public `OrderController` split) or aliased. It falls back to the
 *     global short-name lookup (`lookupClassByName`), which still skips on
 *     ambiguity (`length !== 1`) — so a bare, genuinely ambiguous short name
 *     with no `use`/FQN correctly produces no (wrong) edge.
 *   - Method: resolved within the controller's own file via the symbol table
 *     (the legacy emitter only accepted same-file method resolutions).
 *
 * Edge confidence is a flat {@link ROUTE_EDGE_CONFIDENCE}. Route CALLS edges
 * are gated downstream by the process-trace (`MIN_TRACE_CONFIDENCE`) and
 * large-graph community (`MIN_CONFIDENCE_LARGE`) thresholds (both 0.5); a
 * resolved edge lands at exactly 0.5 and passes (`>= 0.5`). The guessed-method
 * fallback edge (`× 0.8` = 0.4) sits below the gate and is excluded from those
 * passes — acceptable for an edge whose target method could not be resolved.
 */
export const processRoutesFromExtracted = async (
  graph: KnowledgeGraph,
  extractedRoutes: ExtractedRoute[],
  model: SemanticModel,
  onProgress?: (current: number, total: number) => void,
) => {
  for (let i = 0; i < extractedRoutes.length; i++) {
    const route = extractedRoutes[i];
    if (i % 50 === 0) {
      onProgress?.(i, extractedRoutes.length);
      await yieldToEventLoop();
    }

    if (!route.controllerName || !route.methodName) continue;

    // Resolve the controller class. Qualified-first: when the routes file
    // disambiguated the controller (a `use` import or inline `::class` FQN, both
    // normalized to the registry's dot-joined key shape by the extractor), look
    // it up by qualified name — this resolves aliased imports and same-short-name
    // controllers in different namespaces. Fall back to the global short-name
    // lookup, which still refuses ambiguous matches (`length !== 1 → skip`),
    // mirroring the legacy global tier.
    let controllerDef: SymbolDefinition | undefined;
    if (route.controllerQualifiedName) {
      controllerDef = resolveControllerByQualifiedName(model, route.controllerQualifiedName);
    }
    if (!controllerDef) {
      const controllerDefs = model.types.lookupClassByName(route.controllerName);
      if (controllerDefs.length !== 1) continue;
      controllerDef = controllerDefs[0];
    }

    const confidence = ROUTE_EDGE_CONFIDENCE;

    // Method must live in the controller's own file (the legacy emitter only
    // accepted same-file method resolutions).
    const methodDefs = model.symbols.lookupExactAll(controllerDef.filePath, route.methodName);
    const methodId = methodDefs[0]?.nodeId;
    const sourceId = generateId('File', route.filePath);

    if (!methodId) {
      const guessedId = generateId('Method', `${controllerDef.filePath}:${route.methodName}`);
      const relId = generateId('CALLS', `${sourceId}:route->${guessedId}`);
      graph.addRelationship({
        id: relId,
        sourceId,
        targetId: guessedId,
        type: 'CALLS',
        confidence: confidence * 0.8,
        reason: 'laravel-route',
      });
      continue;
    }

    const relId = generateId('CALLS', `${sourceId}:route->${methodId}`);
    graph.addRelationship({
      id: relId,
      sourceId,
      targetId: methodId,
      type: 'CALLS',
      confidence,
      reason: 'laravel-route',
    });
  }

  onProgress?.(extractedRoutes.length, extractedRoutes.length);
};

/**
 * Resolve each route's handler to a real symbol UID, keyed by the route's
 * `(method, url)` identity (`routeNodeKey` — the same key the routes phase uses
 * for the `Route` node). This is the Part 2 (#2138) groundwork that lets
 * `HttpRouteExtractor.extractProvidersGraph` read the handler symbol from the
 * graph instead of re-parsing source via `getDetections()`.
 *
 * Two route shapes, one resolution target — `(filePath, name) → nodeId`:
 *   - Laravel framework routes (`ExtractedRoute`) carry `controllerName` +
 *     `methodName`; resolve the controller (qualified-first) then the method in
 *     the controller's own file (mirrors `processRoutesFromExtracted`).
 *   - Decorator routes (`ExtractedDecoratorRoute`, e.g. Spring/FastAPI) carry
 *     `handlerName` (the decorated method, captured at extraction); resolve it
 *     directly in the route's own file.
 *
 * First-writer-wins per route identity, matching the routes phase's dedup (it
 * keeps the first route registered for a `(method, url)` key and counts the rest
 * as duplicates). The first route to claim a key reserves it **even when its
 * handler is unresolvable**, so a later same-key route can never stamp its
 * handler onto the first route's Route node (the routes phase made that first
 * route the node-winner). Keying is `routeNodeKey(method, url)` (#2289): a
 * same-URL multi-verb pair (`GET /x` + `POST /x`) resolves two handlers, one per
 * node; method-less / wildcard routes key by URL alone, byte-identical to the
 * pre-#2289 behavior. Routes whose handler cannot be *uniquely* resolved (no
 * name, zero matches, or an ambiguous same-name match) carry no
 * `handlerSymbolId`; the extractor then falls back to source scan for that route
 * (fail-open, no regression, never a wrong handler).
 */
export function resolveRouteHandlerSymbols(
  model: SemanticModel,
  extractedRoutes: readonly ExtractedRoute[],
  decoratorRoutes: readonly ExtractedDecoratorRoute[],
): Map<string, string> {
  const out = new Map<string, string>();
  // Route identities already claimed by an earlier route (resolved or not).
  // Mirrors the routes phase `addRoute` first-writer-wins so the handler we
  // stamp always belongs to the route that actually won the Route node.
  const claimed = new Set<string>();

  // Resolve a single same-file symbol by name, refusing to guess on ambiguity:
  // exactly one match → its nodeId; zero or many → undefined (fail-open).
  const uniqueSymbolId = (filePath: string, name: string): string | undefined => {
    const defs = model.symbols.lookupExactAll(filePath, name);
    return defs.length === 1 ? defs[0]?.nodeId : undefined;
  };

  const claim = (
    routePath: string | null,
    prefix: string | null,
    httpMethod: string | null | undefined,
    symbolId: string | undefined,
  ) => {
    if (!routePath) return;
    const url = normalizeExtractedRoutePath(routePath, prefix);
    const key = routeNodeKey(normalizeRouteMethod(httpMethod), url);
    if (claimed.has(key)) return; // first-writer-wins: later same-key routes can't override
    claimed.add(key);
    if (symbolId) out.set(key, symbolId);
  };

  // Laravel framework routes — controller class + method name.
  for (const route of extractedRoutes) {
    let methodId: string | undefined;
    if (route.controllerName && route.methodName) {
      let controllerDef: SymbolDefinition | undefined;
      if (route.controllerQualifiedName) {
        controllerDef = resolveControllerByQualifiedName(model, route.controllerQualifiedName);
      }
      if (!controllerDef) {
        const controllerDefs = model.types.lookupClassByName(route.controllerName);
        if (controllerDefs.length === 1) controllerDef = controllerDefs[0];
      }
      if (controllerDef) methodId = uniqueSymbolId(controllerDef.filePath, route.methodName);
    }
    claim(route.routePath, route.prefix ?? null, route.httpMethod, methodId);
  }

  // Decorator routes (Spring / FastAPI / generic) — the decorated handler in
  // the route's own file.
  for (const dr of decoratorRoutes) {
    const handlerId = dr.handlerName ? uniqueSymbolId(dr.filePath, dr.handlerName) : undefined;
    claim(dr.routePath, dr.prefix ?? null, dr.httpMethod, handlerId);
  }

  return out;
}

/** Common method names on response/data objects that are NOT property accesses */
// Properties/methods to ignore when extracting consumer accessed keys from `data.X` patterns.
// Avoids false positives from Fetch API, Array, Object, Promise, and DOM access on variables
// that happen to share names with response variables (data, result, response, etc.).
const RESPONSE_ACCESS_BLOCKLIST = new Set([
  // Fetch/Response API
  'json',
  'text',
  'blob',
  'arrayBuffer',
  'formData',
  'ok',
  'status',
  'headers',
  'clone',
  // Promise
  'then',
  'catch',
  'finally',
  // Array
  'map',
  'filter',
  'forEach',
  'reduce',
  'find',
  'some',
  'every',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'slice',
  'concat',
  'join',
  'sort',
  'reverse',
  'includes',
  'indexOf',
  // Object
  'length',
  'toString',
  'valueOf',
  'keys',
  'values',
  'entries',
  // DOM methods — file-download patterns often reuse `data`/`response` variable names
  'appendChild',
  'removeChild',
  'insertBefore',
  'replaceChild',
  'replaceChildren',
  'createElement',
  'getElementById',
  'querySelector',
  'querySelectorAll',
  'setAttribute',
  'getAttribute',
  'removeAttribute',
  'hasAttribute',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'classList',
  'className',
  'parentNode',
  'parentElement',
  'childNodes',
  'children',
  'nextSibling',
  'previousSibling',
  'firstChild',
  'lastChild',
  'click',
  'focus',
  'blur',
  'submit',
  'reset',
  'innerHTML',
  'outerHTML',
  'textContent',
  'innerText',
]);

/**
 * Extract property access keys from a consumer file's source code near fetch calls.
 *
 * Looks for destructuring (`const { data } = await res.json()`), property access
 * (`response.data`), and optional chaining (`data?.key`). Returns deduplicated
 * top-level property names accessed on the response. Scans the whole file, so
 * all accessed keys are attributed to each fetch — acceptable for regex-based
 * extraction.
 */
export const extractConsumerAccessedKeys = (content: string): string[] => {
  const keys = new Set<string>();

  // Pattern 1: Destructuring from .json() — const { key1, key2 } = await res.json()
  // Also matches: const { key1, key2 } = await (await fetch(...)).json()
  const destructurePattern =
    /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:await\s+)?(?:\w+\.json\s*\(\)|(?:await\s+)?(?:fetch|axios|got)\s*\([^)]*\)(?:\.then\s*\([^)]*\))?(?:\.json\s*\(\))?)/g;
  let match;
  while ((match = destructurePattern.exec(content)) !== null) {
    const destructuredBody = match[1];
    // Extract identifiers from destructuring, handling renamed bindings (key: alias)
    const keyPattern = /(\w+)\s*(?::\s*\w+)?/g;
    let keyMatch;
    while ((keyMatch = keyPattern.exec(destructuredBody)) !== null) {
      keys.add(keyMatch[1]);
    }
  }

  // Pattern 2: Destructuring from a data/result/response/json variable
  // e.g., const { items, total } = data; or const { error } = result;
  const dataVarDestructure =
    /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:data|result|response|json|body|res)\b/g;
  while ((match = dataVarDestructure.exec(content)) !== null) {
    const destructuredBody = match[1];
    const keyPattern = /(\w+)\s*(?::\s*\w+)?/g;
    let keyMatch;
    while ((keyMatch = keyPattern.exec(destructuredBody)) !== null) {
      keys.add(keyMatch[1]);
    }
  }

  // Pattern 3: Property access on common response variable names
  // Matches: data.key, response.key, result.key, json.key, body.key
  // Also matches optional chaining: data?.key
  const propAccessPattern = /\b(?:data|response|result|json|body|res)\s*(?:\?\.|\.)(\w+)/g;
  while ((match = propAccessPattern.exec(content)) !== null) {
    const key = match[1];
    // Skip common method calls that aren't property accesses
    if (!RESPONSE_ACCESS_BLOCKLIST.has(key)) {
      keys.add(key);
    }
  }

  return [...keys];
};

/**
 * Create FETCHES edges from extracted fetch() calls to matching Route nodes.
 * When consumerContents is provided, extracts property access patterns from
 * consumer files and encodes them in the edge reason field.
 *
 * Matching stays URL-only (#2289): a verb-less consumer (a `fetch()` call has
 * no statically-known HTTP method) matches a route by URL and connects to
 * **every** Route node sharing that URL — i.e. both the `GET /x` and `POST /x`
 * nodes when a URL carries multiple verbs. `routeUrlToKeys` therefore maps each
 * route URL to the list of `routeNodeKey` identities at that URL; a single-verb
 * (or method-less) URL has a one-element list, keeping edges byte-identical to
 * the pre-#2289 behavior.
 */
export const processNextjsFetchRoutes = (
  graph: KnowledgeGraph,
  fetchCalls: ExtractedFetchCall[],
  routeUrlToKeys: Map<string, string[]>, // routeURL → route node keys at that URL
  consumerContents?: Map<string, string>, // filePath → file content
) => {
  // Pre-count how many route URLs each consumer file matches (for confidence
  // attribution). Counts once per call that matches any URL — independent of how
  // many verbs share that URL — so the multi-fetch heuristic is unchanged.
  const routeCountByFile = new Map<string, number>();
  for (const call of fetchCalls) {
    const normalized = normalizeFetchURL(call.fetchURL);
    if (!normalized) continue;
    for (const routeURL of routeUrlToKeys.keys()) {
      if (routeMatches(normalized, routeURL)) {
        routeCountByFile.set(call.filePath, (routeCountByFile.get(call.filePath) ?? 0) + 1);
        break;
      }
    }
  }

  for (const call of fetchCalls) {
    const normalized = normalizeFetchURL(call.fetchURL);
    if (!normalized) continue;

    for (const [routeURL, routeKeys] of routeUrlToKeys) {
      if (routeMatches(normalized, routeURL)) {
        const sourceId = generateId('File', call.filePath);

        // Extract consumer accessed keys if file content is available
        let reason = 'fetch-url-match';
        if (consumerContents) {
          const content = consumerContents.get(call.filePath);
          if (content) {
            const accessedKeys = extractConsumerAccessedKeys(content);
            if (accessedKeys.length > 0) {
              reason = `fetch-url-match|keys:${accessedKeys.join(',')}`;
            }
          }
        }

        // Encode multi-fetch count so downstream can set confidence
        const fetchCount = routeCountByFile.get(call.filePath) ?? 1;
        if (fetchCount > 1) {
          reason = `${reason}|fetches:${fetchCount}`;
        }

        // Connect to every Route node at this URL (one per verb).
        for (const routeKey of routeKeys) {
          const routeNodeId = generateId('Route', routeKey);
          graph.addRelationship({
            id: generateId('FETCHES', `${sourceId}->${routeNodeId}`),
            sourceId,
            targetId: routeNodeId,
            type: 'FETCHES',
            confidence: 0.9,
            reason,
          });
        }
        break;
      }
    }
  }
};
