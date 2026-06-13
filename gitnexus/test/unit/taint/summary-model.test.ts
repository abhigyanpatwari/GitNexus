/**
 * U2 (#2084 M4) — the per-function taint summary model + version codec.
 *
 * `summaryVersion` is the incremental-invalidation primitive: it must be
 * stable for identical facts, change when own facts change, change when any
 * callee version changes, and be order-independent over callee versions.
 * `ownFactsDigest` must be order-independent within each edge category. The
 * model itself must be JSON-plain (structural-clone safe).
 */

import { describe, it, expect } from 'vitest';
import {
  ownFactsDigest,
  summaryVersion,
  type FunctionSummary,
} from '../../../src/core/ingestion/taint/summary-model.js';

type Facts = Parameters<typeof ownFactsDigest>[0];

const baseFacts: Facts = {
  paramCount: 2,
  paramToReturn: [{ param: 0 }],
  paramToCallArg: [{ param: 1, callLine: 10, argIndex: 0, calleeName: 'helper' }],
  paramToSink: [{ param: 0, sinkKind: 'sql-injection' }],
  sourceToReturn: [{ sourceKind: 'remote-input' }],
  sourceToCallArg: [{ sourceKind: 'remote-input', callLine: 7, argIndex: 0, calleeName: 'sink' }],
  callResults: [{ calleeName: 'getInput', dest: { to: 'sink', sinkKind: 'command-injection' } }],
};

describe('ownFactsDigest', () => {
  it('is stable for identical facts', () => {
    expect(ownFactsDigest(baseFacts)).toBe(ownFactsDigest({ ...baseFacts }));
  });

  it('is order-independent within edge categories', () => {
    const reordered: Facts = {
      ...baseFacts,
      paramToReturn: [{ param: 0 }],
      paramToSink: [{ param: 0, sinkKind: 'sql-injection' }],
    };
    const twoSinks: Facts = {
      ...baseFacts,
      paramToSink: [
        { param: 1, sinkKind: 'xss' },
        { param: 0, sinkKind: 'sql-injection' },
      ],
    };
    const twoSinksSwapped: Facts = {
      ...baseFacts,
      paramToSink: [
        { param: 0, sinkKind: 'sql-injection' },
        { param: 1, sinkKind: 'xss' },
      ],
    };
    expect(ownFactsDigest(reordered)).toBe(ownFactsDigest(baseFacts));
    expect(ownFactsDigest(twoSinks)).toBe(ownFactsDigest(twoSinksSwapped));
  });

  it('changes when own facts change', () => {
    const changed: Facts = { ...baseFacts, paramCount: 3 };
    expect(ownFactsDigest(changed)).not.toBe(ownFactsDigest(baseFacts));

    const extraSink: Facts = {
      ...baseFacts,
      paramToSink: [...baseFacts.paramToSink, { param: 1, sinkKind: 'command-injection' }],
    };
    expect(ownFactsDigest(extraSink)).not.toBe(ownFactsDigest(baseFacts));
  });

  it('distinguishes neutralized kinds on a return edge', () => {
    const a: Facts = { ...baseFacts, paramToReturn: [{ param: 0, neutralized: ['xss'] }] };
    const b: Facts = { ...baseFacts, paramToReturn: [{ param: 0 }] };
    expect(ownFactsDigest(a)).not.toBe(ownFactsDigest(b));
  });
});

describe('summaryVersion', () => {
  it('is stable for identical own digest + callee versions', () => {
    const d = ownFactsDigest(baseFacts);
    expect(summaryVersion(d, ['aaa', 'bbb'])).toBe(summaryVersion(d, ['aaa', 'bbb']));
  });

  it('is order-independent over callee versions', () => {
    const d = ownFactsDigest(baseFacts);
    expect(summaryVersion(d, ['aaa', 'bbb'])).toBe(summaryVersion(d, ['bbb', 'aaa']));
  });

  it('changes when the own digest changes', () => {
    const d1 = ownFactsDigest(baseFacts);
    const d2 = ownFactsDigest({ ...baseFacts, paramCount: 9 });
    expect(summaryVersion(d1, ['x'])).not.toBe(summaryVersion(d2, ['x']));
  });

  it('changes when any callee version changes', () => {
    const d = ownFactsDigest(baseFacts);
    expect(summaryVersion(d, ['aaa', 'bbb'])).not.toBe(summaryVersion(d, ['aaa', 'ccc']));
  });

  it('distinguishes no-callees from one-callee', () => {
    const d = ownFactsDigest(baseFacts);
    expect(summaryVersion(d, [])).not.toBe(summaryVersion(d, ['aaa']));
  });
});

describe('FunctionSummary plain-data', () => {
  it('survives structuredClone (no functions/Maps/Symbols)', () => {
    const s: FunctionSummary = {
      fnId: 'Function:src/a.ts:f',
      filePath: 'src/a.ts',
      startLine: 1,
      paramCount: 1,
      paramToReturn: [{ param: 0 }],
      paramToCallArg: [],
      paramToSink: [],
      sourceToReturn: [],
      sourceToCallArg: [],
      callResults: [],
      version: 'deadbeef',
    };
    expect(structuredClone(s)).toEqual(s);
  });
});
