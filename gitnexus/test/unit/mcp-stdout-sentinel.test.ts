import { describe, it, expect, beforeEach } from 'vitest';
import { withMcpWrite, isMcpWrite, createStdoutSentinel } from '../../src/mcp/stdio-context.js';

interface CapturedWrite {
  target: 'stdout' | 'stderr';
  payload: string;
}

function makeCapture() {
  const captured: CapturedWrite[] = [];
  const realStdoutWrite = (chunk: any) => {
    captured.push({
      target: 'stdout',
      payload: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
    });
    return true;
  };
  const realStderrWrite = (chunk: any) => {
    captured.push({
      target: 'stderr',
      payload: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
    });
    return true;
  };
  return { captured, realStdoutWrite, realStderrWrite };
}

function joinedStderr(captured: CapturedWrite[]): string {
  return captured
    .filter((c) => c.target === 'stderr')
    .map((c) => c.payload)
    .join('');
}

function joinedStdout(captured: CapturedWrite[]): string {
  return captured
    .filter((c) => c.target === 'stdout')
    .map((c) => c.payload)
    .join('');
}

describe('mcp/stdio-context — withMcpWrite / isMcpWrite', () => {
  it('isMcpWrite returns false outside withMcpWrite', () => {
    expect(isMcpWrite()).toBe(false);
  });

  it('isMcpWrite returns true inside withMcpWrite', () => {
    let inside: boolean | undefined;
    withMcpWrite(() => {
      inside = isMcpWrite();
    });
    expect(inside).toBe(true);
  });

  it('isMcpWrite returns false again after withMcpWrite returns', () => {
    withMcpWrite(() => {
      // noop
    });
    expect(isMcpWrite()).toBe(false);
  });

  it('withMcpWrite returns the inner value', () => {
    const v = withMcpWrite(() => 42);
    expect(v).toBe(42);
  });

  it('nested withMcpWrite stays tagged', () => {
    let deep: boolean | undefined;
    withMcpWrite(() => {
      withMcpWrite(() => {
        deep = isMcpWrite();
      });
    });
    expect(deep).toBe(true);
  });
});

describe('mcp/stdio-context — createStdoutSentinel', () => {
  let capture: ReturnType<typeof makeCapture>;

  beforeEach(() => {
    capture = makeCapture();
  });

  it('passes writes through to real stdout when called inside withMcpWrite', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    withMcpWrite(() => {
      sentinel.write('Content-Length: 42\r\n\r\n{"jsonrpc":"2.0"}');
    });
    expect(joinedStdout(capture.captured)).toBe('Content-Length: 42\r\n\r\n{"jsonrpc":"2.0"}');
    expect(joinedStderr(capture.captured)).toBe('');
  });

  it('passes newline-terminated JSON-RPC frames through to stdout when tagged', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    withMcpWrite(() => {
      sentinel.write('{"jsonrpc":"2.0","id":1}\n');
    });
    expect(joinedStdout(capture.captured)).toBe('{"jsonrpc":"2.0","id":1}\n');
  });

  it('passes Buffer payloads through to stdout when tagged', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    withMcpWrite(() => {
      sentinel.write(Buffer.from('payload', 'utf8'));
    });
    expect(joinedStdout(capture.captured)).toBe('payload');
  });

  it('redirects untagged writes to stderr with the [mcp:stdout-redirect] prefix', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    sentinel.write('rogue output\n');

    const stderr = joinedStderr(capture.captured);
    expect(stderr).toContain('[mcp:stdout-redirect]');
    expect(stderr).toContain('rogue output');
    expect(joinedStdout(capture.captured)).toBe('');
  });

  it('emits a one-shot startup warning on the first redirect only', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    sentinel.write('first\n');
    sentinel.write('second\n');

    const stderr = joinedStderr(capture.captured);
    const warningMatches = stderr.match(/sentinel triggered/g) ?? [];
    expect(warningMatches.length).toBe(1);
  });

  it('truncates redirect payload to maxBytes (default 200) and reports the overflow', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    const huge = 'x'.repeat(1024);
    sentinel.write(huge);

    const stderr = joinedStderr(capture.captured);
    // The redirected payload portion should not contain all 1024 x's.
    expect(stderr.includes('x'.repeat(1024))).toBe(false);
    expect(stderr).toContain('x'.repeat(200));
    expect(stderr).toMatch(/\(\+\d+ bytes truncated\)/);
  });

  it('respects a custom maxBytes', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
      maxBytes: 8,
    });
    sentinel.write('abcdefghijklmnop');

    const stderr = joinedStderr(capture.captured);
    expect(stderr).toContain('abcdefgh');
    expect(stderr.includes('abcdefghi')).toBe(false);
    expect(stderr).toContain('truncated');
  });

  it('rate-limits redirects to maxRedirects (default 10) — extras are suppressed', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    for (let i = 0; i < 15; i += 1) {
      sentinel.write(`line-${i}\n`);
    }

    const stderr = joinedStderr(capture.captured);
    // First 10 lines are surfaced; lines 10-14 are suppressed.
    for (let i = 0; i < 10; i += 1) {
      expect(stderr).toContain(`line-${i}`);
    }
    for (let i = 10; i < 15; i += 1) {
      expect(stderr.includes(`line-${i}`)).toBe(false);
    }
    expect(sentinel.stats().redirected).toBe(10);
    expect(sentinel.stats().suppressed).toBe(5);
  });

  it('flushSummary emits the counter line when redirects occurred', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    sentinel.write('one\n');
    sentinel.write('two\n');
    sentinel.flushSummary();

    const stderr = joinedStderr(capture.captured);
    expect(stderr).toMatch(/summary:\s*2 redirected,\s*0 suppressed/);
  });

  it('flushSummary is silent when no redirects occurred', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    sentinel.flushSummary();

    expect(joinedStderr(capture.captured)).toBe('');
  });

  it('returns true for empty writes and never throws', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    expect(() => sentinel.write('')).not.toThrow();
    expect(() => sentinel.write(undefined as any)).not.toThrow();
    expect(sentinel.write('')).toBe(true);
  });

  it('handles plain Uint8Array (not Buffer) correctly when redirecting', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    // Plain Uint8Array — Buffer.isBuffer returns false. Bytes spell "hi\n".
    const u8 = new Uint8Array([0x68, 0x69, 0x0a]);
    sentinel.write(u8);

    const stderr = joinedStderr(capture.captured);
    expect(stderr).toContain('hi');
    expect(stderr).not.toMatch(/\b104,\s*105/); // not falling through to String(chunk) → "104,105,10"
  });

  it('invokes the Writable callback (if provided) for redirected writes', async () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });
    let called = false;
    let cbErr: Error | null | undefined = undefined;
    sentinel.write('rogue\n', 'utf8', (err: Error | null | undefined) => {
      called = true;
      cbErr = err;
    });
    // Callback fires on next tick, not sync.
    expect(called).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(called).toBe(true);
    expect(cbErr).toBeNull();
  });

  it('invokes the Writable callback for redirected writes when called past the rate-limit cap', async () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
      maxRedirects: 1,
    });
    sentinel.write('first\n');
    let called = false;
    sentinel.write('second\n', () => {
      called = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(called).toBe(true);
  });

  it('handles a multi-call sequence where some writes are tagged and some are not', () => {
    const sentinel = createStdoutSentinel({
      realStdoutWrite: capture.realStdoutWrite,
      realStderrWrite: capture.realStderrWrite,
    });

    withMcpWrite(() => sentinel.write('{"frame1":1}\n'));
    sentinel.write('rogue-1\n');
    withMcpWrite(() => sentinel.write('{"frame2":2}\n'));
    sentinel.write('rogue-2\n');

    expect(joinedStdout(capture.captured)).toBe('{"frame1":1}\n{"frame2":2}\n');
    const stderr = joinedStderr(capture.captured);
    expect(stderr).toContain('rogue-1');
    expect(stderr).toContain('rogue-2');
  });
});
