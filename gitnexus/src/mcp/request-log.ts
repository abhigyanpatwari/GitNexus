/**
 * MCP request log (PoC for issue #1351).
 *
 * Writes one JSONL line per MCP `tools/call` to a configurable path so
 * downstream utilization analysers (e.g. mcp-value-tracker) have a
 * server-side ground truth for "is this MCP server being used and how
 * long do calls take." A simpler counterpart to the full OpenTelemetry
 * proposal in #1351 — see the issue for the design discussion.
 *
 * Configuration via env (defaults are safe-by-default — opt-out, not
 * opt-in, so the log is present without extra setup):
 *
 *   GITNEXUS_MCP_REQUEST_LOG=off        — disable entirely
 *   GITNEXUS_MCP_REQUEST_LOG=/path/log  — write to this absolute path
 *   GITNEXUS_MCP_REQUEST_LOG=<empty>    — default: ~/.gitnexus/mcp-requests.log
 *
 * Privacy: tool inputs (e.g. raw `cypher` queries) may contain symbol
 * names from private code. The log lives next to `.gitnexus/` data
 * that already contains the indexed graph, so no new exposure surface
 * is created — but the log is kept off by default in CI to avoid
 * incidental capture in shared environments (see request-log.test.ts).
 *
 * Failures to write are swallowed — the MCP server's availability
 * matters more than logging fidelity.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RequestLogEntry {
  /** ISO 8601 timestamp at request start. */
  ts: string;
  /** MCP tool name (e.g. "impact", "context"). */
  tool: string;
  /** Total duration in milliseconds from invocation to result. */
  durationMs: number;
  /** Size of the result payload in bytes (0 on error). */
  resultBytes: number;
  /** Error message if the call threw, else null. */
  error: string | null;
}

/**
 * Resolve the configured log path. Returns `null` if logging is disabled
 * (env var explicitly set to "off") so callers can short-circuit.
 */
export function resolveLogPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['GITNEXUS_MCP_REQUEST_LOG'];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase() === 'off') return null;
    if (trimmed.length > 0) return trimmed;
  }
  return join(homedir(), '.gitnexus', 'mcp-requests.log');
}

/**
 * Append one JSONL entry to the configured log file. Creates the parent
 * directory if needed. Swallows all errors — availability over fidelity.
 */
export async function appendRequestLog(
  entry: RequestLogEntry,
  path: string | null = resolveLogPath(),
): Promise<void> {
  if (path === null) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + '\n');
  } catch {
    // Intentionally silent — see module docstring.
  }
}

/**
 * Wrap an async tool-call handler so each invocation produces a log
 * entry. Returns the original result unchanged.
 */
export async function instrumented<T>(
  toolName: string,
  fn: () => Promise<T>,
  resultBytesOf: (result: T) => number = (r) => {
    if (typeof r === 'string') return Buffer.byteLength(r, 'utf8');
    if (r === null || r === undefined) return 0;
    try { return Buffer.byteLength(JSON.stringify(r), 'utf8'); } catch { return 0; }
  },
): Promise<T> {
  const ts = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const result = await fn();
    void appendRequestLog({
      ts,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      resultBytes: resultBytesOf(result),
      error: null,
    });
    return result;
  } catch (err) {
    void appendRequestLog({
      ts,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      resultBytes: 0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
