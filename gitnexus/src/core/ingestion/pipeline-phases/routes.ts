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
import { normalizeExtractedRoutePath } from '../route-extractors/route-path.js';
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

// Re-exported for existing consumers/tests that import it from the routes phase.
export { normalizeExtractedRoutePath };

/**
 * Canonicalize a route's HTTP verb for persistence on the Route node.
 * Returns an upper-cased standard method, or `undefined` when the value
 * is not a real HTTP verb. Laravel `Route::resource` / `apiResource`
 * surface `httpMethod` values like `resource` / `apiResource` (they
 * expand to several verbs at runtime), so they must not be stored as a
 * method — leaving them `undefined` keeps the column clean and lets the
 * contract extractor fall back to its source-scan path for those routes.
 */
const VALID_HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

export function normalizeRouteMethod(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const verb = raw.trim().toUpperCase();
  // '*' marks a method-agnostic route (e.g. a Django function view handles any
  // verb). Preserve it so the contract layer emits a wildcard provider that
  // matches consumers of any method, instead of silently narrowing to GET.
  if (verb === '*') return '*';
  return VALID_HTTP_METHODS.has(verb) ? verb : undefined;
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

    for (const p of allPaths) {
      if (expoAppPaths.has(p)) {
        const expoURL = expoFileToRouteURL(p);
        if (expoURL && !routeRegistry.has(expoURL)) {
          routeRegistry.set(expoURL, { filePath: p, source: 'expo-filesystem-route' });
          continue;
        }
      }
      const nextjsURL = nextjsFileToRouteURL(p);
      if (nextjsURL && !routeRegistry.has(nextjsURL)) {
        routeRegistry.set(nextjsURL, { filePath: p, source: 'nextjs-filesystem-route' });
        continue;
      }
      if (p.endsWith('.php')) {
        const phpURL = phpFileToRouteURL(p);
        if (phpURL && !routeRegistry.has(phpURL)) {
          routeRegistry.set(phpURL, { filePath: p, source: 'php-file-route' });
        }
      }
    }

    let duplicateRoutes = 0;
    const namedRouteRegistry = new Map<string, string>();
    const addRoute = (url: string, entry: RouteEntry) => {
      if (routeRegistry.has(url)) {
        duplicateRoutes++;
        return;
      }
      routeRegistry.set(url, entry);
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
    for (const dr of allDecoratorRoutes) {
      const url = normalizeExtractedRoutePath(dr.routePath, dr.prefix ?? null);
      addRoute(url, {
        filePath: dr.filePath,
        source: `decorator-${dr.decoratorName}`,
        method: normalizeRouteMethod(dr.httpMethod),
      });
    }

    let handlerContents: Map<string, string> | undefined;
    if (routeRegistry.size > 0) {
      const handlerPaths = [...routeRegistry.values()].map((e) => e.filePath);
      handlerContents = await readFileContents(ctx.repoPath, handlerPaths);

      for (const [routeURL, entry] of routeRegistry) {
        const { filePath: handlerPath, source: routeSource, method: routeMethod } = entry;
        const content = handlerContents.get(handlerPath);

        const { responseKeys, errorKeys } = content
          ? handlerPath.endsWith('.php')
            ? extractPHPResponseShapes(content)
            : extractResponseShapes(content)
          : { responseKeys: undefined, errorKeys: undefined };

        const mwResult = content ? extractMiddlewareChain(content) : undefined;
        const middleware = mwResult?.chain;

        const routeNodeId = generateId('Route', routeURL);
        const handlerSymbolId = routeHandlerSymbols.get(routeURL);
        ctx.graph.addNode({
          id: routeNodeId,
          label: 'Route',
          properties: {
            name: routeURL,
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
          for (const [routeURL] of routeRegistry) {
            const matches =
              compiled.length === 0 ||
              compiled.some((cm) => compiledMatcherMatchesRoute(cm, routeURL));
            if (!matches) continue;

            const routeNodeId = generateId('Route', routeURL);
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
      const routeURLToFile = new Map<string, string>();
      for (const [url, entry] of routeRegistry) routeURLToFile.set(url, entry.filePath);

      const consumerPaths = [...new Set(allFetchCalls.map((c) => c.filePath))];
      const consumerContents = await readFileContents(ctx.repoPath, consumerPaths);

      processNextjsFetchRoutes(ctx.graph, allFetchCalls, routeURLToFile, consumerContents);
      if (isDev) {
        logger.info(
          `🔗 Processed ${allFetchCalls.length} fetch() calls against ${routeRegistry.size} routes`,
        );
      }
    }

    return { routeRegistry };
  },
};
