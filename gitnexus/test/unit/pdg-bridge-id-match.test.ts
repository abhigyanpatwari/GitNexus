/**
 * U5 — Bridge: id-match primary with leaf-name fallback.
 *
 * `pdgBridgeEvidenceForImpact` proves a callgraph-reached first-hop callee by its
 * RESOLVED SYMBOL ID against the slice's `calleeIds` (sound), falling back to the
 * leaf-name predicate ONLY when ids are absent/empty or the block is capped
 * (sentinel). These cases assert the id path eliminates the same-leaf-name
 * collision FP (R1) and the import-alias FN (R1), that an id-miss is a real proof
 * failure rather than a name fall-through (KTD3), and that the R3/R7 fallbacks are
 * preserved verbatim. No `if`-branching; unconditional `toMatchObject`/`toBe`.
 */
import { describe, it, expect } from 'vitest';
import { pdgBridgeEvidenceForImpact } from '../../src/mcp/local/pdg-impact.js';
import { CALLEES_TRUNCATED_SENTINEL } from '../../src/core/ingestion/cfg/emit.js';

describe('pdgBridgeEvidenceForImpact — U5 resolved-id match (KTD3)', () => {
  it('eliminates the same-leaf-name collision FP: only the on-slice id is proven (R1)', () => {
    // Two reached callees share the leaf name "get" but have distinct resolved ids
    // (idA on the slice, idB not). The NAME path with sliceCalleeNames={"get"}
    // would prove BOTH; the id path proves only idA.
    const sliceCalleeIds = new Set(['idA']);
    const onSlice = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeIds, sliceCalleeNames: new Set(['get']) },
      depth: 1,
      calleeName: 'get',
      calleeId: 'idA',
    });
    const offSlice = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeIds, sliceCalleeNames: new Set(['get']) },
      depth: 1,
      calleeName: 'get',
      calleeId: 'idB',
    });
    expect(onSlice).toMatchObject({ evidence: 'callgraph-bridge' });
    expect(offSlice).toMatchObject({ evidence: 'unproven-bridge' });
  });

  it('eliminates the import-alias FN: proven by id though the name would miss (R1)', () => {
    // The reached callee's leaf name "bar" (an alias/rename) is NOT in
    // sliceCalleeNames, but its resolved id idFoo IS in sliceCalleeIds — the id
    // path proves it where the name path would drop it.
    const result = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeIds: new Set(['idFoo']), sliceCalleeNames: new Set(['foo']) },
      depth: 1,
      calleeName: 'bar',
      calleeId: 'idFoo',
    });
    expect(result).toMatchObject({ evidence: 'callgraph-bridge' });
  });

  it('id-miss is unproven, NOT a name fall-through (KTD3 proof failure)', () => {
    // ids present + non-empty, sentinel absent: a reached id not in the set is a
    // proof failure even when its leaf name DOES match — the matching name must
    // not rescue it (that would re-leak the collision the id key eliminates).
    const result = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeIds: new Set(['idA']), sliceCalleeNames: new Set(['get']) },
      depth: 1,
      calleeName: 'get',
      calleeId: 'idZ',
    });
    expect(result).toMatchObject({ evidence: 'unproven-bridge' });
    expect(result.evidence).not.toBe('callgraph-bridge');
  });

  it('falls back to the name path when ids are absent (R3) — current behavior preserved', () => {
    const result = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeNames: new Set(['get']), sliceCalleeIds: new Set() },
      depth: 1,
      calleeName: 'get',
    });
    expect(result).toMatchObject({ evidence: 'callgraph-bridge' });
  });

  it('falls back to the name path when the id set is empty (not all-unproven)', () => {
    // An empty sliceCalleeIds means "no captured ids", which must route to the
    // name fallback — not collapse every reach to unproven.
    const result = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeIds: new Set<string>(), sliceCalleeNames: new Set(['get']) },
      depth: 1,
      calleeName: 'get',
      calleeId: 'idZ',
    });
    expect(result).toMatchObject({ evidence: 'callgraph-bridge' });
  });

  it('a capped block (sentinel) stays callgraph-equal regardless of ids (R7)', () => {
    // The truncation sentinel marks the callee set incomplete; the id path is
    // skipped (callee-unknown) so even an id-miss stays callgraph-bridge.
    const result = pdgBridgeEvidenceForImpact({
      bridge: {
        sliceCalleeIds: new Set(['idA']),
        sliceCalleeNames: new Set([CALLEES_TRUNCATED_SENTINEL, 'get']),
      },
      depth: 1,
      calleeName: 'get',
      calleeId: 'idZ',
    });
    expect(result).toMatchObject({ evidence: 'callgraph-bridge' });
  });

  it('multi-target dispatch: a reached id in a multi-id set is proven (R2)', () => {
    const result = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeIds: new Set(['idA', 'idB']), sliceCalleeNames: new Set() },
      depth: 1,
      calleeName: 'dispatch',
      calleeId: 'idB',
    });
    expect(result).toMatchObject({ evidence: 'callgraph-bridge' });
  });

  // PR #2227 tri-review-2 headline: an id-only slice (sliceCalleeNames empty/absent,
  // sliceCalleeIds present) must id-DISCRIMINATE, not short-circuit to "prove
  // everything" via the whole-symbol guard. The `basis` distinguishes the id-match
  // path from the whole-symbol short-circuit.
  it('id-only slice, id IN set → proven via the id path (not whole-symbol)', () => {
    const result = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeIds: new Set(['idA']), sliceCalleeNames: new Set() }, // names empty (id-only index)
      depth: 1,
      calleeName: 'get',
      calleeId: 'idA',
    });
    expect(result).toMatchObject({
      evidence: 'callgraph-bridge',
      basis:
        'callee id is invoked in a block of the local PDG dependence slice (resolved-symbol match)',
    });
  });

  it('id-only slice, id NOT in set → unproven-bridge (the over-prove bug) and does not throw', () => {
    // Before the fix this returned callgraph-bridge (over-prove): the empty-names
    // guard short-circuited before the id branch. It must now id-discriminate, and
    // the sentinel/name reads operate on an empty names set without throwing.
    const result = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeIds: new Set(['idA']), sliceCalleeNames: new Set() }, // names empty (id-only index)
      depth: 1,
      calleeName: 'get',
      calleeId: 'idZ',
    });
    expect(result).toMatchObject({
      evidence: 'unproven-bridge',
      basis: 'callee id is not invoked in any block of the local PDG dependence slice',
    });
  });

  it('both keys empty → whole-symbol compatibility bridge (unchanged)', () => {
    const result = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeNames: new Set(), sliceCalleeIds: new Set() },
      depth: 1,
      calleeName: 'get',
      calleeId: 'idZ',
    });
    expect(result).toMatchObject({
      evidence: 'callgraph-bridge',
      basis: 'whole-symbol PDG result uses symbol graph as compatibility bridge',
    });
  });

  it('depth>1 inherited evidence is unchanged by the id path', () => {
    const inherited = { evidence: 'callgraph-bridge' as const, basis: 'inherited proven' };
    const result = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeIds: new Set(['idA']), sliceCalleeNames: new Set(['get']) },
      depth: 2,
      calleeName: 'get',
      calleeId: 'idZ',
      inherited,
    });
    expect(result).toMatchObject(inherited);
    // No inherited supplied → the documented depth>1 default, not an id verdict.
    const fallback = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeIds: new Set(['idA']), sliceCalleeNames: new Set() },
      depth: 2,
      calleeName: 'get',
      calleeId: 'idZ',
    });
    expect(fallback).toMatchObject({ evidence: 'unproven-bridge' });
  });
});
