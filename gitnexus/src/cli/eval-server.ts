/**
 * Eval Server — Lightweight HTTP server for SWE-bench evaluation
 * 
 * Keeps LadybugDB warm in memory so tool calls from the agent are near-instant.
 * Designed to run inside Docker containers during SWE-bench evaluation.
 * 
 * KEY DESIGN: Returns LLM-friendly text, not raw JSON.
 * Raw JSON wastes tokens and is hard for models to parse. The text formatter
 * converts structured results into compact, readable output that models
 * can immediately act on. Next-step hints guide the agent through a
 * productive tool-chaining workflow (query → context → impact → fix).
 * 
 * Architecture:
 *   Agent bash cmd → curl localhost:PORT/tool/query → eval-server → LocalBackend → format → text
 * 
 * Usage:
 *   gitnexus eval-server                    # default port 4848
 *   gitnexus eval-server --port 4848        # explicit port
 *   gitnexus eval-server --idle-timeout 300 # auto-shutdown after 300s idle
 * 
 * API:
 *   POST /tool/:name   — Call a tool. Body is JSON arguments. Returns formatted text.
 *   GET  /health       — Health check. Returns {"status":"ok","repos":[...]}
 *   POST /shutdown     — Graceful shutdown.
 */

import http from 'http';
import { writeSync } from 'node:fs';
import { LocalBackend } from '../mcp/local/local-backend.js';

export interface EvalServerOptions {
  port?: string;
  idleTimeout?: string;
}

// ─── Text Formatters ──────────────────────────────────────────────────
// Convert structured JSON results into compact, LLM-friendly text.
// Design: minimize tokens, maximize actionability.

export function formatQueryResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  const lines: string[] = [];
  const processes = result.processes || [];
  const symbols = result.process_symbols || [];
  const defs = result.definitions || [];

  if (processes.length === 0 && defs.length === 0) {
    return 'No matching execution flows found. Try a different search term or use grep.';
  }

  lines.push(`Found ${processes.length} execution flow(s):\n`);

  for (let i = 0; i < processes.length; i++) {
    const p = processes[i];
    lines.push(`${i + 1}. ${p.summary} (${p.step_count} steps, ${p.symbol_count} symbols)`);

    // Show symbols belonging to this process
    const procSymbols = symbols.filter((s: any) => s.process_id === p.id);
    for (const s of procSymbols.slice(0, 6)) {
      const loc = s.startLine ? `:${s.startLine}` : '';
      lines.push(`   ${s.type} ${s.name} → ${s.filePath}${loc}`);
    }
    if (procSymbols.length > 6) {
      lines.push(`   ... and ${procSymbols.length - 6} more`);
    }
    lines.push('');
  }

  if (defs.length > 0) {
    lines.push(`Standalone definitions:`);
    for (const d of defs.slice(0, 8)) {
      lines.push(`  ${d.type || 'Symbol'} ${d.name} → ${d.filePath || '?'}`);
    }
    if (defs.length > 8) lines.push(`  ... and ${defs.length - 8} more`);
  }

  return lines.join('\n').trim();
}

export function formatContextResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  if (result.status === 'ambiguous') {
    const lines = [`Multiple symbols named '${result.candidates?.[0]?.name || '?'}'. Disambiguate with file path:\n`];
    for (const c of result.candidates || []) {
      lines.push(`  ${c.kind} ${c.name} → ${c.filePath}:${c.line || '?'}  (uid: ${c.uid})`);
    }
    lines.push(`\nRe-run: gitnexus-context "${result.candidates?.[0]?.name}" "<file_path>"`);
    return lines.join('\n');
  }

  const sym = result.symbol;
  if (!sym) return 'Symbol not found.';

  const lines: string[] = [];
  const loc = sym.startLine ? `:${sym.startLine}-${sym.endLine}` : '';
  lines.push(`${sym.kind} ${sym.name} → ${sym.filePath}${loc}`);
  lines.push('');

  // Incoming refs (who calls/imports/extends this)
  const incoming = result.incoming || {};
  const incomingCount = Object.values(incoming).reduce((sum: number, arr: any) => sum + arr.length, 0) as number;
  if (incomingCount > 0) {
    lines.push(`Called/imported by (${incomingCount}):`);
    for (const [relType, refs] of Object.entries(incoming)) {
      for (const ref of (refs as any[]).slice(0, 10)) {
        lines.push(`  ← [${relType}] ${ref.kind} ${ref.name} → ${ref.filePath}`);
      }
    }
    lines.push('');
  }

  // Outgoing refs (what this calls/imports)
  const outgoing = result.outgoing || {};
  const outgoingCount = Object.values(outgoing).reduce((sum: number, arr: any) => sum + arr.length, 0) as number;
  if (outgoingCount > 0) {
    lines.push(`Calls/imports (${outgoingCount}):`);
    for (const [relType, refs] of Object.entries(outgoing)) {
      for (const ref of (refs as any[]).slice(0, 10)) {
        lines.push(`  → [${relType}] ${ref.kind} ${ref.name} → ${ref.filePath}`);
      }
    }
    lines.push('');
  }

  // Processes
  const procs = result.processes || [];
  if (procs.length > 0) {
    lines.push(`Participates in ${procs.length} execution flow(s):`);
    for (const p of procs) {
      lines.push(`  • ${p.name} (step ${p.step_index}/${p.step_count})`);
    }
  }

  if (sym.content) {
    lines.push('');
    lines.push(`Source:`);
    lines.push(sym.content);
  }

  return lines.join('\n').trim();
}

export function formatImpactResult(result: any): string {
  if (result.error) {
    const suggestion = result.suggestion ? `\nSuggestion: ${result.suggestion}` : '';
    return `Error: ${result.error}${suggestion}`;
  }

  const target = result.target;
  const direction = result.direction;
  const byDepth = result.byDepth || {};
  const total = result.impactedCount || 0;

  if (total === 0) {
    return `${target?.name || '?'}: No ${direction} dependencies found. This symbol appears isolated.`;
  }

  const lines: string[] = [];
  const dirLabel = direction === 'upstream' ? 'depends on this (will break if changed)' : 'this depends on';
  lines.push(`Blast radius for ${target?.kind || ''} ${target?.name} (${direction}): ${total} symbol(s) ${dirLabel}`);
  if (result.partial) {
    lines.push('⚠️  Partial results — graph traversal was interrupted. Deeper impacts may exist.');
  }
  lines.push('');

  const depthLabels: Record<number, string> = {
    1: 'WILL BREAK (direct)',
    2: 'LIKELY AFFECTED (indirect)',
    3: 'MAY NEED TESTING (transitive)',
  };

  for (const depth of [1, 2, 3]) {
    const items = byDepth[depth];
    if (!items || items.length === 0) continue;

    lines.push(`d=${depth}: ${depthLabels[depth] || ''} (${items.length})`);
    for (const item of items.slice(0, 12)) {
      const conf = item.confidence < 1 ? ` (conf: ${item.confidence})` : '';
      lines.push(`  ${item.type} ${item.name} → ${item.filePath} [${item.relationType}]${conf}`);
    }
    if (items.length > 12) {
      lines.push(`  ... and ${items.length - 12} more`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

export function formatCypherResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  if (Array.isArray(result)) {
    if (result.length === 0) return 'Query returned 0 rows.';
    // Format as simple table
    const keys = Object.keys(result[0]);
    const lines: string[] = [`${result.length} row(s):\n`];
    for (const row of result.slice(0, 30)) {
      const parts = keys.map(k => `${k}: ${row[k]}`);
      lines.push(`  ${parts.join(' | ')}`);
    }
    if (result.length > 30) {
      lines.push(`  ... ${result.length - 30} more rows`);
    }
    return lines.join('\n');
  }

  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

export function formatDetectChangesResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  const summary = result.summary || {};
  const lines: string[] = [];

  if (summary.changed_count === 0) {
    return 'No changes detected.';
  }

  lines.push(`Changes: ${summary.changed_files || 0} files, ${summary.changed_count || 0} symbols`);
  lines.push(`Affected processes: ${summary.affected_count || 0}`);
  lines.push(`Risk level: ${summary.risk_level || 'unknown'}\n`);

  const changed = result.changed_symbols || [];
  if (changed.length > 0) {
    lines.push(`Changed symbols:`);
    for (const s of changed.slice(0, 15)) {
      lines.push(`  ${s.type} ${s.name} → ${s.filePath}`);
    }
    if (changed.length > 15) lines.push(`  ... and ${changed.length - 15} more`);
    lines.push('');
  }

  const affected = result.affected_processes || [];
  if (affected.length > 0) {
    lines.push(`Affected execution flows:`);
    for (const p of affected.slice(0, 10)) {
      const steps = (p.changed_steps || []).map((s: any) => s.symbol).join(', ');
      lines.push(`  • ${p.name} (${p.step_count} steps) — changed: ${steps}`);
    }
  }

  return lines.join('\n').trim();
}

export function formatListReposResult(result: any): string {
  if (!Array.isArray(result) || result.length === 0) {
    return 'No indexed repositories.';
  }

  const lines = ['Indexed repositories:\n'];
  for (const r of result) {
    const stats = r.stats || {};
    lines.push(`  ${r.name} — ${stats.nodes || '?'} symbols, ${stats.edges || '?'} relationships, ${stats.processes || '?'} flows`);
    lines.push(`    Path: ${r.path}`);
    lines.push(`    Indexed: ${r.indexedAt}`);
  }
  return lines.join('\n');
}

/**
 * Format a tool result as compact, LLM-friendly text.
 */
function formatToolResult(toolName: string, result: any): string {
  switch (toolName) {
    case 'query': return formatQueryResult(result);
    case 'context': return formatContextResult(result);
    case 'impact': return formatImpactResult(result);
    case 'cypher': return formatCypherResult(result);
    case 'detect_changes': return formatDetectChangesResult(result);
    case 'list_repos': return formatListReposResult(result);
    default: return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }
}

// ─── Next-Step Hints ──────────────────────────────────────────────────
// Guide the agent to the logical next tool call.
// Critical for tool chaining: query → context → impact → fix.

function getNextStepHint(toolName: string): string {
  switch (toolName) {
    case 'query':
      return '\n---\nNext: Pick a symbol above and run gitnexus-context "<name>" to see all its callers, callees, and execution flows.';

    case 'context':
      return '\n---\nNext: To check what breaks if you change this, run gitnexus-impact "<name>" upstream';

    case 'impact':
      return '\n---\nNext: Review d=1 items first (WILL BREAK). Read the source with cat to understand the code, then make your fix.';

    case 'cypher':
      return '\n---\nNext: To explore a result symbol in depth, run gitnexus-context "<name>"';

    case 'detect_changes':
      return '\n---\nNext: Run gitnexus-context "<symbol>" on high-risk changed symbols to check their callers.';

    default:
      return '';
  }
}

// ─── Server ───────────────────────────────────────────────────────────

export async function evalServerCommand(options?: EvalServerOptions): Promise<void> {
  const port = parseInt(options?.port || '4848');
  const idleTimeoutSec = parseInt(options?.idleTimeout || '0');

  const backend = new LocalBackend();
  const ok = await backend.init();

  if (!ok) {
    console.error('GitNexus eval-server: No indexed repositories found. Run: gitnexus analyze');
    process.exit(1);
  }

  const repos = await backend.listRepos();
  console.error(`GitNexus eval-server: ${repos.length} repo(s) loaded: ${repos.map(r => r.name).join(', ')}`);

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer() {
    if (idleTimeoutSec <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      console.error('GitNexus eval-server: Idle timeout reached, shutting down');
      await backend.disconnect();
      process.exit(0);
    }, idleTimeoutSec * 1000);
  }

  const server = http.createServer(async (req, res) => {
    resetIdleTimer();

    try {
      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', repos: repos.map(r => r.name) }));
        return;
      }

      // Shutdown
      if (req.method === 'POST' && req.url === '/shutdown') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'shutting_down' }));
        setTimeout(async () => {
          await backend.disconnect();
          server.close();
          process.exit(0);
        }, 100);
        return;
      }

      // Tool calls: POST /tool/:name
      const toolMatch = req.url?.match(/^\/tool\/(\w+)$/);
      if (req.method === 'POST' && toolMatch) {
        const toolName = toolMatch[1];

        const body = await readBody(req);
        let args: Record<string, any> = {};
        if (body.trim()) {
          try {
            args = JSON.parse(body);
          } catch {
            res.setHeader('Content-Type', 'text/plain');
            res.writeHead(400);
            res.end('Error: Invalid JSON body');
            return;
          }
        }

        // Call tool, format result as text, append next-step hint
        const result = await backend.callTool(toolName, args);
        const formatted = formatToolResult(toolName, result);
        const hint = getNextStepHint(toolName);

        res.setHeader('Content-Type', 'text/plain');
        res.writeHead(200);
        res.end(formatted + hint);
        return;
      }

      // 404
      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(404);
      res.end('Not found. Use POST /tool/:name or GET /health');

    } catch (err: any) {
      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(500);
      res.end(`Error: ${err.message || 'Internal error'}`);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.error(`GitNexus eval-server: listening on http://127.0.0.1:${port}`);
    console.error(`  POST /tool/query    — search execution flows`);
    console.error(`  POST /tool/context  — 360-degree symbol view`);
    console.error(`  POST /tool/impact   — blast radius analysis`);
    console.error(`  POST /tool/cypher   — raw Cypher query`);
    console.error(`  GET  /health        — health check`);
    console.error(`  POST /shutdown      — graceful shutdown`);
    if (idleTimeoutSec > 0) {
      console.error(`  Auto-shutdown after ${idleTimeoutSec}s idle`);
    }
    try {
      // Use fd 1 directly — LadybugDB captures process.stdout (#324)
      writeSync(1, `GITNEXUS_EVAL_SERVER_READY:${port}\n`);
    } catch {
      // stdout may not be available (e.g., broken pipe)
    }
  });

  resetIdleTimer();

  const shutdown = async () => {
    console.error('GitNexus eval-server: shutting down...');
    await backend.disconnect();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export const MAX_BODY_SIZE = 1024 * 1024; // 1MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy(new Error('Request body too large (max 1MB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
