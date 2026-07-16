/**
 * #2432 — the C++ capture-emit loop must bound its own wall time.
 *
 * A worker thread stuck in capture extraction cannot be terminated safely
 * (terminating a thread mid-N-API call aborts the process with Napi::Error),
 * so `emitCppScopeCaptures` checks a per-file deadline and RETURNS partial
 * captures with a warning on breach — it must never throw (a throw would
 * make parse-worker's language-group catch drop every remaining file).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { emitCppScopeCaptures } from '../../src/core/ingestion/languages/cpp/captures.js';
import { _captureLogger } from '../../src/core/logger.js';

const MANY_CALLS = [
  'enum class Color { Red, Green };',
  ...Array.from({ length: 200 }, (_, k) => {
    return `void fn${k}(int p${k}) {\n  Color c${k} = Color::Red;\n  sink(c${k}, p${k});\n}`;
  }),
].join('\n');

const prevBudget = process.env.GITNEXUS_CPP_CAPTURE_BUDGET_MS;

afterEach(() => {
  if (prevBudget === undefined) delete process.env.GITNEXUS_CPP_CAPTURE_BUDGET_MS;
  else process.env.GITNEXUS_CPP_CAPTURE_BUDGET_MS = prevBudget;
});

describe('C++ capture extraction budget (#2432)', () => {
  it('returns partial captures with a warning on budget breach, never throws', () => {
    const full = emitCppScopeCaptures(MANY_CALLS, 'budget-full.cpp');
    expect(full.length).toBeGreaterThan(200);

    process.env.GITNEXUS_CPP_CAPTURE_BUDGET_MS = '0'; // expires immediately
    const cap = _captureLogger();
    try {
      const partial = emitCppScopeCaptures(MANY_CALLS, 'budget-breach.cpp');
      expect(partial.length).toBeLessThan(full.length);

      const warning = cap
        .records()
        .find((r: { msg?: string }) => (r.msg ?? '').includes('exceeded its 0ms budget'));
      expect(warning).toMatchObject({ filePath: 'budget-breach.cpp', budgetMs: 0 });
    } finally {
      cap.restore();
    }
  });

  it('invalid budget values fall back to the default and do not fire on normal files', () => {
    process.env.GITNEXUS_CPP_CAPTURE_BUDGET_MS = 'not-a-number';
    const cap = _captureLogger();
    try {
      const captures = emitCppScopeCaptures(MANY_CALLS, 'budget-default.cpp');
      expect(captures.length).toBeGreaterThan(200);
      const warning = cap
        .records()
        .find((r: { msg?: string }) => (r.msg ?? '').includes('capture extraction exceeded'));
      expect(warning).toBeUndefined();
    } finally {
      cap.restore();
    }
  });
});
