/**
 * Shared, language-agnostic primitives for Spring / OpenFeign / Spring-HTTP-Interface
 * HTTP *consumer* extraction, used by BOTH the Java (`java.ts`) and Kotlin
 * (`kotlin.ts`) group-layer HTTP plugins so the two cannot drift apart.
 *
 * These are pure value maps + string helpers — no tree-sitter AST knowledge.
 * Each language plugin keeps its own grammar-specific queries and walkers and
 * funnels the extracted (verb, path, prefix) facts through these helpers, so a
 * polyglot repo emits byte-identical contract IDs from `.java` and `.kt`.
 *
 * The provider-side annotation→verb map (`METHOD_ANNOTATION_TO_HTTP`),
 * `isRouteMemberKey`, and `findEnclosingClass` live in the lower
 * `ingestion/route-extractors/spring-shared.ts` (shared with the ingestion
 * route extractor). This module is the consumer-side counterpart and lives in
 * the group layer beside the plugins that use it.
 */

import type { HttpDetection, HttpFileDetections } from './types.js';
import {
  resolveInheritedSpringRoutes,
  type SharedSpringType,
} from '../../../ingestion/route-extractors/spring-shared.js';

/**
 * RestTemplate method-name → HTTP verb. Source-scan only: the receiver must be
 * named exactly `restTemplate` (the per-language query enforces that).
 */
export const REST_TEMPLATE_TO_HTTP: Record<string, string> = {
  getForObject: 'GET',
  getForEntity: 'GET',
  postForObject: 'POST',
  postForEntity: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patchForObject: 'PATCH',
};

/**
 * Reactive WebClient short-form verb helper → HTTP verb
 * (`webClient.get().uri("/x")`, `.post()`, ...). HEAD/OPTIONS/TRACE are
 * intentionally excluded for symmetry across the plugins.
 */
export const WEB_CLIENT_SHORT_TO_HTTP: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
};

/**
 * Accepted HTTP verbs for the WebClient long form
 * `webClient.method(HttpMethod.X).uri("/y")`. The verb is captured as the
 * literal `HttpMethod.X` field name (`GET`, `POST`, …); HEAD/OPTIONS/TRACE are
 * intentionally excluded for symmetry with the short form
 * (`WEB_CLIENT_SHORT_TO_HTTP`). Shared so the Java and Kotlin long-form scans
 * gate verbs identically.
 */
export const WEB_CLIENT_LONG_VERB_RE = /^(GET|POST|PUT|DELETE|PATCH)$/;

/**
 * Spring 6 declarative HTTP Interface shortcut annotation → HTTP verb.
 *
 * `@GetExchange`/`@PostExchange`/… on a service interface proxied by
 * `HttpServiceProxyFactory` (over RestClient / WebClient / RestTemplate)
 * describe an OUTBOUND call — i.e. a CONSUMER, the modern analogue of an
 * OpenFeign `@(Get|Post|...)Mapping` interface method. The path lives in the
 * annotation's `url` (or `value`) attribute, or positionally.
 *
 * The base `@HttpExchange(method = "GET", url = "...")` form carries its verb
 * in an attribute rather than the annotation name; the shortcut annotations
 * above are the overwhelmingly common case and the only ones mapped here.
 */
export const EXCHANGE_ANNOTATION_TO_HTTP: Record<string, string> = {
  GetExchange: 'GET',
  PostExchange: 'POST',
  PutExchange: 'PUT',
  DeleteExchange: 'DELETE',
  PatchExchange: 'PATCH',
};

/**
 * Accumulate a route prefix (de-duped) under a class/interface declaration node
 * id. A Spring route attribute is `String[]`; a multi-element array (`["/a","/b"]`,
 * `arrayOf("/a","/b")`, `{"/a","/b"}`) yields one query match per element, so
 * prefixes accumulate rather than overwrite. Shared by the Java and Kotlin plugins
 * so both build their prefix maps identically.
 */
export const pushPrefix = (map: Map<number, string[]>, id: number, prefix: string): void => {
  const arr = map.get(id) ?? [];
  if (!arr.includes(prefix)) arr.push(prefix);
  map.set(id, arr);
};

/** Framework tags emitted on consumer detections (stable contract metadata). */
export const OPENFEIGN_FRAMEWORK = 'openfeign';
export const HTTP_INTERFACE_FRAMEWORK = 'spring-http-interface';

/** Consumer-detection confidences, shared so `.java` and `.kt` agree. */
export const FEIGN_CONFIDENCE = 0.7;
export const REQUEST_LINE_CONFIDENCE = 0.75;
export const EXCHANGE_CONFIDENCE = 0.75;

/**
 * OpenFeign's native `@RequestLine("METHOD /path[?query]")` packs an HTTP
 * method and path in a single string literal — see
 * https://github.com/OpenFeign/feign#interface-annotations. This regex splits
 * the verb from the path of that literal.
 */
export const REQUEST_LINE_VERB_RE = /^\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S.*?)\s*$/i;

/**
 * Parse a Feign `@RequestLine` value into a method + path pair. The query
 * portion is dropped because contract IDs are method+path only (consistent
 * with how RestTemplate/WebClient consumers drop inline query strings).
 *
 * Returns null if the value is not a recognized HTTP verb followed by a path
 * beginning with `/`.
 */
export function parseRequestLine(raw: string): { method: string; path: string } | null {
  const match = REQUEST_LINE_VERB_RE.exec(raw);
  if (!match) return null;
  const [, verb, rest] = match;
  if (typeof verb !== 'string' || typeof rest !== 'string') return null;
  const queryIdx = rest.indexOf('?');
  const pathOnly = (queryIdx >= 0 ? rest.slice(0, queryIdx) : rest).trim();
  if (!pathOnly.startsWith('/')) return null;
  return { method: verb.toUpperCase(), path: pathOnly };
}

/**
 * Resolve interface-based-controller provider *detections* (#1743): a concrete
 * `@RestController`/`@Controller` class inherits the `@(Get|...)Mapping` routes
 * declared on the interface it implements. Thin group-layer adapter over the
 * shared, language-agnostic `resolveInheritedSpringRoutes` (in
 * `ingestion/route-extractors/spring-shared.ts`) — it maps each inherited route
 * to a provider `HttpDetection`. Shared by the Java and Kotlin plugins so both
 * emit byte-identical provider contracts; the ingestion route extractor calls
 * the same underlying algorithm so all three stay in parity.
 */
export function scanSpringInheritanceProject(types: SharedSpringType[]): HttpFileDetections[] {
  const detectionsByFile = new Map<string, HttpDetection[]>();
  for (const route of resolveInheritedSpringRoutes(types)) {
    const detections = detectionsByFile.get(route.filePath) ?? [];
    detections.push({
      role: 'provider',
      framework: 'spring',
      method: route.method,
      path: route.path,
      name: route.methodName,
      confidence: 0.8,
    });
    detectionsByFile.set(route.filePath, detections);
  }

  return [...detectionsByFile.entries()].map(([filePath, detections]) => ({
    filePath,
    detections,
  }));
}
