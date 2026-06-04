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
 *   - `processNextjsFetchRoutes` / `extractFetchCallsFromFiles` /
 *     `extractConsumerAccessedKeys` — FETCHES edges from `fetch()` calls to
 *     Next.js Route nodes.
 *   - `buildExportedTypeMapFromGraph` — exported symbol → return/declared type
 *     map, consumed by the cross-file enrichment pass.
 */

import Parser from 'tree-sitter';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import type { SemanticModel, SymbolTableReader } from './model/index.js';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { getProvider } from './languages/index.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename } from 'gitnexus-shared';
import { yieldToEventLoop } from './utils/event-loop.js';
import { parseSourceSafe } from '../tree-sitter/safe-parse.js';
import { getTreeSitterBufferSize } from './constants.js';
import type { ExtractedRoute, ExtractedFetchCall } from './workers/parse-worker.js';
import { normalizeFetchURL, routeMatches } from './route-extractors/nextjs.js';
import { extractReturnTypeName } from './type-extractors/shared.js';

const MAX_EXPORTS_PER_FILE = 500;
const MAX_TYPE_NAME_LENGTH = 256;

/** Per-file resolved type bindings for exported symbols.
 *  Consumed by the cross-file re-resolution / enrichment pass. */
export type ExportedTypeMap = Map<string, Map<string, string>>;

/** Build ExportedTypeMap from graph nodes — used for the worker path where the
 *  sequential TypeEnv is not available in the main thread. Collects
 *  returnType/declaredType from exported symbols with known types. */
export function buildExportedTypeMapFromGraph(
  graph: KnowledgeGraph,
  symbolTable: SymbolTableReader,
): ExportedTypeMap {
  const result: ExportedTypeMap = new Map();
  graph.forEachNode((node) => {
    if (!node.properties?.isExported) return;
    if (!node.properties?.filePath || !node.properties?.name) return;
    const filePath = node.properties.filePath as string;
    const name = node.properties.name as string;
    if (!name || name.length > MAX_TYPE_NAME_LENGTH) return;
    // For callable symbols, use returnType; for properties/variables, use declaredType.
    // Use lookupExactAll + nodeId match to handle same-name methods in different classes.
    const defs = symbolTable.lookupExactAll(filePath, name);
    const def = defs.find((d) => d.nodeId === node.id) ?? defs[0];
    if (!def) return;
    const typeName = def.returnType ?? def.declaredType;
    if (!typeName || typeName.length > MAX_TYPE_NAME_LENGTH) return;
    // Extract simple type name (strip Promise<>, etc.) — reuse shared utility
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
 * Create CALLS edges from extracted framework routes (e.g. Laravel) to their
 * controller methods. Runs for all languages — independent of call resolution.
 *
 * Resolves the controller class by global name via the type registry
 * (`Registry.lookup` equivalent) and the method within the controller's file
 * via the symbol table — replacing the retired tiered name resolver
 * (RING4-2 #943).
 *
 * Intentional convergence (RING4-2): the legacy resolver could resolve a
 * controller at the *import-scoped* tier (0.9) by consulting the routes file's
 * named-import binding (`use App\Http\Controllers\OrderController;`, including
 * aliased `use … as Orders;`). That per-file import map was deleted with the
 * tiered resolver, so all route controllers now resolve by **global class
 * name** at a flat {@link ROUTE_EDGE_CONFIDENCE}. Accepted consequences:
 *   1. An imported controller resolving to a *unique* global class keeps its
 *      edge (same target) but the confidence collapses 0.9 → 0.5.
 *   2. An import-disambiguated controller whose short name is *not* globally
 *      unique now loses its edge entirely (not just confidence): two
 *      `OrderController`s in different namespaces → `lookupClassByName` returns
 *      2 → the emitter skips. The legacy import-scoped tier resolved these to
 *      the specific imported class and emitted the edge; global resolution
 *      cannot, because the disambiguating per-file `use` map is gone. (This is
 *      stricter than — not the same as — the legacy *global*-tier `>1 → skip`
 *      guard, which only applied when no `use` binding existed.)
 *   3. An aliased import (`use … as Orders; [Orders::class, 'm']`) resolves the
 *      *alias* token as the class name; since the class is registered under its
 *      declared name, `lookupClassByName('Orders')` is empty → no edge.
 * All three produce only *missing* edges, never a wrong target. The patterns
 * (multi-namespace same-short-name controllers, aliased controller imports)
 * are uncommon, and re-disambiguating would require re-introducing the deleted
 * per-file import map — out of scope for the registry-only resolution model.
 *
 * Confidence-threshold impact: route CALLS edges are filtered by the
 * process-trace (`MIN_TRACE_CONFIDENCE`) and large-graph community
 * (`MIN_CONFIDENCE_LARGE`) gates, both 0.5. A *resolved* route edge lands at
 * exactly 0.5 and still passes (`>= 0.5` / not `< 0.5`), so the 0.9 → 0.5
 * flattening does not change its downstream treatment. The only edge that
 * crosses the gate is the narrow imported-controller-with-unresolved-method
 * case, whose guessed edge drops 0.9×0.8=0.72 → 0.5×0.8=0.4 and is excluded
 * from process traces / large-graph communities — an acceptable loss for an
 * already-heuristic edge whose target method could not be resolved.
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

    // Controller resolves by global class name. Refuse ambiguous matches —
    // mirrors the legacy global-tier "candidates.length > 1 → skip" guard.
    const controllerDefs = model.types.lookupClassByName(route.controllerName);
    if (controllerDefs.length !== 1) continue;

    const controllerDef = controllerDefs[0];
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
 */
export const processNextjsFetchRoutes = (
  graph: KnowledgeGraph,
  fetchCalls: ExtractedFetchCall[],
  routeRegistry: Map<string, string>, // routeURL → handlerFilePath
  consumerContents?: Map<string, string>, // filePath → file content
) => {
  // Pre-count how many routes each consumer file matches (for confidence attribution)
  const routeCountByFile = new Map<string, number>();
  for (const call of fetchCalls) {
    const normalized = normalizeFetchURL(call.fetchURL);
    if (!normalized) continue;
    for (const [routeURL] of routeRegistry) {
      if (routeMatches(normalized, routeURL)) {
        routeCountByFile.set(call.filePath, (routeCountByFile.get(call.filePath) ?? 0) + 1);
        break;
      }
    }
  }

  for (const call of fetchCalls) {
    const normalized = normalizeFetchURL(call.fetchURL);
    if (!normalized) continue;

    for (const [routeURL] of routeRegistry) {
      if (routeMatches(normalized, routeURL)) {
        const sourceId = generateId('File', call.filePath);
        const routeNodeId = generateId('Route', routeURL);

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

        graph.addRelationship({
          id: generateId('FETCHES', `${sourceId}->${routeNodeId}`),
          sourceId,
          targetId: routeNodeId,
          type: 'FETCHES',
          confidence: 0.9,
          reason,
        });
        break;
      }
    }
  }
};

/**
 * Extract fetch() calls from source files (sequential path).
 * Workers handle this via tree-sitter captures in parse-worker; this function
 * provides the same extraction for the sequential fallback path.
 */
export const extractFetchCallsFromFiles = async (
  files: { path: string; content: string }[],
  astCache: ASTCache,
): Promise<ExtractedFetchCall[]> => {
  const parser = await loadParser();
  const result: ExtractedFetchCall[] = [];

  for (const file of files) {
    const language = getLanguageFromFilename(file.path);
    if (!language) continue;
    if (!isLanguageAvailable(language)) continue;

    const provider = getProvider(language);
    const queryStr = provider.treeSitterQueries;
    if (!queryStr) continue;

    await loadLanguage(language, file.path);

    let tree = astCache.get(file.path);
    if (!tree) {
      const parseContent = provider.preprocessSource?.(file.content, file.path) ?? file.content;
      try {
        tree = parseSourceSafe(parser, parseContent, undefined, {
          bufferSize: getTreeSitterBufferSize(parseContent),
        });
      } catch {
        continue;
      }
      astCache.set(file.path, tree);
    }

    let matches;
    try {
      const lang = parser.getLanguage();
      const query = new Parser.Query(lang, queryStr);
      matches = query.matches(tree.rootNode);
    } catch {
      continue;
    }

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      match.captures.forEach((c) => (captureMap[c.name] = c.node));

      if (captureMap['route.fetch']) {
        const urlNode = captureMap['route.url'] ?? captureMap['route.template_url'];
        if (urlNode) {
          result.push({
            filePath: file.path,
            fetchURL: urlNode.text,
            lineNumber: captureMap['route.fetch'].startPosition.row,
          });
        }
      } else if (captureMap['http_client'] && captureMap['http_client.url']) {
        const method = captureMap['http_client.method']?.text;
        const url = captureMap['http_client.url'].text;
        const HTTP_CLIENT_ONLY = new Set(['head', 'options', 'request', 'ajax']);
        if (method && HTTP_CLIENT_ONLY.has(method) && url.startsWith('/')) {
          result.push({
            filePath: file.path,
            fetchURL: url,
            lineNumber: captureMap['http_client'].startPosition.row,
          });
        }
      }
    }
  }

  return result;
};
