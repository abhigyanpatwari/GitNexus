/**
 * Middleware chain extraction from route handler file content.
 * Detects wrapper patterns like: export const POST = withA(withB(withC(handler)))
 */

/** Keywords that terminate middleware chain walking (not wrapper function names) */
/** Names that are composition wrappers, not middleware functions themselves. */
const COMPOSER_NAMES = new Set(['middleware', 'default', 'chain', 'compose']);

/** Keywords that terminate middleware chain walking (not wrapper function names) */
export const MIDDLEWARE_STOP_KEYWORDS = new Set([
  'async',
  'await',
  'function',
  'new',
  'return',
  'if',
  'for',
  'while',
  'switch',
  'class',
  'const',
  'let',
  'var',
  'req',
  'res',
  'request',
  'response',
  'event',
  'ctx',
  'context',
  'next',
]);

/** Walk nested wrapper calls starting at `pos` in `content`, returning function names. */
function walkNestedWrappers(content: string, pos: number): string[] {
  const names: string[] = [];
  const nestedRe = /^\s*(\w+)\s*\(/;
  let remaining = content.slice(pos);
  let nested;
  while ((nested = nestedRe.exec(remaining)) !== null) {
    if (MIDDLEWARE_STOP_KEYWORDS.has(nested[1])) break;
    names.push(nested[1]);
    pos += nested[0].length;
    remaining = content.slice(pos);
  }
  return names;
}

/**
 * Extract middleware wrapper chain from a route handler file.
 * Detects patterns like: export const POST = withA(withB(withC(handler)))
 * Returns an object with the wrapper function names (outermost-first) and the
 * HTTP method they were captured from, or undefined if no chain found.
 */
export function extractMiddlewareChain(
  content: string,
): { chain: string[]; method: string } | undefined {
  const mwPattern =
    /export\s+(?:const\s+(POST|GET|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*=|default)\s+(\w+)\s*\(/g;
  let mwMatch;
  while ((mwMatch = mwPattern.exec(content)) !== null) {
    const method = mwMatch[1] ?? 'default';
    const firstWrapper = mwMatch[2];
    const chain: string[] = [firstWrapper];
    chain.push(...walkNestedWrappers(content, mwMatch.index + mwMatch[0].length));
    if (chain.length >= 2 || (chain.length === 1 && /^with[A-Z]/.test(chain[0]))) {
      return { chain, method };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Next.js project-level middleware.ts extraction
// ---------------------------------------------------------------------------

export interface NextjsMiddlewareConfig {
  matchers: string[];
  exportedName: string;
  wrappedFunctions: string[];
}

/**
 * Parse a Next.js project-level middleware.ts file and extract:
 * - config.matcher patterns (string or string[])
 * - the exported middleware function name
 * - wrapper composition (e.g. chain([withAuth, withI18n]))
 */
export function extractNextjsMiddlewareConfig(content: string): NextjsMiddlewareConfig | undefined {
  const matchers: string[] = [];
  const matcherArrayRe = /config\s*=\s*\{[^}]*matcher\s*:\s*\[([^\]]*)\]/s;
  const matcherStringRe = /config\s*=\s*\{[^}]*matcher\s*:\s*(['"`])([^'"`]+)\1/s;
  const arrMatch = matcherArrayRe.exec(content);
  if (arrMatch) {
    const items = arrMatch[1];
    const strRe = /(['"`])((?:[^'"`\\\\]|\\\\.)*)\1/g;
    let m;
    while ((m = strRe.exec(items)) !== null) {
      matchers.push(m[2]);
    }
  } else {
    const strMatch = matcherStringRe.exec(content);
    if (strMatch) {
      matchers.push(strMatch[2]);
    }
  }

  let exportedName = 'middleware';
  const isNamedMw = /export\s+(?:async\s+)?function\s+middleware\b/.test(content);
  const isConstMw = /export\s+const\s+middleware\s*=/.test(content);
  const defaultFunctionMatch = /export\s+default\s+(?:async\s+)?function(?:\s+(\w+))?/.exec(
    content,
  );
  const defaultIdentifierMatch = /export\s+default\s+(?!function\b)(\w+)/.exec(content);

  if (!isNamedMw && !isConstMw) {
    if (defaultFunctionMatch) {
      exportedName = defaultFunctionMatch[1] ?? 'middleware';
    } else if (defaultIdentifierMatch) {
      exportedName = defaultIdentifierMatch[1];
    }
  }

  // --- wrapper composition ---
  const wrappedFunctions: string[] = [];
  // Pattern: chain([fn1, fn2]) or compose(fn1, fn2)
  const chainRe = /(?:chain|compose)\s*\(\s*\[([^\]]+)\]/;
  const chainMatch = chainRe.exec(content);
  if (chainMatch) {
    const fns = chainMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    wrappedFunctions.push(...fns);
  }
  // Pattern: export default withA(withB(handler))
  const wrapperRe = /export\s+default\s+(\w+)\s*\(/;
  const wrapperMatch = wrapperRe.exec(content);
  if (wrapperMatch && wrappedFunctions.length === 0) {
    const name = wrapperMatch[1];
    if (name !== 'function' && name !== 'async') {
      wrappedFunctions.push(name);
      wrappedFunctions.push(
        ...walkNestedWrappers(content, wrapperMatch.index + wrapperMatch[0].length),
      );
    }
  }

  if (!COMPOSER_NAMES.has(exportedName) && !wrappedFunctions.includes(exportedName)) {
    wrappedFunctions.unshift(exportedName);
  }

  const hasExport = isNamedMw || isConstMw || !!defaultFunctionMatch || !!defaultIdentifierMatch;
  if (!hasExport && matchers.length === 0 && wrappedFunctions.length === 0) return undefined;

  return { matchers, exportedName, wrappedFunctions };
}

/** Pre-compiled matcher for efficient per-route testing. */
export type CompiledMatcher =
  | { type: 'prefix'; prefix: string }
  | { type: 'regex'; re: RegExp }
  | { type: 'exact'; value: string };

/**
 * Compile a Next.js middleware matcher pattern into a reusable matcher.
 * Call once per pattern, then use compiledMatcherMatchesRoute per route.
 */
export function compileMatcher(matcher: string): CompiledMatcher | null {
  const paramWild = matcher.replace(/\/:path\*$/, '');
  if (paramWild !== matcher) return { type: 'prefix', prefix: paramWild };
  if (matcher.includes('(')) {
    try {
      return { type: 'regex', re: new RegExp('^' + matcher + '$') };
    } catch {
      return null;
    }
  }
  return { type: 'exact', value: matcher };
}

/** Test a route URL against a pre-compiled matcher. */
export function compiledMatcherMatchesRoute(cm: CompiledMatcher, routeURL: string): boolean {
  switch (cm.type) {
    case 'prefix':
      return routeURL === cm.prefix || routeURL.startsWith(cm.prefix + '/');
    case 'regex':
      return cm.re.test(routeURL);
    case 'exact':
      return routeURL === cm.value;
  }
}

export function middlewareMatcherMatchesRoute(matcher: string, routeURL: string): boolean {
  const cm = compileMatcher(matcher);
  return cm ? compiledMatcherMatchesRoute(cm, routeURL) : false;
}
