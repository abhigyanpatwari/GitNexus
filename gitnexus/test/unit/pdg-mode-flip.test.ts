import { describe, it, expect } from 'vitest';
import { taintModelVersion } from '../../src/core/ingestion/taint/typescript-model.js';

describe('pdgModeMismatch — M1→M2 stamp upgrade (#2082 M2, pure)', () => {
  it('an M1-era stamp (no REACHING_DEF cap) mismatches an M2 request — upgrade forces full writeback', async () => {
    const { pdgModeMismatch } = await import('../../src/core/run-analyze.js');
    const m1Stamp = { maxFunctionLines: 2000, maxEdgesPerFunction: 5000 };
    // default M2 request resolves maxReachingDefEdgesPerFunction=4000 ≠ undefined
    expect(pdgModeMismatch(m1Stamp, { pdg: true })).toBe(true);
  });

  it('an identical resolved M2 config compares equal (steady state keeps incremental)', async () => {
    const { pdgModeMismatch, resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    const stamp = resolvePdgConfig({ pdg: true });
    expect(pdgModeMismatch(stamp, { pdg: true })).toBe(false);
  });

  it('a REACHING_DEF cap change alone trips the mismatch', async () => {
    const { pdgModeMismatch, resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    const stamp = resolvePdgConfig({ pdg: true });
    expect(pdgModeMismatch(stamp, { pdg: true, pdgMaxReachingDefEdgesPerFunction: 100 })).toBe(
      true,
    );
    expect(pdgModeMismatch(stamp, { pdg: true, pdgMaxReachingDefEdgesPerFunction: 4000 })).toBe(
      false, // explicit default ≡ default (resolution before comparison)
    );
  });
});

describe('pdgModeMismatch — M2→M3 stamp upgrade (#2083 M3 U5, pure)', () => {
  it('an M2-era stamp (no taint keys) mismatches an M3 request — upgrade forces full writeback', async () => {
    const { pdgModeMismatch } = await import('../../src/core/run-analyze.js');
    // Exactly what an M2 run wrote: the three pre-taint resolved caps, no
    // maxTaintFindingsPerFunction / maxTaintHops / taintModelVersion. The
    // key-union comparator sees e.g. 200 !== undefined and trips the full
    // writeback that populates TAINTED/SANITIZES rows without --force (R7).
    const m2Stamp = {
      maxFunctionLines: 2000,
      maxEdgesPerFunction: 5000,
      maxReachingDefEdgesPerFunction: 4000,
    };
    expect(pdgModeMismatch(m2Stamp, { pdg: true })).toBe(true);
  });

  it('an identical resolved M3 config compares equal (steady state keeps incremental)', async () => {
    const { pdgModeMismatch, resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    const stamp = resolvePdgConfig({ pdg: true });
    expect(pdgModeMismatch(stamp, { pdg: true })).toBe(false);
  });

  it('a taint cap change alone trips the mismatch', async () => {
    const { pdgModeMismatch, resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    const stamp = resolvePdgConfig({ pdg: true });
    expect(pdgModeMismatch(stamp, { pdg: true, pdgMaxTaintFindingsPerFunction: 10 })).toBe(true);
    expect(pdgModeMismatch(stamp, { pdg: true, pdgMaxTaintHops: 4 })).toBe(true);
    expect(pdgModeMismatch(stamp, { pdg: true, pdgMaxTaintFindingsPerFunction: 200 })).toBe(
      false, // explicit default ≡ default (resolution before comparison)
    );
  });

  it('a model-version change ALONE trips the mismatch (the R7 repopulation guarantee)', async () => {
    const { pdgModeMismatch, resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    // A stamp written by a hypothetical older binary whose built-in model
    // differed — every cap identical, only the digest moved. Persisted
    // findings must never outlive the model that produced them.
    const stamp = resolvePdgConfig({ pdg: true });
    const oldModelStamp = { ...stamp, taintModelVersion: '000000000000' };
    expect(stamp?.taintModelVersion).not.toBe('000000000000'); // guard the premise
    expect(pdgModeMismatch(oldModelStamp, { pdg: true })).toBe(true);
  });
});

describe('pdgModeMismatch — M3→M4 interproc-cap stamp upgrade (#2084 review P1-3, pure)', () => {
  it('resolvePdgConfig stamps the three resolved interproc caps', async () => {
    const { resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    const stamp = resolvePdgConfig({ pdg: true });
    expect(stamp?.maxInterprocFindings).toBe(2000);
    expect(stamp?.maxInterprocHops).toBe(32);
    expect(stamp?.maxInterprocEdges).toBe(1000);
  });

  it('an M3-era stamp (no interproc keys) mismatches a post-fix request — upgrade forces full writeback', async () => {
    const { pdgModeMismatch } = await import('../../src/core/run-analyze.js');
    // What an M3 run wrote: every taint cap + model digest, but none of the
    // interproc caps. The key-union comparator sees 2000 !== undefined and
    // trips the full writeback that re-materialises TAINT_PATH within bounds.
    const m3Stamp = {
      maxFunctionLines: 2000,
      maxEdgesPerFunction: 5000,
      maxReachingDefEdgesPerFunction: 4000,
      maxTaintFindingsPerFunction: 200,
      maxTaintHops: 32,
      taintModelVersion: 'deadbeefcafe',
    };
    expect(pdgModeMismatch(m3Stamp, { pdg: true })).toBe(true);
  });

  it('an interproc cap change alone trips the mismatch', async () => {
    const { pdgModeMismatch, resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    const stamp = resolvePdgConfig({ pdg: true });
    expect(pdgModeMismatch(stamp, { pdg: true, pdgMaxInterprocFindings: 10 })).toBe(true);
    expect(pdgModeMismatch(stamp, { pdg: true, pdgMaxInterprocEdges: 50 })).toBe(true);
    expect(pdgModeMismatch(stamp, { pdg: true, pdgMaxInterprocHops: 8 })).toBe(true);
    // explicit default ≡ default (resolution before comparison)
    expect(pdgModeMismatch(stamp, { pdg: true, pdgMaxInterprocFindings: 2000 })).toBe(false);
  });
});

describe('pdgModeMismatch — pre-M5→M5 CDG-cap stamp upgrade (#2085 M5, pure)', () => {
  it('resolvePdgConfig stamps the resolved CDG cap', async () => {
    const { resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    const stamp = resolvePdgConfig({ pdg: true });
    expect(stamp?.maxCdgEdgesPerFunction).toBe(5000);
  });

  it('a pre-M5 stamp (no CDG key) mismatches a CDG-aware request — upgrade forces full writeback', async () => {
    const { pdgModeMismatch } = await import('../../src/core/run-analyze.js');
    // What an M4-era run wrote: every cap through the interproc set + model
    // digest, but NO maxCdgEdgesPerFunction. The key-union comparator sees
    // 5000 !== undefined and trips the full writeback that materialises CDG
    // edges for every file without --force.
    const m4Stamp = {
      maxFunctionLines: 2000,
      maxEdgesPerFunction: 5000,
      maxReachingDefEdgesPerFunction: 4000,
      maxTaintFindingsPerFunction: 200,
      maxTaintHops: 32,
      maxInterprocFindings: 2000,
      maxInterprocHops: 32,
      maxInterprocEdges: 1000,
      taintModelVersion,
    };
    expect(pdgModeMismatch(m4Stamp, { pdg: true })).toBe(true);
  });

  it('a CDG cap change alone trips the mismatch', async () => {
    const { pdgModeMismatch, resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    const stamp = resolvePdgConfig({ pdg: true });
    expect(pdgModeMismatch(stamp, { pdg: true, pdgMaxCdgEdgesPerFunction: 10 })).toBe(true);
    // explicit default ≡ default (resolution before comparison)
    expect(pdgModeMismatch(stamp, { pdg: true, pdgMaxCdgEdgesPerFunction: 5000 })).toBe(false);
  });
});

describe('pdgModeMismatch — pre-#2201→SSA reaching-defs solver upgrade (#2201 review R3, pure)', () => {
  it('resolvePdgConfig stamps the reaching-defs solver identity', async () => {
    const { resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    const stamp = resolvePdgConfig({ pdg: true });
    expect(stamp?.reachingDefSolver).toBe('ssa-sparse-v1');
  });

  it('a pre-#2201 stamp (no solver key) mismatches the SSA request — upgrade recomputes truncated deep-loop facts', async () => {
    const { pdgModeMismatch } = await import('../../src/core/run-analyze.js');
    // What a pre-#2201 (M5-era) run wrote: every cap + model digest, but NO
    // reachingDefSolver. The key-union comparator sees 'ssa-sparse-v1' !==
    // undefined and trips the full writeback that recomputes the now-fuller
    // REACHING_DEF coverage — the deep-loop functions the dense worklist
    // truncated to empty at the blocks×64 ceiling now compute full facts.
    const m5Stamp = {
      maxFunctionLines: 2000,
      maxEdgesPerFunction: 5000,
      maxReachingDefEdgesPerFunction: 4000,
      maxCdgEdgesPerFunction: 5000,
      maxTaintFindingsPerFunction: 200,
      maxTaintHops: 32,
      maxInterprocFindings: 2000,
      maxInterprocHops: 32,
      maxInterprocEdges: 1000,
      taintModelVersion,
    };
    expect(pdgModeMismatch(m5Stamp, { pdg: true })).toBe(true);
  });

  it('an identical post-#2201 stamp compares equal (no spurious re-analysis churn)', async () => {
    const { pdgModeMismatch, resolvePdgConfig } = await import('../../src/core/run-analyze.js');
    const stamp = resolvePdgConfig({ pdg: true });
    expect(pdgModeMismatch(stamp, { pdg: true })).toBe(false);
  });
});
