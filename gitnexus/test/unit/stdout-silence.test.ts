import { describe, it, expect, afterEach } from 'vitest';
import {
  silenceStdout,
  restoreStdout,
  realStdoutWrite,
  realStderrWrite,
} from '../../src/core/lbug/pool-adapter.js';

afterEach(() => {
  // Safety: always restore in case a test fails mid-silence
  process.stdout.write = realStdoutWrite;
});

describe('stdout silencing', () => {
  it('exports realStdoutWrite and realStderrWrite as bound functions', () => {
    expect(typeof realStdoutWrite).toBe('function');
    expect(typeof realStderrWrite).toBe('function');
  });

  it('silenceStdout replaces process.stdout.write with a no-op', () => {
    const before = process.stdout.write;
    silenceStdout();
    expect(process.stdout.write).not.toBe(before);
    // The no-op returns true
    expect((process.stdout.write as any)('test')).toBe(true);
    restoreStdout();
  });

  it('restoreStdout puts back the real write function', () => {
    silenceStdout();
    restoreStdout();
    expect(process.stdout.write).toBe(realStdoutWrite);
  });

  it('handles nested silence/restore (reference counting)', () => {
    silenceStdout(); // count = 1
    silenceStdout(); // count = 2

    // Still silenced after first restore
    restoreStdout(); // count = 1
    expect(process.stdout.write).not.toBe(realStdoutWrite);

    // Restored after second
    restoreStdout(); // count = 0
    expect(process.stdout.write).toBe(realStdoutWrite);
  });

  it('does not go negative on extra restores', () => {
    silenceStdout();
    restoreStdout();
    restoreStdout(); // extra — should not break
    restoreStdout(); // extra — should not break
    expect(process.stdout.write).toBe(realStdoutWrite);

    // Next silence/restore cycle still works
    silenceStdout();
    expect(process.stdout.write).not.toBe(realStdoutWrite);
    restoreStdout();
    expect(process.stdout.write).toBe(realStdoutWrite);
  });

  it('simulates embedder + pool-adapter concurrent usage without conflict', () => {
    // Pool-adapter silences for a query
    silenceStdout(); // count = 1

    // Embedder starts loading while pool-adapter has silenced
    silenceStdout(); // count = 2 (embedder uses centralized silence)

    // Pool-adapter query finishes
    restoreStdout(); // count = 1 — still silenced (embedder still loading)
    expect(process.stdout.write).not.toBe(realStdoutWrite);

    // Embedder finishes loading
    restoreStdout(); // count = 0 — fully restored
    expect(process.stdout.write).toBe(realStdoutWrite);
  });
});
