/**
 * Unit Tests: lsp-client — supervised stdio JSON-RPC lifecycle.
 *
 * The state machine + serialization + crash/restart contract is
 * the load-bearing piece of the whole #159 cycle — and the
 * only part that's *internal*. Most other modules (location-
 * mapper, mode-c-verifier) hang off this one. Driving it with
 * real `typescript-language-server` would be slow, flaky, and
 * gated on the server being installed. We instead mock the
 * JSON-RPC layer end-to-end with a real `MessageConnection`
 * over a pair of duplex streams.
 *
 * What we mock:
 *   - `child_process.spawn` (via the `_inject` constructor
 *     option) — we hand the client pre-built `process` and
 *     `connection` handles that talk to a fake server we
 *     drive in-test.
 *
 * What we *don't* mock:
 *   - The JSON-RPC framing (Content-Length / chunking /
 *     message order) — `vscode-languageserver-protocol` handles
 *     all of that for us, so a real bug in framing would
 *     surface here.
 *   - The state machine, the serialization chain, the
 *     restart budget, the timeout race, and the `stop()`
 *     shutdown handshake.
 *
 * ST-1..ST-9 come straight from the WI-3 spec. The integration
 * test (real binary) lives in test/integration/lsp/ and is
 * SKIPPED when the binary is absent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough, type Writable, type Readable } from 'stream';
import { EventEmitter } from 'node:events';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  NullLogger,
  type MessageConnection,
} from 'vscode-languageserver-protocol/node';

import { LspClient, MAX_RESTARTS, type LspClientState } from '../../../src/core/ingestion/lsp/lsp-client.js';

// Some tests (ST-7 in particular) deliberately build the client
// against an already-destroyed wire so the LspClient's
// `start()`-failure path is exercised. The
// `vscode-jsonrpc`-internal StreamMessageWriter queues a write
// before our race catches the error; that write rejects
// asynchronously with `ERR_STREAM_DESTROYED`, which Node then
// surfaces as an `unhandledRejection`. In production this never
// happens — the streams are alive. Suppress the specific noise
// here so it doesn't mask real regressions.
const _origUnhandled = process.listeners('unhandledRejection');
process.removeAllListeners('unhandledRejection');
process.on('unhandledRejection', (reason: any) => {
  if (
    reason &&
    typeof reason === 'object' &&
    String(reason?.code ?? '') === 'ERR_STREAM_DESTROYED'
  ) {
    return;
  }
  // Re-raise to the original handler if any.
  for (const l of _origUnhandled) {
    try {
      (l as any).call(process, reason);
    } catch {
      /* noop */
    }
  }
});
void _origUnhandled;

// ─── Bidirectional pipe (client-stdin <-> server-stdout) ───────────────
//
// In a real subprocess, `proc.stdin` is a Writable (client writes,
// server reads) and `proc.stdout` is a Readable (server writes,
// client reads). We model that here with two pairs of `Duplex`:
//
//   clientStdout  <──  serverStdin   (server writes here, client reads)
//   clientStdin   ──>  serverStdout  (client writes here, server reads)

interface Wire {
  /** The Writable the client writes to (= server reads from). */
  clientStdin: Writable;
  /** The Readable the client reads from (= server writes to). */
  clientStdout: Readable;
  /** The server's read end of the client→server pipe. */
  serverStdout: Readable;
  /** The server's write end of the server→client pipe. */
  serverStdin: Writable;
  /** Destroy both pipes; tests use this to simulate a crash. */
  destroy(): void;
}

/** Handle for driving the harness's fake LSP server in tests. */
interface FakeServerHandle {
  connection: MessageConnection;
  /** Trigger an "unexpected crash": kill both server-side pipes. */
  crash(): void;
  /** Force a slow response on the next definition request. */
  slowNextDefinition(ms: number): void;
  log: {
    initializeParams: any[];
    didOpenUris: string[];
    definitions: Array<{ params: any }>;
    shutdownCount: number;
    exitCount: number;
  };
  setDefinitionResult(value: any): void;
  dispose(): void;
}

function makeWire(): Wire {
  const clientStdin = new PassThrough();
  const clientStdout = new PassThrough();
  const serverStdin = new PassThrough();
  const serverStdout = new PassThrough();
  // Client writes flow to the server's read end.
  clientStdin.pipe(serverStdout);
  // Server writes flow to the client's read end.
  serverStdin.pipe(clientStdout);
  return {
    clientStdin,
    clientStdout,
    serverStdin,
    serverStdout,
    destroy() {
      try { clientStdin.destroy(); } catch { /* noop */ }
      try { clientStdout.destroy(); } catch { /* noop */ }
      try { serverStdin.destroy(); } catch { /* noop */ }
      try { serverStdout.destroy(); } catch { /* noop */ }
    },
  };
}

function makeFakeServer(wire: Wire): FakeServerHandle {
  // The server's READER reads data the CLIENT wrote — that
  // data was pushed onto `wire.serverStdout` (the readable
  // half of the client→server pipe). The server's WRITER
  // writes to `wire.serverStdin`, which forwards into the
  // client's readable `wire.clientStdout`.
  const connection = createMessageConnection(
    new StreamMessageReader(wire.serverStdout),
    new StreamMessageWriter(wire.serverStdin),
    NullLogger,
  );
  const log = {
    initializeParams: [] as any[],
    didOpenUris: [] as string[],
    definitions: [] as Array<{ params: any }>,
    shutdownCount: 0,
    exitCount: 0,
  };
  const state: { slowDelay: number; definitionResult: any } = {
    slowDelay: 0,
    definitionResult: [
      {
        uri: 'file:///def.ts',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
      },
    ],
  };

  connection.onRequest('initialize', (params) => {
    log.initializeParams.push(params);
    return {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: 1,
          willSave: false,
          willSaveWaitUntil: false,
          save: false,
        },
      },
      serverInfo: { name: 'fake-ts-server', version: '0.0.0-test' },
    };
  });
  connection.onNotification('initialized', () => {
    /* noop */
  });
  connection.onNotification('textDocument/didOpen', (params) => {
    log.didOpenUris.push(params?.textDocument?.uri);
  });
  connection.onRequest('textDocument/definition', async (params) => {
    log.definitions.push({ params });
    if (state.slowDelay > 0) {
      const delay = state.slowDelay;
      state.slowDelay = 0;
      await new Promise<void>((r) => setTimeout(r, delay));
    }
    return state.definitionResult;
  });
  connection.onRequest('shutdown', () => {
    log.shutdownCount += 1;
    return null;
  });
  connection.onNotification('exit', () => {
    log.exitCount += 1;
  });
  connection.listen();

  return {
    connection,
    log,
    crash() {
      // Destroy the server-side pipes first; then trigger a
      // cascade to the client-side so the LspClient's proc
      // shim fires its 'exit' event (which is the LspClient's
      // crash-detection signal).
      try {
        wire.serverStdin.destroy();
      } catch {
        /* noop */
      }
      try {
        wire.serverStdout.destroy();
      } catch {
        /* noop */
      }
      // Cascade: destroy the client pipes too so the fake
      // proc's 'close' handler (wired on `wire.clientStdout`)
      // fires and emits 'exit' on the proc.
      try {
        wire.clientStdin.destroy();
      } catch {
        /* noop */
      }
      try {
        wire.clientStdout.destroy();
      } catch {
        /* noop */
      }
    },
    slowNextDefinition(ms: number) {
      state.slowDelay = ms;
    },
    setDefinitionResult(value: any) {
      state.definitionResult = value;
    },
    dispose() {
      try {
        connection.dispose();
      } catch {
        /* noop */
      }
    },
  };
}

// ─── Client fixture: pairs the LspClient with a fake server ───────────

interface ClientFixture {
  client: LspClient;
  server: FakeServerHandle;
  wire: Wire;
  /** The client-side `ChildProcessWithoutNullStreams` shim. */
  clientProcess: any;
  dispose(): Promise<void>;
}

function makeFixture(opts?: { maxRestarts?: number }): ClientFixture {
  const wire = makeWire();
  const server = makeFakeServer(wire);
  const clientProcess = makeFakeChildProcess(wire);
  // The LspClient needs its own client-side connection — the
  // server's connection is owned by the harness and already
  // listening. The client-side connection here is what the
  // LspClient will `listen()` on and use to send requests.
  const clientConnection = createMessageConnection(
    new StreamMessageReader(wire.clientStdout),
    new StreamMessageWriter(wire.clientStdin),
    NullLogger,
  );
  const client = new LspClient({
    maxRestarts: opts?.maxRestarts,
    // Set workspaceRoot to `/` so the M7 path-validation
    // guard (in `maybeDidOpenForDefinition`) accepts
    // absolute `file://` URIs in the test fixture. The
    // test sends URIs like `file:///workspace/src/foo.ts`
    // — under a `/` root every absolute path is inside.
    // The fake server does not actually read the file
    // contents; the URI alone is logged.
    workspaceRoot: '/',
    _inject: {
      spawn: () => ({ process: clientProcess, connection: clientConnection }),
    },
  });
  return {
    client,
    server,
    wire,
    clientProcess,
    async dispose() {
      try {
        await client.stop();
      } catch {
        /* noop */
      }
      server.dispose();
      try {
        clientConnection.dispose();
      } catch {
        /* noop */
      }
      wire.destroy();
    },
  };
}

/**
 * Stateful fixture: each `spawn()` call returns a *fresh* wire
 * + fake server. This is what production would look like
 * (restart = new subprocess), so the test pins the behavior
 * the spec actually demands: "subsequent request succeeds".
 */
function makeRestartableFixture(opts?: { maxRestarts?: number }): {
  fixture: ClientFixture;
  callSpawn: () => void; // increments the spawn counter (test can introspect)
  spawnCount: () => number;
  currentServer: () => FakeServerHandle;
  currentWire: () => Wire;
  dispose: () => Promise<void>;
} {
  let wire = makeWire();
  let server = makeFakeServer(wire);
  let proc = makeFakeChildProcess(wire);
  let clientConn = createMessageConnection(
    new StreamMessageReader(wire.clientStdout),
    new StreamMessageWriter(wire.clientStdin),
    NullLogger,
  );
  let calls = 0;
  const client = new LspClient({
    maxRestarts: opts?.maxRestarts,
    _inject: {
      spawn: () => {
        calls += 1;
        wire = makeWire();
        server = makeFakeServer(wire);
        proc = makeFakeChildProcess(wire);
        clientConn = createMessageConnection(
          new StreamMessageReader(wire.clientStdout),
          new StreamMessageWriter(wire.clientStdin),
          NullLogger,
        );
        return { process: proc, connection: clientConn };
      },
    },
  });
  return {
    fixture: {
      client,
      server,
      wire,
      clientProcess: proc,
      async dispose() {
        try {
          await client.stop();
        } catch {
          /* noop */
        }
        server.dispose();
        try {
          clientConn.dispose();
        } catch {
          /* noop */
        }
        wire.destroy();
      },
    },
    callSpawn: () => {
      calls += 1;
    },
    spawnCount: () => calls,
    currentServer: () => server,
    currentWire: () => wire,
    async dispose() {
      try {
        await client.stop();
      } catch {
        /* noop */
      }
      server.dispose();
      try {
        clientConn.dispose();
      } catch {
        /* noop */
      }
      try {
        wire.destroy();
      } catch {
        /* noop */
      }
    },
  };
}

/**
 * Build a minimal `ChildProcessWithoutNullStreams`-shaped
 * shim. The LspClient only uses `proc.stdout` (Readable) and
 * `proc.stdin` (Writable) at runtime, but TypeScript's type
 * signature requires a fuller surface.
 *
 * The shim *does* honor event subscriptions and wires them to
 * the underlying stream so the LspClient's `proc.on('exit')`
 * and `proc.on('error')` listeners fire when the wire is
 * destroyed (either by the fake-server's `crash()` or by
 * `proc.kill()`).
 */
function makeFakeChildProcess(wire: Wire): any {
  const emitter = new EventEmitter();
  const proc: any = {
    stdin: wire.clientStdin,
    stdout: wire.clientStdout,
    stderr: wire.clientStdin,
    stdio: [wire.clientStdin, wire.clientStdout, wire.clientStdin, null, null],
    pid: 99999,
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnargs: ['fake-server'],
    spawnfile: 'fake-server',
    connected: true,
    kill(sig?: any) {
      try {
        wire.clientStdin.destroy();
      } catch {
        /* noop */
      }
      try {
        wire.clientStdout.destroy();
      } catch {
        /* noop */
      }
      if (!proc.killed) {
        proc.killed = true;
        proc.exitCode = null;
        proc.signalCode = sig || 'SIGTERM';
        // Synchronous emit is fine — the LspClient's listeners
        // schedule their own async work.
        emitter.emit('exit', proc.exitCode, proc.signalCode);
      }
      return true;
    },
    on(event: string, handler: any) {
      emitter.on(event, handler);
      return proc;
    },
    once(event: string, handler: any) {
      emitter.once(event, handler);
      return proc;
    },
    off(event: string, handler: any) {
      emitter.off(event, handler);
      return proc;
    },
    emit(event: string, ...args: any[]) {
      return emitter.emit(event, ...args);
    },
    addListener(event: string, handler: any) {
      emitter.addListener(event, handler);
      return proc;
    },
    removeListener(event: string, handler: any) {
      emitter.removeListener(event, handler);
      return proc;
    },
    removeAllListeners(event?: string) {
      emitter.removeAllListeners(event);
      return proc;
    },
    setMaxListeners(n: number) {
      emitter.setMaxListeners(n);
      return proc;
    },
    getMaxListeners() {
      return emitter.getMaxListeners();
    },
    listeners(event: string) {
      return emitter.listeners(event);
    },
    rawListeners(event: string) {
      return emitter.rawListeners(event);
    },
    eventNames() {
      return emitter.eventNames();
    },
    listenerCount(event: string) {
      return emitter.listenerCount(event);
    },
    prependListener(event: string, handler: any) {
      emitter.prependListener(event, handler);
      return proc;
    },
    prependOnceListener(event: string, handler: any) {
      emitter.prependOnceListener(event, handler);
      return proc;
    },
    ref() {
      return proc;
    },
    unref() {
      return proc;
    },
  };

  // When the client's wire pipes get destroyed (e.g. via the
  // server-side `crash()`), translate that to a proc 'exit'
  // event so the LspClient's lifecycle listeners fire.
  wire.clientStdout.on('close', () => {
    if (!proc.killed) {
      proc.killed = true;
      proc.exitCode = null;
      proc.signalCode = null;
      emitter.emit('exit', proc.exitCode, proc.signalCode);
    }
  });
  wire.clientStdout.on('error', (e: Error) => {
    emitter.emit('error', e);
  });

  return proc;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('LspClient', () => {
  let fx: ClientFixture;

  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(async () => {
    await fx.dispose();
  });

  // ST-1 ─────────────────────────────────────────────────────────────
  it('ST-1: start() spawns + completes the initialize handshake', async () => {
    await fx.client.start();
    expect(fx.client.getState()).toBe<LspClientState>('ready');
    expect(fx.server.log.initializeParams.length).toBe(1);
    const params = fx.server.log.initializeParams[0];
    expect(params.rootUri).toMatch(/^file:\/\//);
    expect(params.workspaceFolders).toEqual([
      { uri: params.rootUri, name: 'root' },
    ]);
    expect(params.capabilities.textDocument.synchronization.dynamicRegistration).toBe(false);
  });

  // ST-2 ─────────────────────────────────────────────────────────────
  it('ST-2: request<T>() returns a typed result', async () => {
    await fx.client.start();
    const loc = await fx.client.request<any[]>(
      'textDocument/definition',
      {
        textDocument: { uri: 'file:///workspace/src/foo.ts' },
        position: { line: 0, character: 0 },
      },
      5_000,
    );
    expect(Array.isArray(loc)).toBe(true);
    expect((loc as any[])[0].uri).toBe('file:///def.ts');
  });

  // ST-3 ─────────────────────────────────────────────────────────────
  it('ST-3: didOpen-on-demand fires before the first definition request', async () => {
    await fx.client.start();
    const uri = 'file:///workspace/src/sample.ts';
    await fx.client.request<any[]>(
      'textDocument/definition',
      {
        textDocument: { uri },
        position: { line: 2, character: 5 },
      },
      5_000,
    );
    // The first definition triggers a didOpen. A second
    // definition against the same URI must NOT re-open it
    // (idempotent: client tracks openFiles).
    await fx.client.request<any[]>(
      'textDocument/definition',
      {
        textDocument: { uri },
        position: { line: 3, character: 0 },
      },
      5_000,
    );
    expect(fx.server.log.didOpenUris).toEqual([uri]);
    expect(fx.server.log.definitions.length).toBe(2);
  });

  // ST-4 ─────────────────────────────────────────────────────────────
  it('ST-4: serialized requests — three concurrent definitions complete in order', async () => {
    await fx.client.start();
    const a = fx.client.request<any>('textDocument/definition', { textDocument: { uri: 'file:///a.ts' }, position: { line: 0, character: 0 } }, 5_000);
    const b = fx.client.request<any>('textDocument/definition', { textDocument: { uri: 'file:///b.ts' }, position: { line: 1, character: 0 } }, 5_000);
    const c = fx.client.request<any>('textDocument/definition', { textDocument: { uri: 'file:///c.ts' }, position: { line: 2, character: 0 } }, 5_000);
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(Array.isArray(ra)).toBe(true);
    expect(Array.isArray(rb)).toBe(true);
    expect(Array.isArray(rc)).toBe(true);
    // The fake server received them in order (the assertions
    // on the order in `fx.server.log.definitions` is a strong
    // contract — the fake is FIFO because vscode-jsonrpc's
    // outgoing queue is FIFO).
    expect(fx.server.log.definitions.map((d) => d.params.textDocument.uri)).toEqual([
      'file:///a.ts',
      'file:///b.ts',
      'file:///c.ts',
    ]);
  });

  // ST-5 ─────────────────────────────────────────────────────────────
  it('ST-5: response past timeoutMs resolves to null (no hang)', async () => {
    await fx.client.start();
    fx.server.slowNextDefinition(800);
    const start = Date.now();
    const result = await fx.client.request<any>(
      'textDocument/definition',
      { textDocument: { uri: 'file:///slow.ts' }, position: { line: 0, character: 0 } },
      100, // 100ms timeout
    );
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // 100ms timeout, plus scheduling overhead. Generous bound.
    expect(elapsed).toBeLessThan(600);
  });

  // ST-6 ─────────────────────────────────────────────────────────────
  it('ST-6: crash mid-request → in-flight null + supervised restart + retry succeeds', async () => {
    await fx.dispose();
    const rf = makeRestartableFixture({ maxRestarts: 2 });
    try {
      const { client } = rf.fixture;
      const currentServer = rf.currentServer;
      const spawnCount = rf.spawnCount;
      await client.start();
      expect(spawnCount()).toBe(1);
      expect(client.getState()).toBe('ready');

      // Make the in-flight request slow so we can crash the
      // server while the response is pending.
      currentServer().slowNextDefinition(400);
      const inFlight = client.request<any>(
        'textDocument/definition',
        { textDocument: { uri: 'file:///crash.ts' }, position: { line: 0, character: 0 } },
        5_000,
      );
      await new Promise<void>((r) => setTimeout(r, 30));
      currentServer().crash();
      const crashed = await inFlight;
      expect(crashed).toBeNull();

      // Wait for the supervised restart to settle. The
      // exit-handler schedules it async; the LspClient flips
      // to ready once restart() succeeds.
      for (let i = 0; i < 50; i++) {
        if (client.getState() === 'ready') break;
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      expect(client.getState()).toBe('ready');
      // spawnCount incremented because restart re-spawned.
      expect(spawnCount()).toBe(2);
      // restartCount is internal; we verify it indirectly
      // via budget-exhaustion (ST-7).

      // The retry should land on the *new* server. We assert
      // the new server's definition log has the new call.
      const retry = await client.request<any>(
        'textDocument/definition',
        { textDocument: { uri: 'file:///retry.ts' }, position: { line: 0, character: 0 } },
        5_000,
      );
      expect(retry).not.toBeNull();
      expect(Array.isArray(retry)).toBe(true);
      expect(currentServer().log.definitions.map((d) => d.params.textDocument.uri)).toContain(
        'file:///retry.ts',
      );
    } finally {
      await rf.dispose();
    }
  });

  // ST-7 ─────────────────────────────────────────────────────────────
  it('ST-7: budget exhausted (≤2) → degrade, no throw', async () => {
    // We build a fixture where every spawn() returns a process
    // that has ALREADY crashed. The LspClient tries to start,
    // restarts (budget 0 already used), tries again, exhausts
    // budget, and flips to `degraded`.
    await fx.dispose();
    const wire = makeWire();
    wire.destroy(); // pre-destroyed — every spawn is dead on arrival
    const deadConn = createMessageConnection(
      new StreamMessageReader(wire.clientStdout),
      new StreamMessageWriter(wire.clientStdin),
      NullLogger,
    );
    // `listen()` so the LspClient can use it. The wire is
    // already destroyed, so any write will fail — the LspClient
    // will detect this on its first sendRequest and reject.
    deadConn.listen();
    const deadProc = makeFakeChildProcess(wire);

    const client = new LspClient({
      maxRestarts: 2,
      _inject: {
        spawn: () => ({ process: deadProc, connection: deadConn }),
      },
    });

    // start() should throw because spawn/initialize can't
    // complete (the dead wire causes the initialize roundtrip
    // to fail).
    await expect(client.start()).rejects.toBeDefined();
    // State flips to degraded.
    expect(client.getState()).toBe('degraded');

    // Subsequent request() returns null without throwing.
    const r = await client.request<any>(
      'textDocument/definition',
      { textDocument: { uri: 'file:///x.ts' }, position: { line: 0, character: 0 } },
      100,
    );
    expect(r).toBeNull();

    // stop() is idempotent + no-throw from any state.
    await expect(client.stop()).resolves.toBeUndefined();

    // Cleanup
    try {
      deadConn.dispose();
    } catch {
      /* noop */
    }
  });

  // ST-8 ─────────────────────────────────────────────────────────────
  it('ST-8: stop() sends shutdown then exit', async () => {
    await fx.client.start();
    await fx.client.stop();
    expect(fx.server.log.shutdownCount).toBe(1);
    expect(fx.server.log.exitCount).toBe(1);
    expect(fx.client.getState()).toBe('stopped');
  });

  // ST-9 ─────────────────────────────────────────────────────────────
  it('ST-9: stop() before start() is a no-throw no-op', async () => {
    // Don't start the client.
    await expect(fx.client.stop()).resolves.toBeUndefined();
    expect(fx.client.getState()).toBe('idle');
  });

  // ─── Bonus: state machine + restart counter + idempotency ─────────
  it('exports MAX_RESTARTS = 2 per spec', () => {
    expect(MAX_RESTARTS).toBe(2);
  });

  it('didOpen is idempotent — re-opening a known URI does not re-notify', async () => {
    await fx.client.start();
    await fx.client.didOpen('file:///x.ts', 'const x = 1;');
    await fx.client.didOpen('file:///x.ts', 'const x = 1;');
    // The server's onNotification handler runs async; give it
    // a tick to land in the log.
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(fx.server.log.didOpenUris).toEqual(['file:///x.ts']);
  });
});
