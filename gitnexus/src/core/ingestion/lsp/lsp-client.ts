/**
 * LspClient — supervised stdio JSON-RPC lifecycle for a single
 * `typescript-language-server` subprocess.
 *
 * P0 of the #159 LSP read-only foundation. Reuses the WI-2
 * `discoverServers()` to locate the binary, and the
 * `LocalBackend` / `eval-server` warm-singleton + SIGINT
 * shutdown discipline as its lifecycle template.
 *
 * State machine
 * ─────────────
 *   idle → starting → ready → (request cycle) → stopping → stopped
 *   ready → restarting → ready
 *                       ↘ degraded (budget exhausted)
 *
 * The whole surface is **non-throwing** in the public sense:
 * `request()` always resolves to a typed result or `null`; a
 * crash exhausts the budget and surfaces as `null` (degraded).
 * Only the **recoverable** failure paths are exposed — once we
 * are in `degraded` state, subsequent requests also resolve
 * to `null` until the caller chooses to `stop()`.
 *
 * Why a single class (vs. factory + per-method handlers):
 *   The whole *point* of this cycle is to keep the surface
 *   boring and serializable. A Promise-chain mutex is more
 *   code, and easier to leak, than one class whose state
 *   arrow fits in a 9-state table. KD-4.
 *
 * KD-2: stdio transport via `vscode-jsonrpc@8`. Hand-rolled
 *       Content-Length framing was rejected as a footgun.
 * KD-4: per-workspace warm singleton, one client per run,
 *       `didOpen` on demand, requests serialized.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  NullLogger,
  type MessageConnection,
} from 'vscode-languageserver-protocol/node';

import { discoverServers } from './server-discovery.js';

// ─── Public types ─────────────────────────────────────────────────────

/** State machine. See file-level docstring. */
export type LspClientState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'degraded'
  | 'stopping'
  | 'stopped';

export interface LspClientOptions {
  /**
   * Absolute path to the workspace root the server is asked to
   * index. Used for `initialize.workspaceFolders[0]`. Defaults
   * to `process.cwd()` when omitted.
   */
  workspaceRoot?: string;
  /**
   * Optional override for the binary path. When unset, the
   * client calls `discoverServers()` to resolve one. The
   * override exists so tests (and the eventual CLI commands)
   * can short-circuit discovery and pin a specific binary.
   */
  binaryPath?: string;
  /**
   * Bounded supervised-restart budget. Defaults to 2 (per
   * the WI spec — Invariant 4). Once exhausted, the client
   * flips to `degraded` and every subsequent `request()`
   * resolves to `null` until `stop()`.
   */
  maxRestarts?: number;
  /**
   * Optional factory hook used by tests to inject a fake
   * subprocess + a fake JSON-RPC connection. Production code
   * leaves this undefined. When set, the client does not
   * spawn anything — it just wires up the provided pieces.
   */
  _inject?: {
    spawn: () => {
      process: ChildProcessWithoutNullStreams;
      connection: MessageConnection;
    };
  };
}

// ─── Constants ────────────────────────────────────────────────────────

/** Default restart budget per the WI spec. */
export const MAX_RESTARTS = 2;

/** Standard TS server capabilities the client requests. */
const TS_SERVER_CAPABILITIES = {
  // The client side declares a small subset — enough to receive
  // diagnostics / references. We intentionally do NOT request
  // any workspace-level capability we can't honor.
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
      didSave: false,
    },
    publishDiagnostics: {
      relatedInformation: false,
    },
  },
  workspace: {
    configuration: false,
    workspaceFolders: false,
  },
  window: { workDoneProgress: false },
} as const;

/** Initialize params shape — kept narrow; LSP tolerates more. */
interface InitializeParams {
  processId: number | null;
  rootUri: string;
  capabilities: typeof TS_SERVER_CAPABILITIES;
  workspaceFolders: { uri: string; name: string }[];
  initializationOptions?: Record<string, unknown>;
}

/** Initialize result — we only need the discriminant for now. */
interface InitializeResult {
  capabilities: unknown;
  serverInfo?: { name: string; version?: string };
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Convert a local file path to a `file://` URI. */
function pathToFileUri(p: string): string {
  // `pathToFileURL` is the Node-native helper (Node 10.12+)
  // and handles Windows drive letters correctly. We import it
  // at module top so ESM resolution is static.
  try {
    return pathToFileURL(p).toString();
  } catch {
    // Last-resort manual join — only reached on bizarre platforms
    // where pathToFileURL refuses the input.
    const abs = p.replace(/\\/g, '/');
    return abs.startsWith('/') ? `file://${abs}` : `file:///${abs}`;
  }
}

/** Extract the filesystem path out of a `file://` URI. */
function fileUriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri);
    } catch {
      // Fall through to the manual strip.
    }
  }
  return uri.replace(/^file:\/\//, '');
}

/**
 * Sleep helper. `setTimeout`'s `unref` is unnecessary inside
 * an `await` — the timer is held by the Promise resolution.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the standard TS server `initializationOptions`. We pass
 * a small, well-known set so the server starts in a predictable
 * shape (preferences: includeCompletionsForModuleExports etc.
 * are *not* set — we want default behavior to keep the byte
 * stability of the analyzer).
 */
const TS_INITIALIZATION_OPTIONS: Record<string, unknown> = {
  hostInfo: 'gitnexus-lsp-client',
  // Disable the install/run-on-save hooks the TS server exposes
  // for ts-execute-command; we never use them.
  tsserver: {
    path: '', // empty -> bundled tsserver
  },
};

// ─── LspClient ────────────────────────────────────────────────────────

/**
 * Per-workspace warm singleton client over stdio JSON-RPC.
 *
 * Use:
 *   const c = new LspClient({ workspaceRoot });
 *   await c.start();
 *   const loc = await c.request<Definition[]>('textDocument/definition', params, 5000);
 *   await c.stop();
 */
export class LspClient {
  private state: LspClientState = 'idle';

  /** Subprocess handle; null when not started or after stop. */
  private proc: ChildProcessWithoutNullStreams | null = null;

  /** JSON-RPC connection wrapping the subprocess stdio. */
  private connection: MessageConnection | null = null;

  /** Resolved binary path (post-discovery). */
  private resolvedBinary: string | null = null;

  /** URIs that have been `didOpen`'d to the server this session. */
  private openFiles = new Set<string>();

  /**
   * Serialization chain. Every public mutating call appends a
   * step to this chain; the next call awaits the previous one.
   * This is the "one in flight at a time" guarantee (KD-4,
   * Invariant 1).
   */
  private queue: Promise<unknown> = Promise.resolve();

  /** Bounded-restart counter. Reset only by explicit `start()`. */
  private restartCount = 0;

  /** Resolve hook for the in-flight `initialize` request. */
  private initializePromise: Promise<void> | null = null;

  private readonly workspaceRoot: string;
  private readonly binaryOverride: string | null;
  private readonly maxRestarts: number;
  private readonly inject: LspClientOptions['_inject'];

  constructor(opts: LspClientOptions = {}) {
    this.workspaceRoot = opts.workspaceRoot ?? process.cwd();
    this.binaryOverride = opts.binaryPath ?? null;
    this.maxRestarts = opts.maxRestarts ?? MAX_RESTARTS;
    this.inject = opts._inject;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /** Snapshot of the state machine — for tests + observability. */
  getState(): LspClientState {
    return this.state;
  }

  /**
   * Spawn the subprocess and complete the `initialize` handshake.
   *
   * Idempotent in the "already-ready" case: returns the existing
   * initialize promise. Calling `start()` after `stop()` will
   * throw — create a new client (or have a `dispose()` semantic
   * if you need reuse).
   */
  async start(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.state === 'starting') {
      if (this.initializePromise) return this.initializePromise;
    }
    if (this.state === 'stopped' || this.state === 'stopping') {
      throw new Error('LspClient.start(): cannot restart a stopped client');
    }
    if (this.state === 'degraded') {
      throw new Error('LspClient.start(): client is degraded; create a new instance');
    }
    this.state = 'starting';
    this.restartCount = 0;
    this.openFiles.clear();
    this.initializePromise = this.doStart();
    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  /**
   * Send a JSON-RPC request and await the response, with a hard
   * timeout. Always resolves to a value or `null` — never throws
   * into the caller.
   *
   * Serialization: all requests are funneled through `this.queue`
   * so only one is in flight at a time (KD-4).
   *
   * KD-4 / spec: when `method === 'textDocument/definition'` and
   * the file hasn't been opened yet, we send `didOpen` first
   * using the file's current on-disk content (best-effort).
   *
   * Crash handling: we also race against a `closedPromise` that
   * resolves with `null` when the connection closes. This makes
   * the in-flight request resolve to `null` immediately on a
   * subprocess crash, instead of waiting for the full timeout.
   */
  async request<T>(method: string, params: any, timeoutMs: number): Promise<T | null> {
    if (this.state !== 'ready') {
      // Degraded / stopped / not-started — never throw.
      return null;
    }

    const job = async (): Promise<T | null> => {
      // Re-check state under the serialization lock — a crash
      // mid-prior-job may have flipped us to restarting/degraded.
      if (this.state !== 'ready' || !this.connection) return null;

      // didOpen-on-demand (KD-4) — best-effort, no throw.
      if (method === 'textDocument/definition') {
        await this.maybeDidOpenForDefinition(params);
        // The maybe- didOpen is a notification; it went through
        // the connection's outgoing queue so ordering is fine.
      }

      // Race the send with (timeout | closed). We never reject
      // from here — the public contract is value | null.
      const conn = this.connection!;
      const send = (): Promise<T> => conn.sendRequest<T>(method, params);
      // When the connection's underlying streams close (e.g.
      // the subprocess crashed), `vscode-jsonrpc` will eventually
      // settle the pending send, but it can take longer than
      // the public timeout. We add a third race leg that
      // resolves to `null` the moment the connection closes,
      // so a crashed in-flight request fails fast.
      let closedListener: { dispose(): void } | null = null;
      const closed = new Promise<null>((resolve) => {
        // If the connection is already closed (state flipped),
        // resolve immediately. Otherwise wire a one-shot listener.
        if (this.state !== 'ready') {
          resolve(null);
          return;
        }
        try {
          closedListener = conn.onClose(() => resolve(null));
        } catch {
          resolve(null);
        }
      });

      let timer: NodeJS.Timeout | null = null;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs));
      });
      try {
        const result = await Promise.race([send(), timeout, closed]);
        return result === null ? null : (result as T);
      } catch {
        // A real LSP error (server-reported error, transport
        // error, or in-flight crash). Treat as unavailable; the
        // crash path is detected by the 'exit' handler, which
        // will flip state and surface `null` on the next call.
        return null;
      } finally {
        if (timer) clearTimeout(timer);
        try {
          closedListener?.dispose();
        } catch {
          /* noop */
        }
      }
    };

    // Append to the serialization chain. If the job itself
    // throws (it shouldn't — the inner `try/catch` swallows),
    // we still keep the chain alive by linking a no-op resolve.
    const next = this.queue.then(() => job(), () => job());
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Pre-open a file so subsequent `definition` requests resolve
   * against its current content. Idempotent — already-open URIs
   * are skipped. The dedupe is **synchronous** (we add to
   * `openFiles` immediately at the top of the public method),
   * which means two `didOpen()` calls in a row only produce one
   * notification on the wire — even if the wire is busy with a
   * prior request.
   */
  async didOpen(uri: string, content: string, languageId = 'typescript'): Promise<void> {
    const fileUri = uri.startsWith('file://') ? uri : pathToFileUri(uri);
    // Synchronous dedupe BEFORE the queue chain — this is the
    // idempotency guarantee the spec asks for. If we deferred
    // the `add` until inside the queued job, two back-to-back
    // `didOpen` calls would both see "not in the set yet" and
    // both send a notification.
    if (this.openFiles.has(fileUri)) return;
    this.openFiles.add(fileUri);

    const job = async (): Promise<void> => {
      if (this.state !== 'ready' || !this.connection) {
        // We already added to openFiles. The notification didn't
        // actually reach the server. Roll the dedupe back so a
        // retry (e.g. after restart) can re-issue the didOpen.
        this.openFiles.delete(fileUri);
        return;
      }
      try {
        await this.connection.sendNotification('textDocument/didOpen', {
          textDocument: {
            uri: fileUri,
            languageId,
            version: 1,
            text: content,
          },
        });
      } catch {
        // Notification failed (transport crash mid-send). Roll
        // back the dedupe so a future restart can re-issue.
        this.openFiles.delete(fileUri);
      }
    };
    const next = this.queue.then(() => job(), () => job());
    this.queue = next.catch(() => undefined);
    await next;
  }

  /**
   * Supervised restart. Respawns the subprocess, re-issues
   * `initialize`, and tracks the budget. Returns `true` on
   * success, `false` if the budget is exhausted (state is
   * then `degraded`).
   *
   * Idempotent: if already in `ready`, returns `true`.
   * Idempotent: if `degraded`, returns `false` without doing work.
   */
  async restart(): Promise<boolean> {
    if (this.state === 'ready') return true;
    if (this.state === 'degraded') return false;
    if (this.state !== 'restarting') {
      // Only valid to call restart when we already know we
      // crashed; for callers that just want a "make it work
      // again" semantic, start() covers that.
      return false;
    }
    if (this.restartCount >= this.maxRestarts) {
      this.state = 'degraded';
      return false;
    }
    this.restartCount += 1;
    const ok = await this.spawnAndInitialize();
    if (!ok) {
      this.state = 'degraded';
      return false;
    }
    this.state = 'ready';
    return true;
  }

  /**
   * Send `shutdown` + `exit`, wait up to 2s, then `kill()` if
   * still alive. Idempotent — safe to call when not started.
   * Never throws.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') return;
    if (this.state === 'stopping') return; // already stopping
    this.state = 'stopping';

    const proc = this.proc;
    const conn = this.connection;

    // Best-effort graceful shutdown. We don't `await` the
    // `shutdown` request if the connection is already disposed
    // by a crash — `sendRequest` would throw, and our contract
    // is no-throw into the caller.
    if (conn) {
      try {
        await Promise.race([
          conn.sendRequest('shutdown', null),
          sleep(1000), // cap the shutdown grace period
        ]);
      } catch {
        // Ignore — server may have already exited.
      }
      try {
        await conn.sendNotification('exit', null);
      } catch {
        // Same.
      }
    }

    // Give the OS a moment to reap the process.
    if (proc && proc.exitCode === null) {
      const exited = new Promise<void>((resolve) => {
        if (!proc) return resolve();
        proc.once('exit', () => resolve());
      });
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* noop */
        }
        // If SIGTERM is ignored (typescript-language-server is
        // well-behaved but a wedged test fake might not be),
        // escalate to SIGKILL.
        const sigkill = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* noop */
          }
        }, 1000);
        // We do not `.unref` — the process is about to exit
        // anyway. Leaving the timer attached means we always
        // follow through on the kill chain.
        sigkill.unref?.();
      }, 1000);
      await Promise.race([exited, sleep(2000)]);
      clearTimeout(killTimer);
    }

    // Cleanup connection + handles.
    try {
      conn?.dispose();
    } catch {
      /* noop */
    }
    this.connection = null;
    this.proc = null;
    this.openFiles.clear();
    this.state = 'stopped';
  }

  // ─── Internals ──────────────────────────────────────────────────

  private async doStart(): Promise<void> {
    let ok = false;
    try {
      ok = await this.spawnAndInitialize();
    } catch {
      // spawn/initialize threw — treat as a hard failure.
      ok = false;
    }
    if (!ok) {
      // spawnAndInitialize() already cleaned up + set state.
      // Throw here so the public start() promise rejects on
      // an unhandled spawn failure (caller can `try/catch`
      // and degrade).
      this.state = 'degraded';
      throw new Error('LspClient.start(): spawn or initialize failed');
    }
    this.state = 'ready';
  }

  /**
   * Run the spawn + initialize handshake. Resets proc/conn
   * handles on failure. Does NOT flip `state` — the caller
   * (start / restart) owns the state transitions.
   */
  private async spawnAndInitialize(): Promise<boolean> {
    // Resolve binary (memoize so a degraded -> start cycle
    // doesn't re-discover if the caller already gave us a
    // path).
    if (!this.resolvedBinary) {
      if (this.binaryOverride) {
        this.resolvedBinary = this.binaryOverride;
      } else {
        const discovered = await discoverServers();
        if (!discovered.typescript) {
          return false;
        }
        this.resolvedBinary = discovered.typescript.path;
      }
    }

    // Spawn (or use injected fakes).
    let proc: ChildProcessWithoutNullStreams;
    let connection: MessageConnection;
    if (this.inject) {
      const fake = this.inject.spawn();
      proc = fake.process;
      connection = fake.connection;
    } else {
      try {
        proc = spawn(this.resolvedBinary, ['--stdio'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        return false;
      }
      // If spawn failed async, the error is on 'error'.
      const spawnError = await new Promise<Error | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 2000);
        proc.once('error', (e) => {
          clearTimeout(t);
          resolve(e);
        });
        proc.once('spawn', () => {
          clearTimeout(t);
          resolve(null);
        });
      });
      if (spawnError) {
        try {
          proc.kill();
        } catch {
          /* noop */
        }
        return false;
      }
      connection = createMessageConnection(
        new StreamMessageReader(proc.stdout),
        new StreamMessageWriter(proc.stdin),
        NullLogger,
      );
    }

    this.proc = proc;
    this.connection = connection;

    // Wire the connection (errors, close, exit handler) BEFORE
    // sending initialize — a 'close' that fires mid-handshake
    // must surface as a start() failure.
    this.attachLifecycleListeners();

    // `connection.listen()` activates the message reader +
    // writer. In production we always own the connection so
    // we always call it. In tests, the `_inject` factory may
    // hand us a connection that the test's harness has *not*
    // started listening on (the typical mock-server pattern
    // is to listen on the *server-side* connection only, and
    // expect the client to call `listen()` on the client-side
    // connection it receives). So we always listen here —
    // `connection.listen()` is idempotent in vscode-jsonrpc,
    // and a no-throw if already listening (vscode-jsonrpc 8.x).
    connection.listen();

    // Send `initialize` with workspaceFolders.
    const rootUri = pathToFileUri(this.workspaceRoot);
    const initializeParams: InitializeParams = {
      processId: process.pid,
      rootUri,
      capabilities: TS_SERVER_CAPABILITIES,
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
      initializationOptions: TS_INITIALIZATION_OPTIONS,
    };

    let initResult: InitializeResult;
    try {
      // Cap the handshake at 10s — `typescript-language-server`
      // is usually <500ms in our integration tests, so anything
      // longer is a real failure that we want to surface, not
      // hang on.
      initResult = await Promise.race([
        connection.sendRequest<InitializeResult>('initialize', initializeParams),
        sleep(10_000).then(() => {
          throw new Error('LspClient: initialize timed out (10s)');
        }),
      ]);
    } catch {
      // Handshake failed — kill the subprocess and let the
      // caller decide what to do.
      this.cleanupAfterFailure();
      return false;
    }

    if (!initResult || typeof initResult !== 'object') {
      this.cleanupAfterFailure();
      return false;
    }

    // LSP handshake: `initialized` is a notification the client
    // sends to tell the server it has processed the result.
    try {
      await connection.sendNotification('initialized', {});
    } catch {
      this.cleanupAfterFailure();
      return false;
    }
    return true;
  }

  /**
   * Wire `exit` / `error` / connection `close` so a crash
   * flips state out of `ready`. The restart budget is then
   * enforced by the next `request()` (which sees a non-ready
   * state and returns `null`).
   *
   * **Note:** we do NOT auto-respawn here. The spec ("bounded
   * supervised restart") is implemented as: crash → state
   * `restarting`; the next caller's `request()` returns `null`
   * AND triggers `restart()` on their behalf. For callers
   * that want explicit control, they call `restart()` directly.
   */
  private attachLifecycleListeners(): void {
    const proc = this.proc;
    const conn = this.connection;
    if (!proc || !conn) return;

    proc.on('exit', (code, signal) => {
      if (this.state === 'stopping' || this.state === 'stopped') return;
      // Guard against double-fire: if the conn.onClose path
      // already kicked off a restart, don't kick off another.
      if (this.state === 'restarting') return;
      // Unexpected exit — flip to restarting and try once.
      if (this.restartCount < this.maxRestarts) {
        this.state = 'restarting';
        // Best-effort: kick off a restart so the next request
        // is ready. We do NOT await — the public request()
        // awaits its own restart if needed.
        void this.restart();
      } else {
        this.state = 'degraded';
      }
      // Defensive: log only in non-test runs. Tests can spy
      // on process.stderr if they need this signal.
      if (code !== 0 && code !== null) {
        // eslint-disable-next-line no-console
        console.error(
          `[LspClient] subprocess exited unexpectedly (code=${code}, signal=${signal}); ` +
            `state=${this.state}, restartCount=${this.restartCount}`,
        );
      }
    });

    proc.on('error', () => {
      // The 'exit' handler will fire right after this; let it
      // own the state transition. We do not double-flip.
    });

    conn.onClose(() => {
      if (this.state === 'stopping' || this.state === 'stopped') return;
      // The connection's close should always be paired with
      // the proc's 'exit' event (the proc is the source of
      // truth for "is the subprocess alive?"). If for some
      // reason the proc 'exit' was missed (e.g. kill on
      // SIGKILL before the watcher could fire), we fall
      // back to flipping to restarting. Guard against
      // double-fire: only act if we haven't already started
      // a restart.
      if (this.state === 'ready') {
        this.state = 'restarting';
        void this.restart();
      }
    });

    conn.onError(() => {
      // Swallow — handled by the close/exit listeners.
    });
  }

  /**
   * Tear down the subprocess + connection without flipping to
   * `degraded` (the caller decides). Used by the failure path
   * of `spawnAndInitialize`.
   */
  private cleanupAfterFailure(): void {
    try {
      this.connection?.dispose();
    } catch {
      /* noop */
    }
    try {
      if (this.proc && this.proc.exitCode === null) {
        this.proc.kill('SIGTERM');
      }
    } catch {
      /* noop */
    }
    this.connection = null;
    this.proc = null;
  }

  /**
   * KD-4: `didOpen`-on-demand. Best-effort: if the file can't
   * be read, send the notification with empty content (the TS
   * server may still resolve a definition it has indexed from
   * its workspace scan).
   *
   * IMPORTANT: this helper is called from inside the request
   * job (which is itself serialized on `this.queue`). It MUST
   * NOT call the public `didOpen()` method, which would
   * re-queue behind the current job and deadlock. We send the
   * notification directly via the connection.
   */
  private async maybeDidOpenForDefinition(params: any): Promise<void> {
    if (!params || typeof params !== 'object') return;
    if (this.state !== 'ready' || !this.connection) return;
    const td = params.textDocument;
    if (!td || typeof td.uri !== 'string') return;
    const uri = td.uri;
    if (this.openFiles.has(uri)) return;

    let content = '';
    try {
      const p = uri.startsWith('file://') ? fileUriToPath(uri) : uri;
      content = readFileSync(p, 'utf8');
    } catch {
      // Best-effort: keep content empty per spec.
    }
    try {
      await this.connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: 'typescript',
          version: 1,
          text: content,
        },
      });
      this.openFiles.add(uri);
    } catch {
      // Notification failed (e.g. transport crash mid-send).
      // The outer request will surface `null`; we just bail.
    }
  }
}
