/**
 * MoveFlowClient implementation that spawns `move-flow mcp` and communicates
 * via MCP JSON-RPC over stdio (newline-delimited JSON).
 *
 * The move-flow binary (Rust/rmcp) is expected at `process.env.MOVE_FLOW`
 * or on $PATH as `move-flow`.
 */

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { MoveFactsMap, CallGraphMap } from './compiler-facts.js';
import { isCompatibleMoveFlowVersion } from './release.js';

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

/** Real Aptos packages may need several minutes for a cold compiler build. */
const DEFAULT_MOVE_FLOW_TOOL_TIMEOUT_MS = 300_000;

function resolveMoveFlowToolTimeoutMs(): number {
  const configured = Number(process.env.GITNEXUS_MOVE_FLOW_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MOVE_FLOW_TOOL_TIMEOUT_MS;
}

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

  private failProcess(
    proc: ChildProcessWithoutNullStreams,
    error: Error,
    killProcess = true,
  ): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.initialized = false;
    this.initPromise = null;
    this.capsPromise = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (killProcess) {
      try {
        proc.kill();
      } catch {
        /* process may already be dead */
      }
    }
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
        this.failProcess(proc, err, killProcess);
        reject(err);
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
        const wrapped = new Error(`move-flow stdin failed: ${err.message}${this.stderrContext()}`);
        if (!initSettled) failInitialization(wrapped);
        else this.failProcess(proc, wrapped);
      });

      proc.on('error', (err) => {
        const wrapped = new Error(
          `Failed to spawn move-flow: ${err.message}${this.stderrContext()}`,
        );
        if (!initSettled) {
          failInitialization(wrapped);
        } else {
          this.failProcess(proc, wrapped);
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
        this.failProcess(
          proc,
          new Error(`move-flow exited unexpectedly (code ${code})${this.stderrContext()}`),
          false,
        );
      });

      rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (this.proc !== proc) return;
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

  private async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<unknown> {
    await this.ensureStarted();
    const proc = this.proc;
    if (!proc) throw new Error('move-flow MCP server is not running');

    return new Promise<unknown>((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.failProcess(proc, new Error(timeoutMessage));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      });

      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.failProcess(proc, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const timeoutMs = resolveMoveFlowToolTimeoutMs();
    const result = await this.request(
      'tools/call',
      { name: toolName, arguments: args },
      timeoutMs,
      `move-flow '${toolName}' timed out after ${timeoutMs}ms ` +
        '(raise GITNEXUS_MOVE_FLOW_TIMEOUT_MS for large packages)',
    );
    if (!isMcpCallToolResult(result)) return result;
    if (result.isError === true) {
      const text =
        typeof result.content?.[0]?.text === 'string'
          ? result.content[0].text
          : `move-flow '${toolName}' reported an unspecified tool error`;
      throw new MoveFlowToolCallError(text);
    }
    if (!result.content?.[0]?.text) return result;
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
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
    return this.request(method, params, 30_000, `move-flow '${method}' timed out after 30s`);
  }

  async capabilities(): Promise<MoveFlowCapabilities> {
    if (this.capsPromise) return this.capsPromise;
    const probe = this.rpcRequest('tools/list', {}).then((listed) => {
      const tools = (isMcpListToolResult(listed) ? (listed.tools ?? []) : []) as MoveFlowToolInfo[];
      return detectMoveFlowCapabilities(tools);
    });
    this.capsPromise = probe;
    void probe.catch(() => {
      if (this.capsPromise === probe) this.capsPromise = null;
    });
    return probe;
  }

  async shutdown(): Promise<void> {
    const proc = this.proc;
    if (proc) {
      proc.stdin?.end();
      this.failProcess(proc, new Error('move-flow client shutdown'));
    } else {
      this.initialized = false;
      this.initPromise = null;
      this.capsPromise = null;
    }
    this.stderrLines.length = 0;
  }
}

function probeBinary(binary: string): string | null {
  try {
    const output = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    // Prerelease/build suffixes ("2.1.0-rc1") are accepted; only the major
    // version gates protocol compatibility, and it follows the release pin.
    const version = /(?:^|\s)v?((\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output);
    return version !== null && isCompatibleMoveFlowVersion(version[1]) ? version[1] : null;
  } catch {
    return null;
  }
}

export interface ResolvedMoveFlowClient {
  client: MoveFlowMcpClient;
  version: string;
}

/** Construct a client for a binary that was already verified by the installer. */
export const createMoveFlowClient = (binaryPath: string): MoveFlowMcpClient =>
  new MoveFlowMcpClient(binaryPath);

/**
 * Probe and resolve a move-flow candidate exactly once, returning null when
 * the binary is missing or reports an incompatible major version. When
 * `binaryPath` is provided only that path is probed; otherwise resolution is
 * `$MOVE_FLOW` (explicit override), then `move-flow` on `$PATH`.
 */
export function tryResolveMoveFlowClient(binaryPath?: string): ResolvedMoveFlowClient | null {
  const binary = binaryPath || process.env.MOVE_FLOW || 'move-flow';
  const version = probeBinary(binary);
  return version ? { client: createMoveFlowClient(binary), version } : null;
}
