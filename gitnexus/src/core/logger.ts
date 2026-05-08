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
 * Test capture:
 *   The exported `logger` singleton is a Proxy that forwards every call to a
 *   lazily-built pino instance. Tests use `_captureLogger()` to redirect that
 *   inner instance to a memory stream so they can assert on records the
 *   production code logged. See `gitnexus/test/unit/logger.test.ts` for the
 *   pattern.
 */
import pino, { type Logger, type LoggerOptions, type DestinationStream } from 'pino';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';

export interface CreateLoggerOptions {
  /** When set, this env var (truthy at construction time) bumps level to 'debug'. */
  debugEnvVar?: string;
  /** Override destination stream — primarily for tests. */
  destination?: DestinationStream;
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

/**
 * Create a named child logger. When `opts.destination` is provided it bypasses
 * the default stdout sink (useful for test capture). When `opts.debugEnvVar` is
 * set and truthy at call time, the child runs at 'debug' level.
 */
export function createLogger(name: string, opts?: CreateLoggerOptions): Logger {
  const debugRequested = opts?.debugEnvVar ? isTruthyEnv(process.env[opts.debugEnvVar]) : false;

  if (opts?.destination) {
    return pino(
      { level: debugRequested ? 'debug' : 'info', base: undefined, name },
      opts.destination,
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
let _cached: Logger | undefined;

function _getInner(): Logger {
  if (_cached) return _cached;
  // Always go through createLogger so future defaults (serializers, redaction,
  // formatters) apply uniformly. The destination override is honored when set
  // by `_captureLogger()` below.
  _cached = createLogger(
    'gitnexus',
    _activeDestination ? { destination: _activeDestination } : undefined,
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
 * Not a public API; underscore-prefixed and called only from test code.
 * Throws if a previous capture is still active — see the body for context.
 */
export function _captureLogger(): LoggerCapture {
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
      _cached = undefined;
    },
  };
}
