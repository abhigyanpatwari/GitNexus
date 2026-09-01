/**
 * Phase: routes
 *
 * Builds the route registry (Next.js, Expo, PHP, Laravel, decorator-based)
 * and creates Route graph nodes + HANDLES_ROUTE edges.
 * Also links middleware, processes fetch() calls, and scans HTML templates.
 *
 * @deps    parse
 * @reads   allPaths, allExtractedRoutes, allDecoratorRoutes, allFetchCalls
 * @writes  graph (Route nodes, HANDLES_ROUTE, FETCHES_FROM edges)
 * @output  routeRegistry, handlerContents
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ParseOutput } from './parse.js';
import { isBladeTemplateFilename } from 'gitnexus-shared';
import { nextjsFileToRouteURL, normalizeFetchURL } from '../route-extractors/nextjs.js';
import { expoFileToRouteURL } from '../route-extractors/expo.js';
import { phpFileToRouteURL } from '../route-extractors/php.js';
import {
  extractResponseShapes,
  extractPHPResponseShapes,
} from '../route-extractors/response-shapes.js';
import {
  extractMiddlewareChain,
  extractNextjsMiddlewareConfig,
  compileMatcher,
  compiledMatcherMatchesRoute,
} from '../route-extractors/middleware.js';
import { processNextjsFetchRoutes } from '../call-processor.js';
import { reconcileDispatchGuardRoutes } from '../route-extractors/dispatch-guard.js';
import { DATA_ROUTE_TABLE_SOURCE } from '../route-extractors/data-route-table.js';
import {
  normalizeExtractedRoutePath,
  normalizeRouteMethod,
  routeNodeKey,
} from '../route-extractors/route-path.js';
import { generateId } from '../../../lib/utils.js';
import { readFileContents } from '../filesystem-walker.js';
import { isDev } from '../utils/env.js';

import { logger } from '../../logger.js';
const EXPO_NAV_PATTERNS = [
  /router\.(push|replace|navigate)\(\s*['"`]([^'"`]+)['"`]/g,
  /<Link\s+[^>]*href=\s*['"`]([^'"`]+)['"`]/g,
];

export interface RouteEntry {
  filePath: string;
  source: string;
  /**
   * The route's URL path (leading-slash, prefix-joined). This is the Route
   * node's `name`. Stored explicitly because the registry is keyed by the
   * `(method, url)` identity (`routeNodeKey`), so the key is no longer the URL
   * — downstream URL consumers (middleware/fetch matching) read this instead.
   */
  url: string;
  /**
   * HTTP verb for this route when ingestion knows it structurally
   * (Spring/Laravel framework routes and decorator routes carry
   * `httpMethod`; filesystem-derived routes — Next.js/Expo/PHP file
   * routes — do not, so this stays undefined for them). Persisted onto
   * the Route node so downstream contract extraction can read the verb
   * from the graph instead of re-parsing the handler source.
   */
  method?: string;
}

export interface RoutesOutput {
  routeRegistry: Map<string, RouteEntry>;
}

export interface TemplateFetchCall {
  filePath: string;
  fetchURL: string;
  lineNumber: number;
}

function handlerSymbolContent(
  content: string,
  handlerNode: { properties: Record<string, unknown> } | undefined,
): string | undefined {
  if (handlerNode === undefined) return undefined;
  const startLine = handlerNode.properties.startLine;
  const endLine = handlerNode.properties.endLine;
  if (
    typeof startLine !== 'number' ||
    typeof endLine !== 'number' ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 0 ||
    endLine < startLine
  ) {
    return undefined;
  }
  return content
    .split(/\r?\n/)
    .slice(startLine, endLine + 1)
    .join('\n');
}

const TEMPLATE_URL_PATTERNS: readonly RegExp[] = [
  /\b(?:action|href)\s*=\s*["']([^"']+)["']/gi,
  /\burl\s*:\s*["']([^"']+)["'](?!\s*\+)/g,
  // Laravel asset() points at static assets, not application routes; keep it
  // out of route matching so asset paths cannot collide with real route URLs.
  /\{\{[\s\S]{0,200}?\burl\(\s*["']([^"']+)["']\s*\)[\s\S]{0,200}?\}\}/g,
  /\{!![\s\S]{0,200}?\burl\(\s*["']([^"']+)["']\s*\)[\s\S]{0,200}?!\}/g,
];

const TEMPLATE_NAMED_ROUTE_PATTERNS: readonly RegExp[] = [
  // Parameterless Laravel route('name') helpers can be resolved from extracted
  // route names. Parameterized helpers are intentionally deferred because they
  // require binding runtime values onto route placeholders.
  /\{\{[\s\S]{0,200}?\broute\(\s*["']([^"']+)["']\s*\)[\s\S]{0,200}?\}\}/g,
  /\{!![\s\S]{0,200}?\broute\(\s*["']([^"']+)["']\s*\)[\s\S]{0,200}?!\}/g,
];

function hasRouteParameters(routeUrl: string): boolean {
  return /\{[^}]+\}/.test(routeUrl);
}

export const isTemplateRouteCandidate = (filePath: string): boolean => {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.endsWith('.html') ||
    normalized.endsWith('.htm') ||
    normalized.endsWith('.ejs') ||
    normalized.endsWith('.hbs') ||
    isBladeTemplateFilename(normalized)
  );
};

export function extractTemplateStaticFetchCalls(
  filePath: string,
  content: string,
  namedRouteUrls: ReadonlyMap<string, string> = new Map(),
): TemplateFetchCall[] {
  const calls: TemplateFetchCall[] = [];
  const seen = new Set<string>();

  for (const pattern of TEMPLATE_URL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const normalized = normalizeFetchURL(match[1]);
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      calls.push({ filePath, fetchURL: normalized, lineNumber: 0 });
    }
  }

  for (const pattern of TEMPLATE_NAMED_ROUTE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const routeUrl = namedRouteUrls.get(match[1]);
      if (!routeUrl) continue;
      if (hasRouteParameters(routeUrl)) continue;
      const normalized = normalizeFetchURL(routeUrl);
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      calls.push({ filePath, fetchURL: normalized, lineNumber: 0 });
    }
  }

  return calls;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const routesPhase: PipelinePhase<RoutesOutput> = {
  name: 'routes',
  deps: ['parse'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<RoutesOutput> {
    const {
      allPaths,
      allFetchCalls: parseFetchCalls,
      allFetchWrapperDefs,
      allExtractedRoutes,
      allDecoratorRoutes,
      routeHandlerSymbols,
    } = getPhaseOutput<ParseOutput>(deps, 'parse');

    // Local copy — routes phase must not mutate upstream ParseOutput
    const allFetchCalls = [...parseFetchCalls];

    const routeRegistry = new Map<string, RouteEntry>();
    /**
     * Registry keys written straight from the file list below, never through
     * `addRoute`. `resolveRouteHandlerSymbols` walks only `extractedRoutes` and
     * `decoratorRoutes`, so it never sees these URLs and its `claimed` set never
     * contains them — which means a handler stamped on one of these keys was
     * resolved for a DIFFERENT route.
     *
     * That is reachable, and it fabricates rather than omits (#3049). A
     * method-agnostic route (`@All`, a Django function view, a verb-less
     * dispatch guard) keys by URL alone via `routeNodeKey`, so it collides with
     * a file-convention route at the same URL. It claims the key unopposed in
     * `claim()`, then loses first-writer-wins here in `addRoute` and is dropped
     * as a duplicate — and without this guard the surviving file-convention node
     * would read that handler and present another application's controller
     * method as its own. `api_impact` is documented to be run BEFORE editing a
     * route handler, so it would answer with a handler from the wrong app.
     *
     * Dropping the losing route is a separate and deliberate consequence of
     * URL-only identity; this only stops the false attribution.
     *
     * Membership is recorded AT the pre-seeding `set`, mirroring `claim()` in
     * call-processor.ts, which writes `claimed` and its result map together
     * rather than re-deriving either by rescanning. Identifying pre-seeded
     * entries by matching `entry.source` against a list of source strings would
     * spell them a second time, away from the sites that produce them — and a
     * fourth pre-seeded source added later would then reopen #3049 in silence.
     * `addRoute` deliberately does NOT record here: its routes ARE
     * handler-resolved, so suppressing them would widen the guard into a bug of
     * its own.
     *
     * Each `add` below sits inside its own `!routeRegistry.has(key)` gate, as
     * every `routeRegistry.set` in this phase does: the map is write-once per
     * key, so a losing candidate cannot record a key it did not claim and no
     * later writer can take a recorded key away. Key-membership is therefore
     * equivalent to source-matching by construction — pre-seeded routes carry no
     * verb and `routeNodeKey(undefined, url) === url` — which is why the
     * two-candidates-one-URL case needs no fixture to settle it.
     */
    const preSeededKeys = new Set<string>();

    // Detect Expo Router app/ roots vs Next.js app/ roots (monorepo-safe)
    const expoAppRoots = new Set<string>();
    const nextjsAppRoots = new Set<string>();
    const expoAppPaths = new Set<string>();
    for (const p of allPaths) {
      const norm = p.replace(/\\/g, '/');
      const appIdx = norm.lastIndexOf('app/');
      if (appIdx < 0) continue;
      const root = norm.slice(0, appIdx + 4);
      if (/\/_layout\.(tsx?|jsx?)$/.test(norm)) expoAppRoots.add(root);
      if (/\/page\.(tsx?|jsx?)$/.test(norm)) nextjsAppRoots.add(root);
    }
    for (const root of nextjsAppRoots) expoAppRoots.delete(root);
    if (expoAppRoots.size > 0) {
      for (const p of allPaths) {
        const norm = p.replace(/\\/g, '/');
        const appIdx = norm.lastIndexOf('app/');
        if (appIdx >= 0 && expoAppRoots.has(norm.slice(0, appIdx + 4))) expoAppPaths.add(p);
      }
    }

    // One writer for every pre-seeded route, so recording membership cannot be
    // forgotten. Inlining `has` / `set` / `add` at each site made the invariant
    // a convention three call sites had to remember — and a fourth source that
    // forgot the `add` would reopen #3049 exactly as silently as the source-set
    // it replaced. This is the shape `claim()` in call-processor.ts uses for the
    // same reason: one helper writes the collection and its key set together.
    const preSeed = (url: string, entry: Omit<RouteEntry, 'url'>): boolean => {
      if (routeRegistry.has(url)) return false;
      routeRegistry.set(url, { ...entry, url });
      preSeededKeys.add(url);
      return true;
    };

    for (const p of allPaths) {
      if (expoAppPaths.has(p)) {
        const expoURL = expoFileToRouteURL(p);
        if (expoURL && preSeed(expoURL, { filePath: p, source: 'expo-filesystem-route' })) {
          continue;
        }
      }
      const nextjsURL = nextjsFileToRouteURL(p);
      if (nextjsURL && preSeed(nextjsURL, { filePath: p, source: 'nextjs-filesystem-route' })) {
        continue;
      }
      if (p.endsWith('.php')) {
        const phpURL = phpFileToRouteURL(p);
        if (phpURL) preSeed(phpURL, { filePath: p, source: 'php-file-route' });
      }
    }

    let duplicateRoutes = 0;
    const namedRouteRegistry = new Map<string, string>();
    // Routes are keyed by their `(method, url)` identity (#2289): a same-URL
    // multi-verb pair (`GET /x` + `POST /x`) is two entries, not one. Method-less
    // / wildcard routes key by URL (see `routeNodeKey`), so filesystem/resource
    // routes stay byte-identical. A true duplicate (same method AND url) is still
    // dropped.
    const addRoute = (url: string, entry: Omit<RouteEntry, 'url'>) => {
      const key = routeNodeKey(entry.method, url);
      if (routeRegistry.has(key)) {
        duplicateRoutes++;
        return;
      }
      routeRegistry.set(key, { ...entry, url });
    };
    for (const route of allExtractedRoutes) {
      if (!route.routePath) continue;
      const routeUrl = normalizeExtractedRoutePath(route.routePath, route.prefix);
      addRoute(routeUrl, {
        filePath: route.filePath,
        source: 'framework-route',
        method: normalizeRouteMethod(route.httpMethod),
      });
      if (route.routeName && !namedRouteRegistry.has(route.routeName)) {
        namedRouteRegistry.set(route.routeName, routeUrl);
      }
    }
    // A dispatch-guard route observed WITHOUT a verb is dropped when the same
    // URL is claimed WITH one anywhere in the repo — the split route-table
    // idiom, which no single file can reconcile. Framework routes are untouched;
    // their verb-less form is a declaration, not a weaker observation.
    for (const dr of reconcileDispatchGuardRoutes(allDecoratorRoutes)) {
      const url = normalizeExtractedRoutePath(dr.routePath, dr.prefix ?? null);
      const method = normalizeRouteMethod(dr.httpMethod);
      const routeKey = routeNodeKey(method, url);
      // A data-table entry is only a provider route once its static handler has
      // been proven. Other route sources retain their historical fallback.
      if (dr.source === DATA_ROUTE_TABLE_SOURCE && !routeHandlerSymbols.has(routeKey)) continue;
      addRoute(url, {
        filePath: dr.filePath,
        // A route extracted from a file's own AST is usually a decorator; a
        // dispatch guard is the same transport with different provenance, and
        // says so (`ExtractedDecoratorRoute.source`).
        source: dr.source ?? `decorator-${dr.decoratorName}`,
        method,
      });
    }

    let handlerContents: Map<string, string> | undefined;
    if (routeRegistry.size > 0) {
      const handlerPathFor = (routeKey: string, entry: RouteEntry): string => {
        if (entry.source !== DATA_ROUTE_TABLE_SOURCE) return entry.filePath;
        const handlerSymbolId = routeHandlerSymbols.get(routeKey);
        const resolvedPath = handlerSymbolId
          ? ctx.graph.getNode(handlerSymbolId)?.properties.filePath
          : undefined;
        return typeof resolvedPath === 'string' ? resolvedPath : entry.filePath;
      };
      const handlerPaths = [...routeRegistry].map(([key, entry]) => handlerPathFor(key, entry));
      handlerContents = await readFileContents(ctx.repoPath, handlerPaths);

      for (const [routeKey, entry] of routeRegistry) {
        const { source: routeSource, method: routeMethod, url } = entry;
        const handlerPath = handlerPathFor(routeKey, entry);
        const content = handlerContents.get(handlerPath);
        // A pre-seeded route can never legitimately appear in
        // `routeHandlerSymbols`, so a key that does is a route that LOST (#3049).
        const handlerSymbolId = preSeededKeys.has(routeKey)
          ? undefined
          : routeHandlerSymbols.get(routeKey);
        const analysisContent =
          entry.source === DATA_ROUTE_TABLE_SOURCE && content
            ? handlerSymbolContent(
                content,
                handlerSymbolId ? ctx.graph.getNode(handlerSymbolId) : undefined,
              )
            : content;

        const { responseKeys, errorKeys } = analysisContent
          ? handlerPath.endsWith('.php')
            ? extractPHPResponseShapes(analysisContent)
            : extractResponseShapes(analysisContent)
          : { responseKeys: undefined, errorKeys: undefined };

        const mwResult = analysisContent ? extractMiddlewareChain(analysisContent) : undefined;
        const middleware = mwResult?.chain;

        const routeNodeId = generateId('Route', routeKey);
        ctx.graph.addNode({
          id: routeNodeId,
          label: 'Route',
          properties: {
            name: url,
            filePath: handlerPath,
            ...(routeMethod ? { method: routeMethod } : {}),
            ...(handlerSymbolId ? { handlerSymbolId } : {}),
            ...(responseKeys ? { responseKeys } : {}),
            ...(errorKeys ? { errorKeys } : {}),
            ...(middleware && middleware.length > 0 ? { middleware } : {}),
          },
        });

        const handlerFileId = generateId('File', handlerPath);
        ctx.graph.addRelationship({
          id: generateId('HANDLES_ROUTE', `${handlerFileId}->${routeNodeId}`),
          sourceId: handlerFileId,
          targetId: routeNodeId,
          type: 'HANDLES_ROUTE',
          confidence: 1.0,
          reason: routeSource,
        });

        // Definition-level HANDLES_ROUTE, emitted alongside the file-level edge
        // whenever the handler symbol resolved.
        //
        // Why both: the file-level edge is what `http-route-extractor.ts` reads
        // (its query is typed `(handlerFile:File)`), so it stays. But a FILE does
        // not handle a route — a function does, and without an edge to it the
        // handler carries no relationship at all beyond `DEFINES`. Every
        // decorated handler then looks exactly like dead code even though the
        // framework invokes it, and blast-radius analysis from a route stops at
        // file granularity.
        //
        // This mirrors the sibling decorator overlay: `pipeline-phases/tools.ts`
        // already anchors HANDLES_TOOL on the definition the decorator sat on,
        // not on its file. Routes were the outlier.
        //
        // `Function|Route` and its siblings are already declared by the
        // ATTACHMENT rule in `lbug/schema.ts`
        // (`DEFINITION_ANCHOR_LABELS × ATTACHMENT_TARGET_LABELS`), which that
        // file documents as deliberate headroom for exactly this case — so no
        // new pair is needed and `assertDeclaredPair` cannot abort on it.
        if (handlerSymbolId) {
          ctx.graph.addRelationship({
            id: generateId('HANDLES_ROUTE', `${handlerSymbolId}->${routeNodeId}`),
            sourceId: handlerSymbolId,
            targetId: routeNodeId,
            type: 'HANDLES_ROUTE',
            confidence: 1.0,
            reason: routeSource,
          });
        }
      }

      if (isDev) {
        logger.info(
          `🗺️ Route registry: ${routeRegistry.size} routes${duplicateRoutes > 0 ? ` (${duplicateRoutes} duplicate URLs skipped)` : ''}`,
        );
      }
    }

    // ── Link Next.js project-level middleware.ts to routes ──
    if (routeRegistry.size > 0) {
      const middlewareCandidates = allPaths.filter(
        (p) =>
          p === 'middleware.ts' ||
          p === 'middleware.js' ||
          p === 'middleware.tsx' ||
          p === 'middleware.jsx' ||
          p === 'src/middleware.ts' ||
          p === 'src/middleware.js' ||
          p === 'src/middleware.tsx' ||
          p === 'src/middleware.jsx',
      );
      if (middlewareCandidates.length > 0) {
        const mwContents = await readFileContents(ctx.repoPath, middlewareCandidates);
        for (const [mwPath, mwContent] of mwContents) {
          const config = extractNextjsMiddlewareConfig(mwContent);
          if (!config) continue;
          const mwLabel =
            config.wrappedFunctions.length > 0 ? config.wrappedFunctions : [config.exportedName];

          const compiled = config.matchers
            .map(compileMatcher)
            .filter((m): m is NonNullable<typeof m> => m !== null);

          let linkedCount = 0;
          for (const [routeKey, entry] of routeRegistry) {
            const matches =
              compiled.length === 0 ||
              compiled.some((cm) => compiledMatcherMatchesRoute(cm, entry.url));
            if (!matches) continue;

            const routeNodeId = generateId('Route', routeKey);
            const existing = ctx.graph.getNode(routeNodeId);
            if (!existing) continue;

            const currentMw = existing.properties.middleware ?? [];
            existing.properties.middleware = [
              ...mwLabel,
              ...currentMw.filter((m) => !mwLabel.includes(m)),
            ];
            linkedCount++;
          }
          if (isDev && linkedCount > 0) {
            logger.info(
              `🛡️ Linked ${mwPath} middleware [${mwLabel.join(', ')}] to ${linkedCount} routes`,
            );
          }
        }
      }
    }

    // Scan HTML/template files for safe static form/link/AJAX URL patterns.
    // Blade stays template-only here; it must not re-enter PHP provider paths.
    const htmlCandidates = allPaths.filter(isTemplateRouteCandidate);
    if (htmlCandidates.length > 0 && routeRegistry.size > 0) {
      const htmlContents = await readFileContents(ctx.repoPath, htmlCandidates);
      for (const [filePath, content] of htmlContents) {
        allFetchCalls.push(
          ...extractTemplateStaticFetchCalls(filePath, content, namedRouteRegistry),
        );
      }
    }

    // ── Extract Expo Router navigation patterns ──
    if (expoAppPaths.size > 0 && routeRegistry.size > 0) {
      const unreadExpoPaths = [...expoAppPaths].filter((p) => !handlerContents?.has(p));
      const extraContents =
        unreadExpoPaths.length > 0
          ? await readFileContents(ctx.repoPath, unreadExpoPaths)
          : new Map<string, string>();
      const allExpoContents = new Map([...(handlerContents ?? new Map()), ...extraContents]);
      for (const [filePath, content] of allExpoContents) {
        if (!expoAppPaths.has(filePath)) continue;
        for (const pattern of EXPO_NAV_PATTERNS) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const url = match[2] ?? match[1];
            if (url && url.startsWith('/')) {
              allFetchCalls.push({ filePath, fetchURL: url, lineNumber: 0 });
            }
          }
        }
      }
    }

    // ── Cross-file fetch wrapper consumer extraction ──
    // When the parse phase discovered functions that internally call fetch(),
    // scan JS/TS consumer files for calls to those wrapper functions with
    // URL-like string arguments and add them to allFetchCalls so
    // processNextjsFetchRoutes can create FETCHES edges.
    // Wrapper names come from two sources: functions the parse phase
    // auto-detected as calling the bare global `fetch()`, plus any names the
    // user declared in `.gitnexusrc` `fetchWrappers` (#1589/#1852 residual).
    // Config names let an axios/custom-client wrapper — or one named outside the
    // built-in convention — still produce route_map consumers; without them it
    // silently falls back to `consumers: []`. Configured names alone are enough
    // to run the scan even when nothing was auto-detected.
    // Configured names are already validated/trimmed/de-duped/capped by
    // analyze-config.ts — trusted as-is (#1589/#1852 review F9, dropped the
    // redundant re-trim/re-filter). The single filter below guards only the
    // auto-detected `functionName`s, which have no shape guarantee.
    const configuredWrappers = ctx.options?.fetchWrappers ?? [];
    const wrapperNames = new Set<string>(
      [...(allFetchWrapperDefs ?? []).map((d) => d.functionName), ...configuredWrappers].filter(
        (n): n is string => typeof n === 'string' && n.trim().length > 0,
      ),
    );
    if (wrapperNames.size > 0 && routeRegistry.size > 0) {
      const jsFiles = allPaths.filter((p) => /\.[jt]sx?$/.test(p));
      if (jsFiles.length > 0) {
        // Reuse contents already read for handler extraction; only read the
        // remainder (mirrors the Expo block above). Avoids a second full read of
        // files we already have in memory.
        const unreadJsFiles = jsFiles.filter((p) => !handlerContents?.has(p));
        const extraContents =
          unreadJsFiles.length > 0
            ? await readFileContents(ctx.repoPath, unreadJsFiles)
            : new Map<string, string>();
        // One alternation regex over every wrapper name per file — O(files), not
        // O(files × wrappers) (#1852 review F3). Names are escaped and grouped
        // non-capturing so capture group 1 stays the URL. The left boundary is a
        // negative lookbehind, not `\b`: a bare configured name like `get` must
        // match the free call `get('/x')` but NOT a member access `client.get(`
        // (a `.get(` on an unrelated object), and `apiFetch` must not match
        // `myApiFetch`. Member-style wrappers are configured with the dot
        // (`client.get`), where the `.` is part of the pattern. The `u` flag +
        // Unicode property classes make the boundary cover non-ASCII identifier
        // characters too — ASCII `\w` would let `caféget('/x')` match `get`
        // (#1852 review F10).
        const alternation = [...wrapperNames].map(escapeRegex).join('|');
        const wrapperCallRegex = new RegExp(
          `(?<![.\\p{L}\\p{N}_$])(?:${alternation})\\s*\\(\\s*['"\`](/[^'"\`\\s)]+)['"\`]`,
          'gu',
        );
        const scanContent = (filePath: string, content: string): void => {
          wrapperCallRegex.lastIndex = 0;
          // 1-based line number via a running newline counter: matches arrive in
          // ascending index, so accumulate newlines incrementally instead of
          // re-allocating `content.substring(0, match.index).split('\n')` on
          // every match (#1852 review F12). Output is identical.
          let line = 1;
          let scanned = 0;
          let match;
          while ((match = wrapperCallRegex.exec(content)) !== null) {
            for (; scanned < match.index; scanned++) {
              if (content.charCodeAt(scanned) === 10 /* '\n' */) line++;
            }
            allFetchCalls.push({
              filePath,
              fetchURL: match[1],
              lineNumber: line,
            });
          }
        };
        for (const [filePath, content] of extraContents) scanContent(filePath, content);
        // Also scan already-read JS/TS handler files (a handler can itself
        // consume another route through a wrapper).
        if (handlerContents) {
          for (const p of jsFiles) {
            const cached = handlerContents.get(p);
            if (cached !== undefined) scanContent(p, cached);
          }
        }
      }
    }

    if (routeRegistry.size > 0 && allFetchCalls.length > 0) {
      // url → [route node keys at that url] (one per verb). A verb-less fetch()
      // consumer matches by URL and connects to every Route node at that URL.
      const routeUrlToKeys = new Map<string, string[]>();
      for (const [routeKey, entry] of routeRegistry) {
        const existing = routeUrlToKeys.get(entry.url);
        if (existing) existing.push(routeKey);
        else routeUrlToKeys.set(entry.url, [routeKey]);
      }

      const consumerPaths = [...new Set(allFetchCalls.map((c) => c.filePath))];
      const consumerContents = await readFileContents(ctx.repoPath, consumerPaths);

      processNextjsFetchRoutes(ctx.graph, allFetchCalls, routeUrlToKeys, consumerContents);
      if (isDev) {
        logger.info(
          `🔗 Processed ${allFetchCalls.length} fetch() calls against ${routeRegistry.size} routes`,
        );
      }
    }

    return { routeRegistry };
  },
};
