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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createLogger,
  logger,
  MemoryWritable,
  _captureLogger,
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
