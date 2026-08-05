import { beforeEach, describe, expect, it, vi } from 'vitest';

const emit = vi.hoisted(() => vi.fn());

vi.mock('../../../src/core/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
  // The diagnostic is opt-in via `createLogger(name, { debugEnvVar })` and emits
  // at `debug`, so the assertions drive that child logger, not the singleton.
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: emit,
    trace: vi.fn(),
    fatal: vi.fn(),
  }),
}));

import { logUnresolvedReceiverFiles } from '../../../src/core/ingestion/scope-resolution/unresolved-receivers.js';
import type { ResolutionOutcome } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';

/**
 * #2837 / #2843 review. This diagnostic exists so a reporter can see WHICH file
 * lost its receivers. It must therefore count the same drops
 * `summarizeUnresolvedReceivers` counts — the first version omitted both of that
 * function's guards and its top-offender list was led by files that lost
 * nothing (measured on this repo: the top three were all test files).
 */
describe('logUnresolvedReceiverFiles (#2843 review)', () => {
  beforeEach(() => emit.mockClear());

  const drop = (filePath: string, over: Partial<ResolutionOutcome> = {}): ResolutionOutcome =>
    ({
      kind: 'suppressed',
      phase: 'receiver-bound-calls',
      reason: 'receiver-unresolved',
      filePath,
      name: 'DoWork',
      range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
      candidateIds: [],
      ...over,
    }) as ResolutionOutcome;

  const payload = (): {
    totalSites: number;
    filesAffected: number;
    topFiles: { filePath: string; sites: number }[];
  } => emit.mock.calls[0]![0] as never;

  it('says nothing when there are no receiver-unresolved drops', () => {
    logUnresolvedReceiverFiles([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('counts in-program call drops per file', () => {
    logUnresolvedReceiverFiles([drop('a.go'), drop('a.go'), drop('b.go')]);
    expect(payload().topFiles).toEqual([
      { filePath: 'a.go', sites: 2 },
      { filePath: 'b.go', sites: 1 },
    ]);
    expect(payload().totalSites).toBe(3);
  });

  // Guard 1, mirroring unresolved-receivers.ts: property reads/writes are not
  // call sites. Measured there at 25 of 124 drops on the fixture corpus.
  it('excludes non-call sites', () => {
    logUnresolvedReceiverFiles([
      drop('a.go'),
      drop('a.go', { siteKind: 'read' }),
      drop('a.go', { siteKind: 'write' }),
    ]);
    expect(payload().topFiles).toEqual([{ filePath: 'a.go', sites: 1 }]);
  });

  // Guard 2: an external-rooted receiver (`fmt.Println`) reaches code this index
  // does not contain, so no edge was ever possible and nothing was lost.
  it('excludes external-rooted drops', () => {
    logUnresolvedReceiverFiles([drop('a.go'), drop('a.go', { receiverOrigin: 'external' })]);
    expect(payload().topFiles).toEqual([{ filePath: 'a.go', sites: 1 }]);
  });

  // `unknown` origin counts WITH in-program: assuming a completeness we cannot
  // demonstrate is the unsafe direction.
  it('counts unknown-origin drops', () => {
    logUnresolvedReceiverFiles([drop('a.go', { receiverOrigin: 'unknown' })]);
    expect(payload().topFiles).toEqual([{ filePath: 'a.go', sites: 1 }]);
  });

  it('ranks by count then by code units, and caps the sample at ten files', () => {
    const outcomes = [
      ...Array.from({ length: 12 }, (_, i) => drop(`f${String(i).padStart(2, '0')}.go`)),
      drop('zz.go'),
      drop('zz.go'),
    ];
    logUnresolvedReceiverFiles(outcomes);
    expect(payload().topFiles).toHaveLength(10);
    expect(payload().topFiles[0]).toEqual({ filePath: 'zz.go', sites: 2 });
    // Ties break by code-unit order, so the survivors of the cap are stable.
    expect(
      payload()
        .topFiles.slice(1)
        .map((f) => f.filePath),
    ).toEqual([
      'f00.go',
      'f01.go',
      'f02.go',
      'f03.go',
      'f04.go',
      'f05.go',
      'f06.go',
      'f07.go',
      'f08.go',
    ]);
    // The total is the true count, not the capped sample.
    expect(payload().totalSites).toBe(14);
    expect(payload().filesAffected).toBe(13);
  });
});
