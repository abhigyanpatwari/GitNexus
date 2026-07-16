/**
 * Direct CLI Tool Commands
 *
 * Exposes GitNexus tools (query, context, impact, cypher, check) as direct CLI commands.
 * Bypasses MCP entirely — invokes LocalBackend directly for minimal overhead.
 *
 * Usage:
 *   gitnexus query "authentication flow"
 *   gitnexus context --name "validateUser"
 *   gitnexus impact --target "AuthService" --direction upstream
 *   gitnexus cypher "MATCH (n:Function) RETURN n.name LIMIT 10"
 *
 * Note: Output goes to stdout via fs.writeSync(fd 1), bypassing LadybugDB's
 * native module which captures the Node.js process.stdout stream during init.
 * See the output() function for details (#324).
 */

import { writeSync } from 'node:fs';
import { LocalBackend, VALID_NODE_LABELS } from '../mcp/local/local-backend.js';
import { cliErrorKey, cliWarnKey } from './cli-message.js';
import { formatDetectChangesResult } from './detect-changes-format.js';

let _backend: LocalBackend | null = null;

async function getBackend(): Promise<LocalBackend> {
  if (_backend) return _backend;
  _backend = new LocalBackend();
  const ok = await _backend.init();
  if (!ok) {
    cliErrorKey('tool.noIndexed');
    process.exit(1);
  }
  return _backend;
}

/**
 * Write tool output to stdout using low-level fd write.
 *
 * LadybugDB's native module captures Node.js process.stdout during init,
 * but the underlying OS file descriptor 1 (stdout) remains intact.
 * By using fs.writeSync(1, ...) we bypass the Node.js stream layer
 * and write directly to the real stdout fd (#324).
 *
 * Falls back to stderr if the fd write fails (e.g., broken pipe).
 */
function output(data: any): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  try {
    writeSync(1, text + '\n');
  } catch (err: any) {
    if (err?.code === 'EPIPE') {
      // Consumer closed the pipe (e.g., `gitnexus cypher ... | head -1`)
      // Exit cleanly per Unix convention
      process.exit(0);
    }
    // Fallback: stderr (previous behavior, works on all platforms)
    process.stderr.write(text + '\n');
  }
  // Backend failures come back as `{ error }` payloads rather than throws
  // (#2469). Every tool command routes its result through here, so this is
  // the one place that keeps scripted callers honest: print the payload,
  // then exit non-zero.
  if (
    data &&
    typeof data === 'object' &&
    'error' in data &&
    typeof data.error === 'string' &&
    data.error.trim().length > 0
  ) {
    process.exitCode = 1;
  }
}

/**
 * Parse a `--limit` CLI option into a positive row cap, or `undefined` when the
 * flag is absent, non-numeric, zero, or negative.
 *
 * Treating invalid / 0 / negative input as "no limit" — rather than the old
 * `options.limit ? Math.max(0, parseInt(...)) : undefined` path, where a string
 * like `"abc"` is truthy and yields `NaN`, then `slice(0, NaN)` silently EMPTIES
 * the result with exit 0 — keeps the guardrail commands (impact / context /
 * detect-changes) honest: a bad `--limit` shows everything, never nothing.
 */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Parse an `--offset` CLI option into a non-negative pagination start, or
 * `undefined` when the flag is absent or invalid. Mirrors {@link parseLimit};
 * offset `0` is valid ("start at the beginning"), so the guard is `>= 0`.
 */
function parseOffset(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export async function queryCommand(
  queryText: string | undefined,
  options?: {
    query?: string;
    repo?: string;
    branch?: string;
    context?: string;
    goal?: string;
    limit?: string;
    content?: boolean;
  },
): Promise<void> {
  const resolvedQuery = queryText?.trim() || options?.query?.trim();
  if (!resolvedQuery) {
    cliErrorKey('tool.usage.query');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('query', {
    // #2175: canonical param is search_query; the backend still accepts legacy "query".
    search_query: resolvedQuery,
    task_context: options?.context,
    goal: options?.goal,
    limit: parseLimit(options?.limit),
    include_content: options?.content ?? false,
    repo: options?.repo,
    branch: options?.branch,
  });
  output(result);
}

export async function contextCommand(
  name: string,
  options?: {
    repo?: string;
    branch?: string;
    file?: string;
    uid?: string;
    limit?: string;
    content?: boolean;
  },
): Promise<void> {
  // Reject a `--`-prefixed uid swallowed from a following flag (see impactCommand).
  if (options?.uid?.startsWith('--')) {
    cliErrorKey('tool.usage.context');
    process.exit(1);
  }
  if (!name?.trim() && !options?.uid) {
    cliErrorKey('tool.usage.context');
    process.exit(1);
  }

  const limit = parseLimit(options?.limit);
  const backend = await getBackend();
  const result = await backend.callTool('context', {
    name: name || undefined,
    uid: options?.uid,
    file_path: options?.file,
    include_content: options?.content ?? false,
    repo: options?.repo,
    branch: options?.branch,
  });
  if (limit !== undefined) {
    // Bound every array-valued category under incoming/outgoing (calls, accesses,
    // imports, extends, uses, …) — categorize() buckets by relType, so the prior
    // hardcoded calls/accesses missed the rest (e.g. incoming.accesses) — plus
    // typed_properties and processes, so --limit caps the whole context payload.
    for (const dir of [result.incoming, result.outgoing] as Array<
      Record<string, unknown> | undefined
    >) {
      if (!dir) continue;
      for (const key of Object.keys(dir)) {
        const bucket = dir[key];
        if (Array.isArray(bucket)) dir[key] = bucket.slice(0, limit);
      }
    }
    if (Array.isArray(result.typed_properties))
      result.typed_properties = result.typed_properties.slice(0, limit);
    if (Array.isArray(result.processes)) result.processes = result.processes.slice(0, limit);
  }
  output(result);
}

export async function impactCommand(
  target?: string,
  options?: {
    direction?: string;
    mode?: string;
    line?: string;
    repo?: string;
    branch?: string;
    uid?: string;
    file?: string;
    kind?: string;
    depth?: string;
    includeTests?: boolean;
    limit?: string;
    offset?: string;
    summaryOnly?: boolean;
  },
): Promise<void> {
  // A `--`-prefixed uid means Commander swallowed a following flag as the uid
  // value (e.g. `impact --uid --file x` → uid === '--file'). Reject it rather
  // than forwarding a garbage uid that would silently resolve to not-found.
  if (options?.uid?.startsWith('--')) {
    cliErrorKey('tool.usage.impact');
    process.exit(1);
  }
  // Target is an optional positional: a uid alone is enough to resolve (parity
  // with `context [name]`). Only error when neither a target nor a uid is given.
  if (!target?.trim() && !options?.uid) {
    cliErrorKey('tool.usage.impact');
    process.exit(1);
  }
  // Soft-validate --kind: an unknown kind is a no-op hint (the backend scores
  // it but it matches nothing), so warn and proceed rather than rejecting —
  // parity with the lenient MCP surface and forward-compatible with new labels.
  if (options?.kind && !VALID_NODE_LABELS.has(options.kind)) {
    cliWarnKey('tool.warn.unknownKind', { kind: options.kind });
  }

  try {
    const backend = await getBackend();
    const parsedLimit = parseLimit(options?.limit);
    const parsedOffset = parseOffset(options?.offset);
    // `--line` is a PDG-only statement anchor (1-based source line). Parse it to
    // an integer when provided and thread it ONLY when present, so the backend's
    // line-without-pdg / non-positive-integer validation fires on the real value
    // rather than on a silently-dropped flag. A non-numeric `--line` parses to
    // NaN, which the backend rejects as a non-positive integer (loud, not silent).
    const parsedLine = options?.line !== undefined ? parseInt(options.line, 10) : undefined;
    const result = await backend.callTool('impact', {
      target: target || undefined,
      target_uid: options?.uid,
      file_path: options?.file,
      kind: options?.kind,
      direction: options?.direction || 'upstream',
      // Forward the engine selector; backend validates the enum (callgraph/pdg)
      // and treats the default 'callgraph' identically to an omitted mode.
      mode: options?.mode,
      // PDG-only statement anchor — forwarded only when --line was given.
      ...(parsedLine !== undefined ? { line: parsedLine } : {}),
      maxDepth: options?.depth ? parseInt(options.depth, 10) : undefined,
      includeTests: options?.includeTests ?? false,
      repo: options?.repo,
      branch: options?.branch,
      limit: parsedLimit,
      offset: parsedOffset,
      summaryOnly: options?.summaryOnly ?? undefined,
    });
    // Client-side cap of the affected-list payload to --limit (parity with the
    // other tool commands). The backend already paginates byDepth per level to
    // the same limit, so byDepth needs no client-side re-slice.
    if (parsedLimit !== undefined) {
      if (Array.isArray(result.affected_processes))
        result.affected_processes = result.affected_processes.slice(0, parsedLimit);
      if (Array.isArray(result.affected_modules))
        result.affected_modules = result.affected_modules.slice(0, parsedLimit);
    }
    output(result);
  } catch (err: unknown) {
    // Belt-and-suspenders: catch infrastructure failures (getBackend, callTool transport)
    // The backend's impact() already returns structured errors for graph query failures
    output({
      error:
        (err instanceof Error ? err.message : String(err)) || 'Impact analysis failed unexpectedly',
      target: { name: target },
      direction: options?.direction || 'upstream',
      suggestion: 'Try reducing --depth or using gitnexus context <symbol> as a fallback',
    });
    process.exit(1);
  }
}

export async function cypherCommand(
  query: string,
  options?: {
    repo?: string;
    branch?: string;
    limit?: string;
  },
): Promise<void> {
  if (!query?.trim()) {
    cliErrorKey('tool.usage.cypher');
    process.exit(1);
  }

  const limit = parseLimit(options?.limit);
  const backend = await getBackend();
  const result = await backend.callTool('cypher', {
    // #2175: canonical param is statement; the backend still accepts legacy "query".
    statement: query,
    repo: options?.repo,
    branch: options?.branch,
  });
  if (limit !== undefined) {
    if (Array.isArray(result)) {
      // Non-tabular result: a raw row array.
      result.splice(limit);
    } else if (result && typeof result === 'object' && typeof result.row_count === 'number') {
      // Tabular result: { markdown, row_count }. The markdown is a table built as
      // [header, separator, ...dataRows].join('\n'), so slice it to `limit` data
      // rows (keeping the 2 header lines) and report a row_count that matches what
      // is actually printed — otherwise `--limit 2` over 50 rows prints all 50 but
      // claims row_count: 2.
      if (typeof result.markdown === 'string' && result.row_count > limit) {
        result.markdown = result.markdown
          .split('\n')
          .slice(0, 2 + limit)
          .join('\n');
      }
      result.row_count = Math.min(result.row_count, limit);
    }
  }
  output(result);
}

export async function detectChangesCommand(options?: {
  scope?: string;
  baseRef?: string;
  repo?: string;
  branch?: string;
  limit?: string;
}): Promise<void> {
  const limit = parseLimit(options?.limit);
  const backend = await getBackend();
  const result = await backend.callTool('detect_changes', {
    scope: options?.scope || 'unstaged',
    base_ref: options?.baseRef,
    repo: options?.repo,
    branch: options?.branch,
  });
  if (limit !== undefined) {
    if (Array.isArray(result.changed_symbols))
      result.changed_symbols = result.changed_symbols.slice(0, limit);
    if (Array.isArray(result.affected_processes))
      result.affected_processes = result.affected_processes.slice(0, limit);
  }
  output(formatDetectChangesResult(result));
}

export async function checkCommand(options?: {
  cycles?: boolean;
  json?: boolean;
  repo?: string;
  branch?: string;
}): Promise<void> {
  if (!options?.cycles) {
    process.stderr.write('Usage: gitnexus check --cycles [--json]\n');
    process.exitCode = 1;
    return;
  }

  try {
    const backend = await getBackend();
    const result = await backend.callTool('check', {
      cycles: true,
      repo: options.repo,
      branch: options.branch,
    });
    if (result?.error) {
      output(result);
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      output(result);
    } else if (result.cycleCount === 0) {
      output('No circular imports found.');
    } else {
      output(
        result.cycles.map((cycle: { files: string[] }) => cycle.files.join(' -> ')).join('\n'),
      );
    }
    if (result.cycleCount > 0) process.exitCode = 1;
  } catch (error) {
    output({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

export async function traceCommand(
  from?: string,
  to?: string,
  options?: {
    fromUid?: string;
    fromFile?: string;
    toUid?: string;
    toFile?: string;
    depth?: string;
    repo?: string;
    branch?: string;
    includeTests?: boolean;
  },
): Promise<void> {
  if (options?.fromUid?.startsWith('--') || options?.toUid?.startsWith('--')) {
    cliErrorKey('tool.usage.trace');
    process.exit(1);
  }
  if ((!from?.trim() && !options?.fromUid) || (!to?.trim() && !options?.toUid)) {
    cliErrorKey('tool.usage.trace');
    process.exit(1);
  }
  // Reject a non-numeric / non-positive --depth up front rather than forwarding
  // NaN (which the backend would silently treat as the default).
  if (options?.depth !== undefined) {
    const parsedDepth = Number(options.depth);
    if (!Number.isInteger(parsedDepth) || parsedDepth < 1) {
      cliErrorKey('tool.usage.trace');
      process.exit(1);
    }
  }

  try {
    const backend = await getBackend();
    const result = await backend.callTool('trace', {
      from: from || undefined,
      from_uid: options?.fromUid,
      from_file: options?.fromFile,
      to: to || undefined,
      to_uid: options?.toUid,
      to_file: options?.toFile,
      maxDepth: options?.depth ? parseInt(options.depth, 10) : undefined,
      includeTests: options?.includeTests ?? false,
      repo: options?.repo,
      branch: options?.branch,
    });
    output(result);
  } catch (err: unknown) {
    output({
      status: 'error',
      error:
        (err instanceof Error ? err.message : String(err)) || 'Trace analysis failed unexpectedly',
      from: { name: from },
      to: { name: to },
      suggestion:
        'Try gitnexus context <symbol> to see connections, or check if an interface bridges them.',
    });
    process.exit(1);
  }
}
