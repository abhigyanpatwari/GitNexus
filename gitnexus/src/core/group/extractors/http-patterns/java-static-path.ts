import Parser from 'tree-sitter';
import { unquoteLiteral } from '../tree-sitter-scanner.js';

// ─── Statically-resolvable consumer path helpers ──────────────────────
// RestTemplate calls increasingly pass a non-literal path argument that is
// still statically derivable — `URI.create("/x")` or a `UriComponentsBuilder`
// fluent chain. These helpers resolve those shapes to a literal path; a
// genuinely dynamic argument (a variable, a non-`URI`/`UriComponentsBuilder`
// call) resolves to null and the call site is skipped. Extracted from java.ts
// (#2268) so that plugin stays under ~1000 lines; the only consumers are
// java.ts's RestTemplate loops (extractStaticPathExpression) and inferOkHttpMethod
// (the methodInvocation* primitives + firstLiteralArgument).

export function methodInvocationName(node: Parser.SyntaxNode): string | null {
  return node.type === 'method_invocation' ? (node.childForFieldName('name')?.text ?? null) : null;
}

export function methodInvocationObject(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return node.type === 'method_invocation' ? node.childForFieldName('object') : null;
}

function methodInvocationArguments(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const argsNode = node.type === 'method_invocation' ? node.childForFieldName('arguments') : null;
  return argsNode?.namedChildren ?? [];
}

export function firstLiteralArgument(node: Parser.SyntaxNode): string | null {
  const first = methodInvocationArguments(node)[0];
  return first?.type === 'string_literal' ? unquoteLiteral(first.text) : null;
}

/** Resolve a `URI.create("/path")` call to its literal path; null otherwise. */
function extractUriCreatePath(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'method_invocation') return null;
  if (methodInvocationObject(node)?.text !== 'URI' || methodInvocationName(node) !== 'create')
    return null;
  return firstLiteralArgument(node);
}

// Join a builder base with a sub-path using exactly one separating slash. This
// is intentionally NOT the shared `joinPath`: `joinPath` force-prepends `/`,
// whereas `appendPath` must preserve an absolute/host base (`fromHttpUrl`
// "https://host/api") so the host survives until `normalizeConsumerPath` strips
// it downstream. Do not unify the two.
function appendPath(base: string, subPath: string): string {
  if (!base) return subPath.startsWith('/') ? subPath : `/${subPath}`;
  if (!subPath) return base;
  return `${base.replace(/\/+$/, '')}/${subPath.replace(/^\/+/, '')}`;
}

/**
 * Resolve a `UriComponentsBuilder` fluent chain to its literal path. Seed
 * methods (`fromPath`/`fromUriString`/`fromHttpUrl`) return the literal arg
 * VERBATIM — a `fromHttpUrl("https://host/api")` seed keeps its host, which the
 * shared `normalizeConsumerPath` later reduces to the path (the same single
 * normalization point every other consumer path goes through). `path` and
 * `pathSegment` append literal segments; `build`/`toUriString`/`toUri`/`encode`
 * and the `query*` family pass through (query attributes do not change the
 * path). Any non-literal segment or unknown call → null.
 */
// A UriComponentsBuilder chain deeper than this is not realistic source; cap the
// recursion so a pathological / machine-generated chain returns null instead of
// overflowing the stack (mirrors the project's other AST-depth guards).
const MAX_BUILDER_DEPTH = 100;

function extractUriComponentsBuilderPath(node: Parser.SyntaxNode, depth = 0): string | null {
  if (depth > MAX_BUILDER_DEPTH) return null;
  if (node.type !== 'method_invocation') return null;
  const name = methodInvocationName(node);
  const objectNode = methodInvocationObject(node);
  if (
    (name === 'fromPath' || name === 'fromUriString' || name === 'fromHttpUrl') &&
    objectNode?.text === 'UriComponentsBuilder'
  ) {
    // Strip any `?query` baked into the seed literal so a later `.path()` appends
    // to a clean base; otherwise the sub-path is glued after the query
    // (`/base?x=1/sub`) and normalizeHttpPath truncates the whole tail at `?`.
    // A host prefix (`https://h/api`) is preserved and stripped downstream by
    // normalizeConsumerPath.
    const seed = firstLiteralArgument(node);
    return seed === null ? null : seed.split('?')[0];
  }
  if (!objectNode) return null;
  if (name === 'path') {
    const base = extractUriComponentsBuilderPath(objectNode, depth + 1);
    const subPath = firstLiteralArgument(node);
    return base !== null && subPath !== null ? appendPath(base, subPath) : null;
  }
  if (name === 'pathSegment') {
    const base = extractUriComponentsBuilderPath(objectNode, depth + 1);
    if (base === null) return null;
    const args = methodInvocationArguments(node);
    const segments = args
      .map((arg) => (arg.type === 'string_literal' ? unquoteLiteral(arg.text) : null))
      .filter((segment): segment is string => segment !== null);
    if (segments.length !== args.length) return null; // a non-literal segment defeats static resolution
    return segments.reduce((acc, segment) => appendPath(acc, segment), base);
  }
  if (
    name === 'build' ||
    name === 'toUriString' ||
    name === 'toUri' ||
    name === 'encode' ||
    name === 'query' ||
    name === 'queryParam' ||
    name === 'queryParams' ||
    name === 'replaceQuery' ||
    name === 'replaceQueryParam' ||
    name === 'replaceQueryParams'
  )
    return extractUriComponentsBuilderPath(objectNode, depth + 1);
  return null;
}

/**
 * Resolve a statically-derivable path argument to a literal path: a bare
 * string literal, a `URI.create("/x")` call, or a `UriComponentsBuilder`
 * fluent chain. Genuinely dynamic arguments → null.
 */
export function extractStaticPathExpression(node: Parser.SyntaxNode): string | null {
  if (node.type === 'string_literal') return unquoteLiteral(node.text);
  return extractUriCreatePath(node) ?? extractUriComponentsBuilderPath(node);
}
