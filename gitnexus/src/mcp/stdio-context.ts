/**
 * MCP Stdio Context — AsyncLocalStorage-tagged transport-write detection.
 *
 * The MCP stdio transport writes JSON-RPC frames to stdout. Per spec, the
 * server MUST NOT write anything to stdout that is not a valid MCP message.
 * Stray writes from dependency code corrupt the protocol and present to
 * clients as a hung handshake or `MCP error -32000`.
 *
 * This module provides:
 *   - withMcpWrite(fn): runs fn inside an AsyncLocalStorage context tagged
 *     `mcp: true`. The transport wraps every send() in this so its writes
 *     are recognizable as legitimate.
 *   - isMcpWrite(): true when called inside withMcpWrite.
 *   - createStdoutSentinel({...}): a write function suitable for installing
 *     in a Proxy over process.stdout. Tagged writes pass through to the real
 *     stdout; untagged writes are redirected to stderr with a [mcp:stdout-redirect]
 *     prefix, truncated to maxBytes per redirect, and rate-limited to maxRedirects
 *     per process so a stray loop cannot flood client logs.
 *
 * The sentinel is correctness-by-construction: it identifies legitimate
 * writes by *who* called write(), not by inspecting the bytes. A byte-shape
 * heuristic ("starts with {, ends with \n") would falsely reject Content-Length
 * frames (which start with C and end with }) and misclassify multi-chunk writes.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
// Import from the leaf module, NOT `core/lbug/pool-adapter.js`. pool-adapter
// pulls in `@ladybugdb/core`, which would put the native module in
// `cli/mcp.ts`'s static-import closure — exactly the pre-sentinel window
// Codex's adversarial review flagged on PR #1383.
import { realStdoutWrite, realStderrWrite, setActiveStdoutWrite } from './stdio-capture.js';

interface McpWriteContext {
  mcp: true;
}

const store = new AsyncLocalStorage<McpWriteContext>();

export function withMcpWrite<T>(fn: () => T): T {
  return store.run({ mcp: true }, fn);
}

export function isMcpWrite(): boolean {
  return store.getStore()?.mcp === true;
}

type WriteFn = typeof process.stdout.write;

export interface SentinelOptions {
  realStdoutWrite: WriteFn;
  realStderrWrite: WriteFn;
  /** Maximum bytes of payload to surface per redirect. Defaults to 200. */
  maxBytes?: number;
  /** Maximum number of redirects per process before suppression. Defaults to 10. */
  maxRedirects?: number;
}

export interface SentinelStats {
  redirected: number;
  suppressed: number;
}

export interface Sentinel {
  write: WriteFn;
  stats: () => SentinelStats;
  flushSummary: () => void;
}

const REDIRECT_PREFIX = '[mcp:stdout-redirect] ';
const STARTUP_WARNING =
  '[mcp:stdout-redirect] sentinel triggered — stray write redirected to stderr; subsequent redirects logged at exit\n';

function chunkToBuffer(chunk: any): Buffer {
  if (chunk === undefined || chunk === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  // Plain Uint8Array (e.g. from a TypedArray-using producer): copy bytes
  // verbatim instead of falling through to String(chunk), which produces
  // garbage like "1,2,3,...".
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

/**
 * Node Writable.write contract: the completion callback, when present, is
 * always the last argument. Match exactly that — don't try to peer past
 * earlier arguments — so future overload shapes (e.g. an options object)
 * do not silently break callback delivery.
 */
function extractCallback(rest: unknown[]): ((err?: Error | null) => void) | undefined {
  const last = rest[rest.length - 1];
  return typeof last === 'function' ? (last as (err?: Error | null) => void) : undefined;
}

export function createStdoutSentinel(opts: SentinelOptions): Sentinel {
  const maxBytes = opts.maxBytes ?? 200;
  const maxRedirects = opts.maxRedirects ?? 10;
  let redirected = 0;
  let suppressed = 0;
  let warningEmitted = false;

  const stderr = (s: string | Buffer) => opts.realStderrWrite(s);

  const write: WriteFn = (chunk: any, ...rest: any[]): boolean => {
    if (isMcpWrite()) {
      return opts.realStdoutWrite(chunk, ...rest);
    }

    if (!warningEmitted) {
      warningEmitted = true;
      stderr(STARTUP_WARNING);
    }

    if (redirected < maxRedirects) {
      redirected += 1;
      const buf = chunkToBuffer(chunk);
      const truncated = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;

      stderr(REDIRECT_PREFIX);
      if (truncated.length > 0) stderr(truncated);
      if (buf.length > maxBytes) {
        stderr(` (+${buf.length - maxBytes} bytes truncated)`);
      }
      if (truncated.length === 0 || truncated[truncated.length - 1] !== 0x0a) {
        stderr('\n');
      }
    } else {
      suppressed += 1;
    }

    // Honor the Writable.write callback contract — fire async to match
    // Node's "next-tick" semantics so callers never observe sync reentry.
    const cb = extractCallback(rest);
    if (cb) {
      process.nextTick(() => cb(null));
    }
    return true;
  };

  return {
    write,
    stats: () => ({ redirected, suppressed }),
    flushSummary: () => {
      if (redirected === 0 && suppressed === 0) return;
      stderr(
        `[mcp:stdout-redirect] summary: ${redirected} redirected, ${suppressed} suppressed beyond cap\n`,
      );
    },
  };
}

/**
 * Install the sentinel as the global stdout interceptor — idempotent.
 *
 * Does three things in order:
 *   1. Creates the sentinel from the captured `realStdoutWrite` / `realStderrWrite`.
 *   2. Replaces `process.stdout.write` with `sentinel.write`.
 *   3. Registers `sentinel.write` as the "active" handler in pool-adapter
 *      so silenceStdout/restoreStdout cycles preserve the sentinel
 *      instead of unwinding to raw stdout.
 *
 * Idempotent — callers may invoke it multiple times safely (cli/mcp.ts at
 * the top of mcpCommand, and startMCPServer). The earliest caller wins;
 * subsequent calls return the same sentinel handle. Call this BEFORE any
 * other startup work that might emit to stdout: native module loads,
 * `_require()`-style grammar detection, repo registry reads, embedder
 * pipeline initialization. Anything written before the sentinel is in
 * place reaches raw stdout uncaught.
 *
 * Returns the sentinel handle so the earliest caller can register
 * `process.on('exit', sentinel.flushSummary)`.
 */
let _installedSentinel: Sentinel | null = null;

export function installGlobalStdoutSentinel(): Sentinel {
  if (_installedSentinel) return _installedSentinel;
  const sentinel = createStdoutSentinel({ realStdoutWrite, realStderrWrite });
  // eslint-disable-next-line no-restricted-syntax -- installing the global sentinel is the API contract
  process.stdout.write = sentinel.write;
  setActiveStdoutWrite(sentinel.write);
  _installedSentinel = sentinel;
  return sentinel;
}
