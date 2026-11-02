/**
 * Centralized structured logger for GitNexus.
 *
 * Wraps `pino` so the rest of the codebase imports from one place. Pino's
 * NDJSON output is structurally log-injection-resistant (CWE-117 / CodeQL
 * `js/log-injection`): each record is a single JSON object on its own line,
 * with all string field values JSON-escaped. This replaces hand-rolled
 * sanitizers (see PR #1329 history) that had recurring edge-case gaps
 * (undefined Error.message, U+2028/U+2029, ANSI/C0).
 *
 * Usage:
 *   import { logger, createLogger } from '../core/logger.js';
 *   logger.warn({ groupDir }, 'msg');
 *   const childLogger = createLogger('bridge-db', { debugEnvVar: 'GITNEXUS_DEBUG_BRIDGE' });
 *
 * Operator semantics:
 *   - Default level: 'info' (matches pino default; preserves visibility of
 *     existing `console.log` migrations)
 *   - When `opts.debugEnvVar` is set and that env var is truthy at
 *     createLogger time, that named child logs at level 'debug'
 *   - Output is NDJSON in production / CI / vitest. pino-pretty is used only
 *     when stdout is a TTY AND CI is unset AND VITEST is unset, so test
 *     and pipeline output stay parseable.
 *
 * Host sink (#3620):
 *   A process that embeds GitNexus (its own service around `serve` or the MCP
 *   server) can route the records into its own logging with
 *   `configureLoggerSink({ destination, level, mixin })`: the `logger`
 *   singleton and every `createLogger()` call made after it write to that
 *   destination instead of stderr, with the mixin's fields on each record. The
 *   returned function restores what was there before. Without a call nothing
 *   changes, and the check costs one branch at logger construction, not per
 *   record.
 *
 * Test capture:
 *   The exported `logger` singleton is a Proxy that forwards every call to a
 *   lazily-built pino instance. Tests use `_captureLogger()` to redirect that
 *   inner instance to a memory stream so they can assert on records the
 *   production code logged. See `gitnexus/test/unit/logger.test.ts` for the
 *   pattern. A capture takes precedence over a host sink while it is active.
 */
import pino, { type Logger, type LoggerOptions, type DestinationStream } from 'pino';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';

export interface CreateLoggerOptions {
  /** When set, this env var (truthy at construction time) bumps level to 'debug'. */
  debugEnvVar?: string;
  /** Override destination stream — primarily for tests. */
  destination?: DestinationStream;
  /**
   * Explicit level for the destination-override path — primarily for tests that
   * need to capture below the default `info` (e.g. asserting a `debug` record).
   * Ignored unless `destination` is set; `debugEnvVar` still wins when truthy.
   */
  level?: string;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

function shouldUsePretty(): boolean {
  // Logger writes to stderr (fd 2) so CLI data on stdout (fd 1) stays clean.
  // Pretty-print only when stderr is a TTY and not in CI/test environments.
  return (
    process.stderr.isTTY === true &&
    !isTruthyEnv(process.env.CI) &&
    !isTruthyEnv(process.env.VITEST)
  );
}

/**
 * Default pino destination — writes to stderr (fd 2) so CLI commands can
 * keep stdout (fd 1) clean for tool data output (#324). Pino defaults to
 * stdout; we override here.
 *
 * `sync: false` (SonicBoom buffered writes) so logger calls don't issue a
 * blocking `write(2)` syscall on every record. Hot paths (parse-impl,
 * ingestion phases, per-query backend calls) pay the cost without it.
 *
 * The buffered-write trade-off is record loss on hard exit. We mitigate via:
 *   - A `process.on('beforeExit')` hook below that calls `flushSync()` on
 *     normal exits.
 *   - The exported `flushLoggerSync()` helper, which entry-point shutdown
 *     handlers (SIGINT/SIGTERM) MUST call before `process.exit(N)` so
 *     in-flight buffered records still reach stderr.
 *   - `pino.final(...)` integration in `uncaughtException` / `unhandledRejection`
 *     handlers (see `gitnexus/src/cli/serve.ts` and `gitnexus/src/server/api.ts`).
 *
 * Skipped under `VITEST` so vitest's between-test cleanup doesn't fight
 * `_captureLogger()`'s lifecycle. Tests use an in-memory destination via
 * `_captureLogger()` and never reach this branch.
 */
let _dest: ReturnType<typeof pino.destination> | undefined;

function defaultDestination(): DestinationStream {
  if (_dest) return _dest;
  _dest = pino.destination({ dest: 2, sync: false });
  return _dest;
}

/**
 * Flush any buffered records on the default destination. Entry-point
 * shutdown handlers (`SIGINT` / `SIGTERM`) MUST call this before
 * `process.exit(N)` — otherwise async-buffered records are lost on hard
 * exit. No-op when the destination hasn't been constructed yet (logger
 * module imported but never emitted) or when called from `_captureLogger`
 * test mode (tests use an in-memory destination).
 */
export function flushLoggerSync(): void {
  // A host sink that buffers (a SonicBoom, a file stream of its own) is
  // flushed the same way; one without `flushSync` has nothing to flush here.
  const sinkDestination = _sink?.destination as { flushSync?: () => void } | undefined;
  if (typeof sinkDestination?.flushSync === 'function') {
    try {
      sinkDestination.flushSync();
    } catch {
      // Same trade-off as below: a closed destination must not turn a
      // shutdown into a crash.
    }
  }
  if (!_dest) return;
  try {
    _dest.flushSync();
  } catch {
    // Defend against a destination that has already been closed (e.g.,
    // double-flush on rapid shutdown). Losing the flush attempt is the
    // correct trade-off vs. throwing during shutdown.
  }
}

/**
 * Idempotent registration: `process.on('beforeExit')` flushes the buffered
 * destination before normal exit. Skipped under VITEST to avoid interfering
 * with `_captureLogger()`'s lifecycle and vitest's per-worker cleanup.
 */
let _flushHookInstalled = false;
function installFlushHook(): void {
  if (_flushHookInstalled) return;
  if (isTruthyEnv(process.env.VITEST)) return;
  _flushHookInstalled = true;
  process.on('beforeExit', () => {
    flushLoggerSync();
  });
}

/**
 * Probe whether `pino-pretty` is resolvable from this module. Cached for
 * the lifetime of the process — the resolve cost only happens once, and
 * the one-time stderr warning on miss only fires once.
 *
 * Production installs ship pino-pretty as a runtime dependency (see
 * gitnexus/package.json). The probe is the safety net for `--omit=optional`,
 * `--no-package-lock` style installs and for any environment where the
 * module turns out to be missing for reasons we can't predict — pino's
 * own transport-resolution path resolves the target lazily at FIRST log
 * write, so without this probe a missing module would throw deep inside
 * the pino call site rather than at logger construction.
 */
let _prettyAvailable: boolean | null = null;
const _require = createRequire(import.meta.url);

function isPrettyAvailable(): boolean {
  if (_prettyAvailable !== null) return _prettyAvailable;
  try {
    _require.resolve('pino-pretty');
    _prettyAvailable = true;
  } catch {
    _prettyAvailable = false;
    // One-time stderr warning so operators learn why TTY output is plain
    // NDJSON instead of pretty-printed. Use realStderrWrite-style direct
    // write — going through `logger` here would recurse.
    process.stderr.write(
      '[gitnexus:logger] pino-pretty unavailable; falling back to NDJSON on stderr\n',
    );
  }
  return _prettyAvailable;
}

/**
 * @internal Test-only reset for the pino-pretty availability cache. Lets
 * unit tests exercise both resolve outcomes within the same vitest worker.
 */
export function _resetPrettyAvailableCache(): void {
  _prettyAvailable = null;
}

/**
 * Build the pino-pretty transport options. Internal — exported only so unit
 * tests can exercise the probe path without going through `shouldUsePretty()`
 * (which is structurally false under vitest).
 */
export function _tryBuildPrettyTransport(): LoggerOptions['transport'] | undefined {
  if (!isPrettyAvailable()) return undefined;
  return {
    target: 'pino-pretty',
    options: {
      // Route to stderr (fd 2) so pretty output doesn't contaminate
      // CLI tool data on stdout (fd 1). pino-pretty's default is fd 1,
      // which would interleave with `gitnexus query | jq` output.
      destination: 2,
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  };
}

/**
 * Pino accepts `'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'`.
 * Anything else is silently ignored at runtime; we narrow here so a typo in
 * the env var produces the documented default rather than masking the issue.
 */
const PINO_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function resolveBaseLevel(): string {
  const fromEnv = process.env.GITNEXUS_LOG_LEVEL;
  if (fromEnv && PINO_LEVELS.has(fromEnv.toLowerCase())) {
    return fromEnv.toLowerCase();
  }
  return 'info';
}

function buildBaseOptions(): LoggerOptions {
  const opts: LoggerOptions = {
    level: resolveBaseLevel(),
    base: undefined,
  };
  if (shouldUsePretty()) {
    const transport = _tryBuildPrettyTransport();
    if (transport) opts.transport = transport;
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/*  Host sink (#3620)                                                  */
/* ------------------------------------------------------------------ */

export interface LoggerSinkOptions {
  /** Where records go instead of stderr: any writable stream, a pino destination included. */
  destination: DestinationStream;
  /**
   * Base level for the singleton and for later children. When unset,
   * `GITNEXUS_LOG_LEVEL` applies as it does on stderr. A child's `debugEnvVar`
   * still wins when truthy.
   */
  level?: string;
  /**
   * Extra fields merged into every record (pino's `mixin`), for example a
   * request id read from an AsyncLocalStorage. Called once per record; a field
   * the record carries itself wins over the mixin's. A mixin that throws does
   * not break the record: it is written without the mixin's fields and the
   * failure is reported on stderr once.
   */
  mixin?: () => Record<string, unknown>;
}

interface ActiveSink {
  readonly destination: DestinationStream;
  readonly level: string | undefined;
  readonly mixin: (() => Record<string, unknown>) | undefined;
  /** The sink that was active when this one was configured. */
  readonly previous: ActiveSink | undefined;
  /** Set by this sink's restore; a retired sink is never made active again. */
  retired: boolean;
}

let _sink: ActiveSink | undefined;

/** The nearest sink in the chain whose owner has not restored it yet. */
function nearestLiveSink(from: ActiveSink | undefined): ActiveSink | undefined {
  let sink = from;
  while (sink !== undefined && sink.retired) sink = sink.previous;
  return sink;
}

/**
 * A host mixin runs inside every log call of GitNexus, so a bug in it must not
 * turn a `logger.warn` deep in the ingestion into a crash. The record goes out
 * without the mixin's fields, and the failure is reported once, the same way
 * a missing pino-pretty is: on stderr directly, since the logger is what is
 * failing.
 */
function guardMixin(mixin: () => Record<string, unknown>): () => Record<string, unknown> {
  let warned = false;
  return () => {
    try {
      const fields = mixin();
      return fields !== null && typeof fields === 'object' ? fields : {};
    } catch (error) {
      if (!warned) {
        warned = true;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[gitnexus:logger] host mixin threw; records continue without its fields: ${message}\n`,
        );
      }
      return {};
    }
  };
}

/**
 * Route the default `logger` and every `createLogger()` call made from now on
 * into the host's own sink. The singleton is a Proxy, so modules that imported
 * it before this call pick the sink up on their next record; a named child
 * built before this call keeps the destination it was built with.
 *
 * Returns a function that retires this sink. When it is the active one, the
 * nearest earlier sink that has not been retired itself becomes active again,
 * or stderr when there is none. When a later `configureLoggerSink()` has
 * replaced it, the active state is left alone, but the sink stays retired, so
 * a later restore never brings it back: host and plugin lifetimes do not have
 * to end in strict LIFO order.
 *
 * No pretty transport and no `beforeExit` flush hook are installed for a host
 * sink: the destination belongs to the host, which decides how it is flushed
 * (`flushLoggerSync()` calls the destination's `flushSync` when it has one).
 */
export function configureLoggerSink(opts: LoggerSinkOptions): () => void {
  const destination = opts?.destination as { write?: unknown } | undefined;
  if (typeof destination?.write !== 'function') {
    throw new TypeError(
      'configureLoggerSink: `destination` must be a writable stream (an object with a write() method)',
    );
  }
  if (opts.level !== undefined && !PINO_LEVELS.has(opts.level.toLowerCase())) {
    throw new RangeError(
      `configureLoggerSink: unknown level "${opts.level}"; expected one of ${[...PINO_LEVELS].join(', ')}`,
    );
  }
  if (opts.mixin !== undefined && typeof opts.mixin !== 'function') {
    throw new TypeError('configureLoggerSink: `mixin` must be a function returning an object');
  }
  const sink: ActiveSink = {
    destination: opts.destination,
    level: opts.level?.toLowerCase(),
    mixin: opts.mixin ? guardMixin(opts.mixin) : undefined,
    previous: _sink,
    retired: false,
  };
  _sink = sink;
  // The singleton is rebuilt on its next call so it picks the sink up.
  _cached = undefined;
  return () => {
    sink.retired = true;
    if (_sink !== sink) return;
    _sink = nearestLiveSink(sink.previous);
    _cached = undefined;
  };
}

/**
 * Create a named child logger. When `opts.destination` is provided it bypasses
 * the default stdout sink (useful for test capture). When `opts.debugEnvVar` is
 * set and truthy at call time, the child runs at 'debug' level. With a host
 * sink configured (`configureLoggerSink`), the child writes there.
 */
export function createLogger(name: string, opts?: CreateLoggerOptions): Logger {
  const debugRequested = opts?.debugEnvVar ? isTruthyEnv(process.env[opts.debugEnvVar]) : false;

  if (opts?.destination) {
    return pino(
      { level: debugRequested ? 'debug' : (opts.level ?? 'info'), base: undefined, name },
      opts.destination,
    );
  }

  const sink = _sink;
  if (sink) {
    return pino(
      {
        level: debugRequested ? 'debug' : (sink.level ?? resolveBaseLevel()),
        base: undefined,
        name,
        ...(sink.mixin ? { mixin: sink.mixin } : {}),
      },
      sink.destination,
    );
  }

  const base = buildBaseOptions();
  // When using a transport (pino-pretty), pino manages the destination
  // internally and we cannot pass one explicitly. When transport is absent,
  // route to stderr so stdout stays clean for CLI data output.
  let root: Logger;
  if (base.transport) {
    root = pino({ ...base, level: debugRequested ? 'debug' : base.level });
  } else {
    root = pino({ ...base, level: debugRequested ? 'debug' : base.level }, defaultDestination());
    // The default destination is buffered (`sync: false`); register the
    // graceful-exit flush hook now that we know the destination will be
    // used. Idempotent — runs at most once per process. Skipped under
    // VITEST so test cleanup doesn't fight `_captureLogger`.
    installFlushHook();
  }
  return root.child({ name });
}

/* ------------------------------------------------------------------ */
/*  Default singleton (Proxy-backed for test capture)                  */
/* ------------------------------------------------------------------ */

let _activeDestination: DestinationStream | undefined;
let _activeLevel: string | undefined;
let _cached: Logger | undefined;

function _getInner(): Logger {
  if (_cached) return _cached;
  // Always go through createLogger so future defaults (serializers, redaction,
  // formatters) apply uniformly. The destination override is honored when set
  // by `_captureLogger()` below.
  _cached = createLogger(
    'gitnexus',
    _activeDestination ? { destination: _activeDestination, level: _activeLevel } : undefined,
  );
  return _cached;
}

/**
 * Default singleton logger (`name: 'gitnexus'`). Backed by a Proxy so test
 * capture (`_captureLogger()`) can redirect output without breaking modules
 * that already imported the singleton at module-load time.
 */
export const logger = new Proxy({} as Logger, {
  get(_target, prop) {
    const inner = _getInner();
    // Reflect.get keeps symbol-keyed lookups (e.g. Symbol.toPrimitive) intact;
    // a `prop as string` cast would silently coerce them to the wrong key.
    const value = Reflect.get(inner as object, prop, inner);
    if (typeof value === 'function') {
      return (value as (...a: unknown[]) => unknown).bind(inner);
    }
    return value;
  },
}) as Logger;

/**
 * Shape of a parsed pino record. `level`, `time`, and `msg` are always
 * present; `name` is set when emitted from a named child logger; arbitrary
 * additional fields appear when callers pass a structured first arg.
 *
 * Exported so test helpers and downstream skills can type-narrow capture
 * results without inline `Record<string, unknown>` casts.
 */
export interface PinoLogRecord {
  level: number;
  time: number;
  msg: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * In-memory Writable used by `_captureLogger()` and by tests that build
 * their own pino destination. Exported so the shape lives in one place
 * (previously duplicated between this module and `logger.test.ts`).
 *
 * `text()` and `records()` are convenience helpers test code calls. They
 * don't appear in production hot paths — only test destinations capture
 * here — so the surface is intentionally small.
 */
export class MemoryWritable extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    cb();
  }
  /** Concatenate every captured write back into a single string. */
  text(): string {
    return this.chunks.join('');
  }
  /** Parse captured writes as one NDJSON record per non-empty line. */
  records(): PinoLogRecord[] {
    return this.text()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as PinoLogRecord);
  }
}

export interface LoggerCapture {
  records(): PinoLogRecord[];
  text(): string;
  restore(): void;
}

/**
 * Test helper. Redirects the default `logger` singleton to an in-memory
 * stream and returns a capture object plus a restore function.
 *
 * Pattern:
 *   let cap: LoggerCapture;
 *   beforeEach(() => { cap = _captureLogger(); });
 *   afterEach(() => { cap.restore(); });
 *   it('warns', () => {
 *     fnUnderTest();
 *     expect(cap.records().some(r => r.msg?.includes('clamping'))).toBe(true);
 *   });
 *
 * Pass `level` (e.g. 'debug') to capture below the default 'info' — needed to
 * assert that a record was emitted at debug rather than merely absent.
 *
 * Not a public API; underscore-prefixed and called only from test code.
 * Throws if a previous capture is still active — see the body for context.
 */
export function _captureLogger(level?: string): LoggerCapture {
  // Guard against double-capture: forgetting `restore()` between two
  // `_captureLogger()` calls silently abandoned the previous capture and
  // corrupted logger state for the rest of the vitest worker. Throwing here
  // surfaces the bug at the moment of misuse instead of as inscrutable
  // missing-records assertions in unrelated tests.
  if (_activeDestination !== undefined) {
    throw new Error(
      '_captureLogger: a previous capture is still active — call restore() before starting a new one.',
    );
  }
  const w = new MemoryWritable();
  _activeDestination = w;
  _activeLevel = level;
  _cached = undefined;
  return {
    records: () =>
      w.chunks
        .join('')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as PinoLogRecord),
    text: () => w.chunks.join(''),
    restore: () => {
      _activeDestination = undefined;
      _activeLevel = undefined;
      _cached = undefined;
    },
  };
}
