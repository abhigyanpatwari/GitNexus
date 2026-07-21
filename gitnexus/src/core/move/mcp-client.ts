/**
 * MoveFlowClient implementation that spawns `move-flow mcp` and communicates
 * via MCP JSON-RPC over stdio (newline-delimited JSON).
 *
 * The move-flow binary (Rust/rmcp) is expected at `process.env.MOVE_FLOW`
 * or on $PATH as `move-flow`.
 */

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { MoveFactsMap, CallGraphMap } from './compiler-facts.js';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/** Shape of a successful MCP tools/call result. */
interface McpCallToolResult {
  isError?: boolean;
  content?: Array<{ text?: string }>;
}
function isMcpCallToolResult(v: unknown): v is McpCallToolResult {
  return typeof v === 'object' && v !== null;
}

/** Shape of a tools/list response. */
interface McpListToolResult {
  tools?: unknown[];
}
function isMcpListToolResult(v: unknown): v is McpListToolResult {
  return typeof v === 'object' && v !== null;
}

/** JSON-RPC `invalid_params` - move-flow uses it for caller/input errors
 *  (and some builds route package build failures through it). */
const JSON_RPC_INVALID_PARAMS = -32602;

/**
 * A move-flow tool call that failed in user space: the package could not be
 * built (an `isError: true` tool result whose content text carries the
 * diagnostic, e.g. "failed to build package `<path>`: <reason>") or the request
 * parameters were rejected (JSON-RPC -32602 invalid_params). Distinguishes
 * caller/input errors from transport and server faults so callers can render
 * them as user-actionable.
 */
export class MoveFlowToolCallError extends Error {
  /** JSON-RPC error code when the failure surfaced as a protocol error. */
  readonly code?: number;

  constructor(message: string, opts: { code?: number } = {}) {
    super(message);
    this.name = 'MoveFlowToolCallError';
    this.code = opts.code;
  }
}

/**
 * The move-flow surface GitNexus consumes. Defined here (not in the ingest
 * phase) so the client owns its own contract and the ingest phase depends on
 * the client, never the reverse.
 */
export interface MoveFlowClient {
  /** Full-fidelity per-module facts (move_package_query query:"facts"). */
  facts(packagePath: string): Promise<MoveFactsMap>;
  /** Function-level call graph (caller qualified name → callee qualified names). */
  callGraph(packagePath: string): Promise<CallGraphMap>;
  /**
   * Build status probe (move_package_status): does the package compile, and
   * what did the compiler say. Older move-flow builds do not expose the tool -
   * gate calls solely on `capabilities().hasStatusTool` (like `facts` on
   * `hasFactsQuery`).
   */
  packageStatus(packagePath: string): Promise<MovePackageStatus>;
  /** Capability probe (cached): which queries this move-flow build supports. */
  capabilities(): Promise<MoveFlowCapabilities>;
  shutdown(): Promise<void>;
}

/**
 * Result of `move_package_status`: whether the package builds, plus the raw
 * text move-flow returned ("no errors or warnings" on success, the compiler
 * diagnostics on failure).
 */
export interface MovePackageStatus {
  ok: boolean;
  diagnostics: string;
}

/** What a given move-flow build can answer. */
export interface MoveFlowCapabilities {
  /** `facts` query available (rich, compiler-sourced per-module facts). */
  hasFactsQuery: boolean;
  /** `move_package_status` tool available (build status + diagnostics). */
  hasStatusTool: boolean;
}

/** Minimal shape of an entry in an MCP `tools/list` response. */
export interface MoveFlowToolInfo {
  name: string;
  inputSchema?: unknown;
}

/**
 * Derive move-flow capabilities from a `tools/list` response.
 *
 * `facts` is a *query type* on `move_package_query` (a `const` in the tool's
 * `inputSchema` QueryType enum), not a standalone tool — so we detect it by
 * inspecting the schema. A hypothetical future standalone `move_package_facts`
 * tool is also honoured for forward-compatibility.
 *
 * Accepts either bare tool-name strings or `{ name, inputSchema }` entries.
 */
export function detectMoveFlowCapabilities(
  tools: ReadonlyArray<string | MoveFlowToolInfo>,
): MoveFlowCapabilities {
  const names = new Set<string>();
  let querySchema: unknown;
  for (const t of tools) {
    if (typeof t === 'string') {
      names.add(t);
    } else {
      names.add(t.name);
      if (t.name === 'move_package_query') querySchema = t.inputSchema;
    }
  }
  const hasFactsQuery = names.has('move_package_facts') || schemaMentionsFactsQuery(querySchema);
  return { hasFactsQuery, hasStatusTool: names.has('move_package_status') };
}

/** True if the `move_package_query` inputSchema declares a `"facts"` query const. */
function schemaMentionsFactsQuery(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  // Walk the JSON-schema object looking for a `const: "facts"` or
  // `enum: [... "facts" ...]` anywhere under the QueryType definition.
  const stack: unknown[] = [schema];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const obj = node as Record<string, unknown>;
    if (obj.const === 'facts') return true;
    if (Array.isArray(obj.enum) && obj.enum.includes('facts')) return true;
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return false;
}

export class MoveFlowMcpClient implements MoveFlowClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private capsPromise: Promise<MoveFlowCapabilities> | null = null;
  private binaryPath: string;
  private stderrLines: string[] = [];
  private static readonly MAX_STDERR = 20;

  private stderrContext(): string {
    if (this.stderrLines.length === 0) return '';
    return `\nstderr (last ${this.stderrLines.length} lines):\n${this.stderrLines.join('\n')}`;
  }

  constructor(binaryPath?: string) {
    this.binaryPath = binaryPath || process.env.MOVE_FLOW || 'move-flow';
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    const start = this._start().catch((err) => {
      // A failed startup must not poison the client for the rest of the run.
      // Only clear the promise for this attempt so a late event from an older
      // child cannot reset a newer retry.
      if (this.initPromise === start) {
        this.initialized = false;
        this.initPromise = null;
        this.capsPromise = null;
      }
      throw err;
    });
    this.initPromise = start;
    return start;
  }

  private async _start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.stderrLines.length = 0;
      const proc = spawn(this.binaryPath, ['mcp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      let initId: number | null = null;
      let initSettled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let rl: ReturnType<typeof createInterface> | null = null;

      const clearInitTimeout = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      const failInitialization = (err: Error, killProcess = true): void => {
        if (initSettled) return;
        initSettled = true;
        clearInitTimeout();
        if (initId !== null) this.pending.delete(initId);
        rl?.close();

        // An old child's late error/exit must not tear down a newer retry.
        if (this.proc === proc) {
          this.proc = null;
          this.initialized = false;
        }
        if (killProcess) {
          try {
            proc.kill();
          } catch {
            /* process may already be dead */
          }
        }
        reject(err);
      };

      const failRunningProcess = (err: Error, killProcess = false): void => {
        if (this.proc !== proc) return;
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timeout);
          pending.reject(err);
        }
        this.pending.clear();
        this.initialized = false;
        this.initPromise = null;
        this.capsPromise = null;
        this.proc = null;
        if (killProcess) {
          try {
            proc.kill();
          } catch {
            /* process may already be dead */
          }
        }
      };

      timeout = setTimeout(() => {
        failInitialization(new Error('move-flow MCP server did not respond within 30s'));
      }, 30000);

      proc.stderr.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (!line) continue;
          this.stderrLines.push(line);
          if (this.stderrLines.length > MoveFlowMcpClient.MAX_STDERR) {
            this.stderrLines.shift();
          }
        }
      });

      // Absorb async EPIPE from writes to a dead child so it does not become an
      // uncaughtException; the 'exit' handler settles in-flight requests.
      proc.stdin.on('error', (err) => {
        this.stderrLines.push(`stdin error: ${err.message}`);
        if (this.stderrLines.length > MoveFlowMcpClient.MAX_STDERR) {
          this.stderrLines.shift();
        }
      });

      proc.on('error', (err) => {
        const wrapped = new Error(
          `Failed to spawn move-flow: ${err.message}${this.stderrContext()}`,
        );
        if (!initSettled) {
          failInitialization(wrapped);
        } else {
          failRunningProcess(wrapped, true);
        }
      });

      proc.on('exit', (code) => {
        if (this.proc !== proc) return;
        if (!initSettled) {
          failInitialization(
            new Error(`move-flow exited with code ${code} during init${this.stderrContext()}`),
            false,
          );
          return;
        }
        failRunningProcess(
          new Error(`move-flow exited unexpectedly (code ${code})${this.stderrContext()}`),
        );
      });

      rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (msg.id != null) {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) {
                p.reject(
                  msg.error.code === JSON_RPC_INVALID_PARAMS
                    ? new MoveFlowToolCallError(msg.error.message, { code: msg.error.code })
                    : new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
                );
              } else {
                p.resolve(msg.result);
              }
            }
          }
        } catch {
          /* ignore non-JSON lines */
        }
      });

      // Send initialize
      initId = ++this.requestId;
      this.pending.set(initId, {
        resolve: () => {
          if (initSettled) return;
          clearInitTimeout();
          const notif: JsonRpcNotification = {
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          };
          try {
            this.send(notif);
          } catch (err) {
            failInitialization(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          initSettled = true;
          this.initialized = true;
          resolve();
        },
        reject: (err) => {
          failInitialization(err);
        },
        timeout,
      });

      try {
        this.send({
          jsonrpc: '2.0',
          id: initId,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'gitnexus', version: '1.0.0' },
          },
        });
      } catch (err) {
        failInitialization(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private send(msg: Record<string, unknown> | JsonRpcNotification): void {
    if (!this.proc) throw new Error('move-flow MCP server is not running');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted();

    return new Promise<unknown>((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        try {
          this.proc?.kill();
        } catch {
          /* process may already be dead */
        }
        reject(new Error(`move-flow '${toolName}' timed out after 120s`));
      }, 120000);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          if (!isMcpCallToolResult(result)) {
            resolve(result);
            return;
          }
          // Tool-level failures (e.g. package build failures) arrive as a
          // SUCCESS result with `isError: true` and the diagnostic as content
          // text - reject rather than hand the error text to callers as data.
          if (result.isError === true) {
            const text =
              typeof result.content?.[0]?.text === 'string'
                ? result.content[0].text
                : `move-flow '${toolName}' reported an unspecified tool error`;
            reject(new MoveFlowToolCallError(text));
            return;
          }
          if (result.content?.[0]?.text) {
            try {
              resolve(JSON.parse(result.content[0].text));
            } catch {
              resolve(result.content[0].text);
            }
          } else {
            resolve(result);
          }
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        timeout,
      });

      this.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      });
    });
  }

  async callGraph(packagePath: string): Promise<CallGraphMap> {
    return (await this.callTool('move_package_query', {
      package_path: packagePath,
      query: 'call_graph',
    })) as CallGraphMap;
  }

  async facts(packagePath: string): Promise<MoveFactsMap> {
    return (await this.callTool('move_package_query', {
      package_path: packagePath,
      query: 'facts',
    })) as MoveFactsMap;
  }

  async packageStatus(packagePath: string): Promise<MovePackageStatus> {
    try {
      const result = await this.callTool('move_package_status', { package_path: packagePath });
      return { ok: true, diagnostics: typeof result === 'string' ? result : '' };
    } catch (err) {
      // A failing build arrives as isError:true with the compiler diagnostics
      // as content text - for this tool that IS the answer, not a call failure.
      if (err instanceof MoveFlowToolCallError) {
        return { ok: false, diagnostics: err.message };
      }
      throw err;
    }
  }

  /** Raw JSON-RPC request (non-`tools/call`), e.g. `tools/list`. */
  private async rpcRequest(method: string, params?: unknown): Promise<unknown> {
    await this.ensureStarted();
    return new Promise<unknown>((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`move-flow '${method}' timed out after 30s`));
      }, 30000);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        timeout,
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async capabilities(): Promise<MoveFlowCapabilities> {
    if (this.capsPromise) return this.capsPromise;
    this.capsPromise = (async () => {
      try {
        const listed = await this.rpcRequest('tools/list', {});
        const tools = (
          isMcpListToolResult(listed) ? (listed.tools ?? []) : []
        ) as MoveFlowToolInfo[];
        return detectMoveFlowCapabilities(tools);
      } catch {
        // Probe failure → facts unavailable; the ingest phase trips its hard gate.
        return { hasFactsQuery: false, hasStatusTool: false };
      }
    })();
    return this.capsPromise;
  }

  async shutdown(): Promise<void> {
    const shutdownError = new Error('move-flow client shutdown');
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(shutdownError);
    }
    this.pending.clear();
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
    this.initialized = false;
    this.initPromise = null;
    this.capsPromise = null;
    this.stderrLines.length = 0;
  }
}

/**
 * Try to create a MoveFlowMcpClient. Returns null if move-flow binary
 * is not found on the system.
 *
 * Resolution order:
 *   1. `$MOVE_FLOW` (explicit override for power users / CI).
 *   2. Bundled `vendor/move-flow/<platform>/move-flow[.exe]` (the postinstall
 *      probe installs here — see `scripts/install-move-flow.cjs`).
 *   3. `move-flow` on `$PATH` (host install).
 */
function bundledMoveFlowPath(): string | null {
  const { platform, arch } = process;
  let key: string | null = null;
  if (platform === 'linux' && arch === 'x64') key = 'linux-x64';
  else if (platform === 'linux' && arch === 'arm64') key = 'linux-arm64';
  else if (platform === 'darwin' && arch === 'arm64') key = 'darwin-arm64';
  else if (platform === 'darwin' && arch === 'x64') key = 'darwin-x64';
  else if (platform === 'win32' && arch === 'x64') key = 'win32-x64';
  if (!key) return null;
  const name = platform === 'win32' ? 'move-flow.exe' : 'move-flow';
  // mcp-client.ts lives at gitnexus/src/core/move/; vendor/ is two levels above src/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'vendor', 'move-flow', key, name);
}

function probeBinary(binary: string): boolean {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function tryCreateMoveFlowClient(): MoveFlowMcpClient | null {
  const explicit = process.env.MOVE_FLOW;
  if (explicit) {
    return probeBinary(explicit) ? new MoveFlowMcpClient(explicit) : null;
  }

  const bundled = bundledMoveFlowPath();
  if (bundled && existsSync(bundled) && probeBinary(bundled)) {
    return new MoveFlowMcpClient(bundled);
  }

  const onPath = 'move-flow';
  return probeBinary(onPath) ? new MoveFlowMcpClient(onPath) : null;
}
