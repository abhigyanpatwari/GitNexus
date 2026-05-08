/**
 * Unit tests for `gitnexus/src/cli/cli-message.ts`.
 *
 * cli-message is the helper for user-facing CLI banners and error guidance.
 * The contract: each call writes plain text to stderr AND emits a
 * structured pino record through the singleton logger.
 *
 * Tests verify both halves of the tee, plus shape contracts (newline
 * handling, structured fields, tee survival across messages with
 * embedded newlines).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cliInfo, cliWarn, cliError } from '../../src/cli/cli-message.js';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';

describe('cli-message — stderr + logger tee', () => {
  let cap: LoggerCapture;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cap = _captureLogger();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    cap.restore();
  });

  it('cliInfo writes plain text to stderr and emits a structured info record', () => {
    cliInfo('hello');
    // Plain stderr write
    const stderrCalls = stderrSpy.mock.calls.map(([chunk]) =>
      typeof chunk === 'string' ? chunk : chunk.toString(),
    );
    expect(stderrCalls).toContain('hello\n');
    // Structured logger record
    const records = cap.records();
    expect(records.some((r) => r.msg === 'hello' && r.level === 30)).toBe(true);
  });

  it('cliWarn writes to stderr and emits at warn level (40)', () => {
    cliWarn('caution');
    const stderrCalls = stderrSpy.mock.calls.map(([chunk]) =>
      typeof chunk === 'string' ? chunk : chunk.toString(),
    );
    expect(stderrCalls).toContain('caution\n');
    const records = cap.records();
    expect(records.some((r) => r.msg === 'caution' && r.level === 40)).toBe(true);
  });

  it('cliError writes to stderr and emits at error level (50) with structured fields', () => {
    cliError('boom', { code: 'EADDRINUSE', port: 4747 });
    const stderrCalls = stderrSpy.mock.calls.map(([chunk]) =>
      typeof chunk === 'string' ? chunk : chunk.toString(),
    );
    expect(stderrCalls).toContain('boom\n');
    const records = cap.records();
    const errorRecord = records.find((r) => r.msg === 'boom' && r.level === 50);
    expect(errorRecord).toBeDefined();
    expect(errorRecord?.code).toBe('EADDRINUSE');
    expect(errorRecord?.port).toBe(4747);
  });

  it('does not double-newline an already-newlined message', () => {
    cliInfo('already-terminated\n');
    const stderrCalls = stderrSpy.mock.calls.map(([chunk]) =>
      typeof chunk === 'string' ? chunk : chunk.toString(),
    );
    // Exactly one trailing \n, not two.
    expect(stderrCalls).toContain('already-terminated\n');
    expect(stderrCalls.includes('already-terminated\n\n')).toBe(false);
  });

  it('preserves embedded newlines in multi-line messages (does not split into multiple records)', () => {
    cliError('line one\nline two\nline three');
    const stderrCalls = stderrSpy.mock.calls.map(([chunk]) =>
      typeof chunk === 'string' ? chunk : chunk.toString(),
    );
    // The whole multi-line block goes to stderr in one write, with a
    // trailing newline appended.
    expect(stderrCalls).toContain('line one\nline two\nline three\n');
    // The structured record carries the full message as a single field.
    const records = cap.records();
    expect(records.some((r) => r.msg === 'line one\nline two\nline three' && r.level === 50)).toBe(
      true,
    );
  });

  it('handles an empty message — stderr gets a bare newline, logger gets msg:""', () => {
    cliInfo('');
    const stderrCalls = stderrSpy.mock.calls.map(([chunk]) =>
      typeof chunk === 'string' ? chunk : chunk.toString(),
    );
    expect(stderrCalls).toContain('\n');
    const records = cap.records();
    expect(records.some((r) => r.msg === '' && r.level === 30)).toBe(true);
  });
});
