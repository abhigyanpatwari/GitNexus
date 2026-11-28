/**
 * Development-only debug logging for the web app (#437).
 *
 * Vite replaces `import.meta.env.DEV` with a literal at build time, so in a
 * production build the body below is unreachable and the minifier removes it.
 * Call-site arguments are still evaluated, so pass plain values rather than
 * the result of expensive formatting.
 *
 * Output goes through `console.debug`, which browsers show under the
 * "Verbose" log level, with a `[gitnexus:<category>]` prefix so it can be
 * filtered in devtools.
 */
export type DebugCategory = 'llm' | 'agent' | 'stream' | 'impact';

export function debugLog(category: DebugCategory, ...args: unknown[]): void {
  if (!import.meta.env.DEV) return;
  console.debug(`[gitnexus:${category}]`, ...args);
}
