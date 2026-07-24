import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  projectParseHeapNeedBytes,
  shouldAbortForHeapPressure,
} from '../../src/core/ingestion/pipeline-phases/parse-impl.js';

const GB = 1024 * 1024 * 1024;

describe('#2649 parse-phase heap guardrails', () => {
  let initialGuard: string | undefined;

  beforeEach(() => {
    initialGuard = process.env.GITNEXUS_HEAP_GUARD;
    delete process.env.GITNEXUS_HEAP_GUARD;
  });

  afterEach(() => {
    if (initialGuard === undefined) delete process.env.GITNEXUS_HEAP_GUARD;
    else process.env.GITNEXUS_HEAP_GUARD = initialGuard;
  });

  it('projects kernel-scale repos far past the 4GB default heap and small repos well under it', () => {
    // 94,773 files x 55 nodes x 2250 bytes ≈ 11.7GB (the measured #2649 case);
    // 2,000 files ≈ 236MB.
    expect({
      kernelExceeds4Gb: projectParseHeapNeedBytes(94773) > 4 * GB,
      smallRepoUnder1Gb: projectParseHeapNeedBytes(2000) < 1 * GB,
    }).toEqual({ kernelExceeds4Gb: true, smallRepoUnder1Gb: true });
  });

  it('aborts above 92% of the heap limit and not below it', () => {
    const limit = 4 * GB;
    expect(
      [0.91, 0.93].map((f) => shouldAbortForHeapPressure(limit * f, limit)),
    ).toEqual([false, true]);
  });

  it('GITNEXUS_HEAP_GUARD=0 disables the abort entirely', () => {
    process.env.GITNEXUS_HEAP_GUARD = '0';
    const limit = 4 * GB;
    expect(shouldAbortForHeapPressure(limit * 0.99, limit)).toBe(false);
  });
});
