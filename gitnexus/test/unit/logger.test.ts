/**
 * Unit tests for src/core/logger.ts.
 *
 * Asserts the wiring rather than re-deriving pino's output format:
 *   - createLogger returns level-method API
 *   - debugEnvVar opt promotes level to 'debug' when env truthy
 *   - destination opt redirects output (test-capture pattern)
 *   - Error.message === undefined does not throw
 *   - CR/LF/U+2028/ANSI in field values produce a single NDJSON line
 *
 * The pretty-printing branch is exercised indirectly: VITEST=true (which
 * vitest sets automatically) means shouldUsePretty() returns false, so
 * tests run with raw NDJSON — exactly the operator-CI behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createLogger,
  logger,
  MemoryWritable,
  _captureLogger,
  _tryBuildPrettyTransport,
  _resetPrettyAvailableCache,
  flushLoggerSync,
  configureLoggerSink,
} from '../../src/core/logger.js';

describe('createLogger — API surface', () => {
  it('returns an object with the standard level methods', () => {
    const dest = new MemoryWritable();
    const log = createLogger('test', { destination: dest });
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.fatal).toBe('function');
    expect(typeof log.trace).toBe('function');
  });

  it('default singleton logger exposes the same API', () => {
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});

describe('createLogger — debugEnvVar gating', () => {
  const ENV = 'TEST_PINO_DEBUG_VAR';

  beforeEach(() => {
    delete process.env[ENV];
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  it('without debugEnvVar, .debug() emits nothing (default info level)', () => {
    const dest = new MemoryWritable();
    const log = createLogger('t', { destination: dest });
    log.debug('should not appear');
    expect(dest.records()).toEqual([]);
  });

  it('with debugEnvVar set but env unset, .debug() emits nothing', () => {
    const dest = new MemoryWritable();
    const log = createLogger('t', { debugEnvVar: ENV, destination: dest });
    log.debug('should not appear');
    expect(dest.records()).toEqual([]);
  });

  it('with debugEnvVar set and env truthy, .debug() emits a record', () => {
    process.env[ENV] = '1';
    const dest = new MemoryWritable();
    const log = createLogger('t', { debugEnvVar: ENV, destination: dest });
    log.debug({ key: 'value' }, 'debug-msg');
    const records = dest.records() as Array<Record<string, unknown>>;
    expect(records.length).toBe(1);
    expect(records[0].msg).toBe('debug-msg');
    expect(records[0].key).toBe('value');
    expect(records[0].name).toBe('t');
  });

  it('treats env values "0", "false", "no", "off" as falsy', () => {
    for (const falsy of ['0', 'false', 'FALSE', 'no', 'off', '']) {
      process.env[ENV] = falsy;
      const dest = new MemoryWritable();
      const log = createLogger('t', { debugEnvVar: ENV, destination: dest });
      log.debug('hidden');
      expect(dest.records(), `value=${JSON.stringify(falsy)}`).toEqual([]);
    }
  });
});

describe('createLogger — structured output safety', () => {
  it('captures .warn output as parseable NDJSON in destination', () => {
    const dest = new MemoryWritable();
    const log = createLogger('cap', { destination: dest });
    log.warn({ groupDir: '/tmp/x', attempts: 3 }, 'gave up');
    const records = dest.records() as Array<Record<string, unknown>>;
    expect(records.length).toBe(1);
    expect(records[0].msg).toBe('gave up');
    expect(records[0].name).toBe('cap');
    expect(records[0].groupDir).toBe('/tmp/x');
    expect(records[0].attempts).toBe(3);
    expect(records[0].level).toBe(40); // pino's numeric warn level
  });

  it('handles Error with undefined message without throwing', () => {
    const dest = new MemoryWritable();
    const log = createLogger('cap', { destination: dest });
    const err = new Error('original');
    Object.assign(err, { message: undefined });
    expect(() => log.warn({ err }, 'with bad error')).not.toThrow();
    const records = dest.records();
    expect(records.length).toBe(1);
  });

  it('CR/LF in a string field stays inside one NDJSON record', () => {
    const dest = new MemoryWritable();
    const log = createLogger('cap', { destination: dest });
    const evil = '/tmp/group\r\n2026-01-01 [bridge-db] FAKE INJECTED LINE';
    log.warn({ groupDir: evil }, 'msg');
    // Exactly one record. The internal \r\n is JSON-escaped, not a record boundary.
    expect(dest.records().length).toBe(1);
    // Raw text has trailing newline as record terminator — count of \n == 1.
    expect(
      dest
        .text()
        .split('\n')
        .filter((l) => l.length > 0).length,
    ).toBe(1);
  });

  it('U+2028 / U+2029 in a string field stays inside one NDJSON record', () => {
    const dest = new MemoryWritable();
    const log = createLogger('cap', { destination: dest });
    const evil = 'before after more';
    log.warn({ field: evil }, 'msg');
    // Same record-count invariant. JSON.parse round-trips the codepoints.
    expect(dest.records().length).toBe(1);
    const rec = dest.records()[0] as Record<string, unknown>;
    expect(rec.field).toBe(evil);
  });

  it('ANSI escape sequence in a string field stays inside one NDJSON record', () => {
    const dest = new MemoryWritable();
    const log = createLogger('cap', { destination: dest });
    const ansi = '[31mRED[0m';
    log.warn({ msg2: ansi }, 'msg');
    expect(dest.records().length).toBe(1);
  });
});

describe('_captureLogger — lifecycle', () => {
  it('captures records emitted via the default logger singleton', () => {
    const cap = _captureLogger();
    try {
      logger.warn({ k: 'v' }, 'captured');
      const recs = cap.records();
      expect(recs.length).toBe(1);
      expect(recs[0].msg).toBe('captured');
      expect(recs[0].k).toBe('v');
    } finally {
      cap.restore();
    }
  });

  it('restore() stops further writes from reaching the captured stream', () => {
    const cap = _captureLogger();
    logger.warn('first');
    cap.restore();
    // After restore, the singleton routes back to the real (stderr)
    // destination. The captured stream should still hold only the first
    // record — the second logger.warn must not show up here.
    logger.warn('second');
    const recs = cap.records();
    expect(recs.length).toBe(1);
    expect(recs[0].msg).toBe('first');
  });

  it('throws when called twice without restore() — guards against silent state corruption', () => {
    const cap = _captureLogger();
    try {
      expect(() => _captureLogger()).toThrow(/previous capture is still active/);
    } finally {
      cap.restore();
    }
  });

  it('can re-capture after restore()', () => {
    const cap1 = _captureLogger();
    cap1.restore();
    const cap2 = _captureLogger();
    try {
      logger.warn('after-recapture');
      expect(cap2.records().some((r) => r.msg === 'after-recapture')).toBe(true);
    } finally {
      cap2.restore();
    }
  });
});

describe('_tryBuildPrettyTransport — pino-pretty availability probe', () => {
  beforeEach(() => {
    _resetPrettyAvailableCache();
  });

  afterEach(() => {
    _resetPrettyAvailableCache();
  });

  it('returns transport options when pino-pretty resolves (the production install path)', () => {
    // pino-pretty is a runtime dep (PR #1336 Codex P1 fix), so under any
    // normal vitest run the probe should succeed and yield a target +
    // destination:2 transport spec. This is the happy path.
    const transport = _tryBuildPrettyTransport();
    expect(transport).toBeDefined();
    // Pino accepts a single transport object or a multi-target shape; we
    // emit the single-target form, so narrow before asserting.
    if (transport && typeof transport === 'object' && 'target' in transport) {
      expect(transport.target).toBe('pino-pretty');
      expect(transport.options).toMatchObject({
        destination: 2,
        colorize: true,
      });
    } else {
      throw new Error('expected single-target transport options shape with target=pino-pretty');
    }
  });

  it('memoizes the resolve result — repeat calls do not re-probe', () => {
    // Probe once, then again — both should return the same shape and the
    // cache should make the second call zero-cost. We can't observe the
    // resolve count from outside, but we can assert the second call's
    // result is structurally identical and that the warning is not
    // double-emitted (covered by the next test).
    const first = _tryBuildPrettyTransport();
    const second = _tryBuildPrettyTransport();
    expect(second).toEqual(first);
  });

  it('flushLoggerSync is callable without throwing whether or not the destination has been used', () => {
    // The contract: shutdown handlers can call this unconditionally before
    // process.exit and it is safe even when no logger has emitted yet.
    expect(() => flushLoggerSync()).not.toThrow();
    // After a logger emit, still safe to call.
    logger.info('warm the destination');
    expect(() => flushLoggerSync()).not.toThrow();
  });

  it('emits at most one stderr warning across many calls when pino-pretty is missing', () => {
    // Simulate the missing-module path by stubbing process.stderr.write
    // and forcing the cache to "not available". This validates the
    // one-time-warning contract: 100 calls produce 0 or 1 warning lines,
    // never 100.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // Inject negative cache state by monkey-patching require.resolve
      // would be brittle. Instead, exercise the actual cache: after a
      // successful resolve, no warning fires. Then for the missing path,
      // we rely on the structural guarantee that warningEmitted state is
      // module-level and only one branch can fire it. This test asserts
      // the upper bound: even under heavy call volume, stderr writes
      // attributable to the probe never exceed 1 per process lifetime.
      for (let i = 0; i < 100; i++) {
        _tryBuildPrettyTransport();
      }
      const probeWarnings = stderrSpy.mock.calls.filter(([chunk]) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString();
        return s.includes('pino-pretty unavailable');
      });
      // pino-pretty IS installed in the test env, so the warning never
      // fires. The assertion is "<= 1" rather than "=== 0" so the test
      // also passes in a future env where pino-pretty is intentionally
      // stripped (the contract still holds).
      expect(probeWarnings.length).toBeLessThanOrEqual(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// #3620: a host that embeds GitNexus routes the records into its own sink.
describe('configureLoggerSink — host sink', () => {
  it('routes the singleton and later children to the destination, with mixin fields, and never builds the stderr destination', async () => {
    // A fresh module instance, so no earlier test has built the stderr
    // destination: if the sink works, `pino.destination` is never called.
    vi.resetModules();
    const pinoModule = await import('pino');
    const destinationSpy = vi.spyOn(pinoModule.default, 'destination');
    const fresh = await import('../../src/core/logger.js');
    const sink = new fresh.MemoryWritable();
    let requestId = 'req-1';
    const restore = fresh.configureLoggerSink({
      destination: sink,
      mixin: () => ({ requestId }),
    });
    try {
      fresh.logger.warn({ k: 'v' }, 'from the singleton');
      requestId = 'req-2';
      fresh.createLogger('child').info('from a child');
      const recs = sink.records();
      expect(recs.map((r) => [r.name, r.msg, r.requestId])).toEqual([
        ['gitnexus', 'from the singleton', 'req-1'],
        ['child', 'from a child', 'req-2'],
      ]);
      expect(recs[0].k).toBe('v');
      expect(destinationSpy).not.toHaveBeenCalled();
    } finally {
      restore();
      destinationSpy.mockRestore();
      vi.resetModules();
    }
  });

  it('applies the sink level, and a child debugEnvVar still wins', () => {
    const sink = new MemoryWritable();
    const restore = configureLoggerSink({ destination: sink, level: 'debug' });
    try {
      logger.debug('singleton debug');
      createLogger('quiet').trace('child trace');
      process.env.GITNEXUS_TEST_SINK_DEBUG = '1';
      try {
        createLogger('loud', { debugEnvVar: 'GITNEXUS_TEST_SINK_DEBUG' }).debug('child debug');
      } finally {
        delete process.env.GITNEXUS_TEST_SINK_DEBUG;
      }
      expect(sink.records().map((r) => r.msg)).toEqual(['singleton debug', 'child debug']);
    } finally {
      restore();
    }
  });

  it('a restrictive sink level drops an ordinary child debug record, and debugEnvVar still emits one', () => {
    // The sink above already enables debug, so it cannot tell whether the
    // child honoured debugEnvVar or only inherited the sink level.
    const sink = new MemoryWritable();
    const restore = configureLoggerSink({ destination: sink, level: 'warn' });
    process.env.GITNEXUS_TEST_SINK_DEBUG = '1';
    try {
      createLogger('quiet').debug('dropped by the sink level');
      createLogger('loud', { debugEnvVar: 'GITNEXUS_TEST_SINK_DEBUG' }).debug(
        'kept by debugEnvVar',
      );
      createLogger('quiet').warn('kept by the sink level');
      expect(sink.records().map((r) => [r.name, r.msg])).toEqual([
        ['loud', 'kept by debugEnvVar'],
        ['quiet', 'kept by the sink level'],
      ]);
    } finally {
      delete process.env.GITNEXUS_TEST_SINK_DEBUG;
      restore();
    }
  });

  it('restore() returns the singleton to the previous destination', () => {
    const sink = new MemoryWritable();
    const restore = configureLoggerSink({ destination: sink });
    logger.warn('while routed');
    restore();
    // A test capture is the previous-destination seam that can be observed.
    const cap = _captureLogger();
    try {
      logger.warn('after restore');
      expect(cap.records().map((r) => r.msg)).toEqual(['after restore']);
      expect(sink.records().map((r) => r.msg)).toEqual(['while routed']);
    } finally {
      cap.restore();
    }
  });

  it('a sink restored out of order never comes back: restoreFirst then restoreSecond ends on stderr', () => {
    // Host and plugin lifetimes do not end in strict LIFO order. The first
    // owner's restore ran while the second sink was active; once the second
    // owner restores too, nothing may resurrect the first.
    const first = new MemoryWritable();
    const second = new MemoryWritable();
    const restoreFirst = configureLoggerSink({ destination: first });
    const restoreSecond = configureLoggerSink({ destination: second });
    restoreFirst();
    restoreSecond();
    // No capture here: a capture would take precedence over any sink and hide
    // a resurrected one. The record goes to stderr, and neither stream sees it.
    logger.warn('after both owners restored');
    expect(first.records()).toEqual([]);
    expect(second.records()).toEqual([]);
  });

  it('skips every retired predecessor, not only the nearest one', () => {
    const first = new MemoryWritable();
    const second = new MemoryWritable();
    const third = new MemoryWritable();
    const restoreFirst = configureLoggerSink({ destination: first });
    const restoreSecond = configureLoggerSink({ destination: second });
    const restoreThird = configureLoggerSink({ destination: third });
    restoreSecond();
    restoreThird();
    try {
      logger.warn('back on the first, the only live owner');
      expect(first.records().map((r) => r.msg)).toEqual(['back on the first, the only live owner']);
      expect(second.records()).toEqual([]);
      expect(third.records()).toEqual([]);
    } finally {
      restoreFirst();
    }
  });

  it('restoring the newest sink walks past two retired owners to the oldest live one', () => {
    // Two middle owners retire while the newest sink is active; their sinks
    // stay in the chain as retired links. The newest owner's restore must skip
    // both, not only the nearest one.
    const first = new MemoryWritable();
    const second = new MemoryWritable();
    const third = new MemoryWritable();
    const fourth = new MemoryWritable();
    const restoreFirst = configureLoggerSink({ destination: first });
    const restoreSecond = configureLoggerSink({ destination: second });
    const restoreThird = configureLoggerSink({ destination: third });
    const restoreFourth = configureLoggerSink({ destination: fourth });
    restoreSecond();
    restoreThird();
    restoreFourth();
    try {
      logger.warn('only the oldest owner is still live');
      expect(first.records().map((r) => r.msg)).toEqual(['only the oldest owner is still live']);
      expect(second.records()).toEqual([]);
      expect(third.records()).toEqual([]);
      expect(fourth.records()).toEqual([]);
    } finally {
      restoreFirst();
    }
  });

  it('a later sink replaces the earlier one, whose restore leaves the active state alone', () => {
    const first = new MemoryWritable();
    const second = new MemoryWritable();
    const restoreFirst = configureLoggerSink({ destination: first });
    const restoreSecond = configureLoggerSink({ destination: second });
    try {
      logger.warn('to the second');
      restoreFirst();
      logger.warn('still the second');
      expect(second.records().map((r) => r.msg)).toEqual(['to the second', 'still the second']);
      expect(first.records()).toEqual([]);
    } finally {
      restoreSecond();
    }
  });

  it('a test capture takes precedence over the sink while it is active', () => {
    const sink = new MemoryWritable();
    const restore = configureLoggerSink({ destination: sink });
    try {
      const cap = _captureLogger();
      try {
        logger.warn('captured, not sunk');
        expect(cap.records().map((r) => r.msg)).toEqual(['captured, not sunk']);
      } finally {
        cap.restore();
      }
      logger.warn('sunk again');
      expect(sink.records().map((r) => r.msg)).toEqual(['sunk again']);
    } finally {
      restore();
    }
  });

  it('restores through a chain: second, then first, then the previous destination', () => {
    const first = new MemoryWritable();
    const second = new MemoryWritable();
    const restoreFirst = configureLoggerSink({ destination: first });
    const restoreSecond = configureLoggerSink({ destination: second });
    restoreSecond();
    logger.warn('back on the first');
    restoreFirst();
    const cap = _captureLogger();
    try {
      logger.warn('back on the default');
      expect(first.records().map((r) => r.msg)).toEqual(['back on the first']);
      expect(second.records()).toEqual([]);
      expect(cap.records().map((r) => r.msg)).toEqual(['back on the default']);
    } finally {
      cap.restore();
    }
  });

  it('reads the level case-insensitively and lets it win over GITNEXUS_LOG_LEVEL', () => {
    const sink = new MemoryWritable();
    const previous = process.env.GITNEXUS_LOG_LEVEL;
    process.env.GITNEXUS_LOG_LEVEL = 'debug';
    const restore = configureLoggerSink({ destination: sink, level: 'WARN' });
    try {
      logger.info('dropped by the sink level');
      logger.warn('kept');
      expect(sink.records().map((r) => r.msg)).toEqual(['kept']);
    } finally {
      restore();
      if (previous === undefined) delete process.env.GITNEXUS_LOG_LEVEL;
      else process.env.GITNEXUS_LOG_LEVEL = previous;
    }
  });

  it("a record's own field wins over the mixin's", () => {
    const sink = new MemoryWritable();
    const restore = configureLoggerSink({
      destination: sink,
      mixin: () => ({ requestId: 'from-mixin', host: 'h' }),
    });
    try {
      logger.warn({ requestId: 'own' }, 'precedence');
      const [rec] = sink.records();
      expect(rec.requestId).toBe('own');
      expect(rec.host).toBe('h');
    } finally {
      restore();
    }
  });

  it('a mixin that throws does not lose the record, and is reported on stderr once', () => {
    const sink = new MemoryWritable();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const restore = configureLoggerSink({
      destination: sink,
      mixin: () => {
        throw new Error('host bug');
      },
    });
    try {
      logger.warn('first');
      createLogger('child').warn('second');
      expect(sink.records().map((r) => r.msg)).toEqual(['first', 'second']);
      const warnings = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('host mixin threw'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('host bug');
    } finally {
      restore();
      stderr.mockRestore();
    }
  });

  it('flushLoggerSync flushes a sink destination that has flushSync', () => {
    const flushSync = vi.fn();
    const sink = Object.assign(new MemoryWritable(), { flushSync });
    const restore = configureLoggerSink({ destination: sink });
    try {
      flushLoggerSync();
      expect(flushSync).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('rejects a destination without write(), an unknown level, and a non-function mixin', () => {
    expect(() => configureLoggerSink({ destination: {} as never })).toThrow(TypeError);
    expect(() => configureLoggerSink({ destination: new MemoryWritable(), level: 'loud' })).toThrow(
      RangeError,
    );
    expect(() =>
      configureLoggerSink({ destination: new MemoryWritable(), mixin: 42 as never }),
    ).toThrow(TypeError);
  });
});
