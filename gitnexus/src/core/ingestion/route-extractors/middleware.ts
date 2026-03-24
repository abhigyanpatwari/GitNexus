/**
 * Middleware chain extraction from route handler file content.
 * Detects wrapper patterns like: export const POST = withA(withB(withC(handler)))
 */

/** Keywords that terminate middleware chain walking (not wrapper function names) */
export const MIDDLEWARE_STOP_KEYWORDS = new Set([
  'async', 'await', 'function', 'new', 'return', 'if', 'for', 'while', 'switch',
  'class', 'const', 'let', 'var', 'req', 'res', 'request', 'response',
  'event', 'ctx', 'context', 'next',
]);

/**
 * Extract middleware wrapper chain from a route handler file.
 * Detects patterns like: export const POST = withA(withB(withC(handler)))
 * Returns an object with the wrapper function names (outermost-first) and the
 * HTTP method they were captured from, or undefined if no chain found.
 */
export function extractMiddlewareChain(content: string): { chain: string[]; method: string } | undefined {
  const mwPattern = /export\s+(?:const\s+(POST|GET|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*=|default)\s+(\w+)\s*\(/g;
  let mwMatch;
  while ((mwMatch = mwPattern.exec(content)) !== null) {
    const method = mwMatch[1] ?? 'default';
    const firstWrapper = mwMatch[2];
    const chain: string[] = [firstWrapper];
    let pos = mwMatch.index + mwMatch[0].length;
    const nestedPattern = /^\s*(\w+)\s*\(/;
    let remaining = content.slice(pos);
    let nestedMatch;
    while ((nestedMatch = nestedPattern.exec(remaining)) !== null) {
      const name = nestedMatch[1];
      if (MIDDLEWARE_STOP_KEYWORDS.has(name)) break;
      chain.push(name);
      pos += nestedMatch[0].length;
      remaining = content.slice(pos);
    }
    if (chain.length >= 2 || (chain.length === 1 && /^with[A-Z]/.test(chain[0]))) {
      return { chain, method };
    }
  }
  return undefined;
}
