/**
 * MEMBER-CALL PRODUCERS (W2-1).
 *
 * `const svc = new SignalService(); const r = svc.make(); r.secretFlag` produced
 * no edge. `return-shape-members` types the receiver `r` to the producer that
 * made it, but a member call binds the spelling `svc.make`, and slicing that to
 * its last segment leaves `make` — which is a METHOD, not a callable binding in
 * scope, so the producer lookup failed and the pass declined.
 *
 * The note this item shipped with said answering it needed inter-procedural
 * receiver typing. Measured, the pipeline had already done the hard part:
 *   - `readMake -> Method:…SignalService.make#0` resolves as a CALLS edge, and
 *   - `Property:…SignalService.make.secretFlag@N:C` already exists, because R3-4
 *     anchors a returned literal's keys to the METHOD that returns them too.
 * Only the ACCESSES edge between the two was missing.
 *
 * The fixture gives THREE producers a `secretFlag` — `SignalService.make`,
 * `SignalService.other` and the free function `makeSignal` — so resolving to the
 * wrong owner is a detectable failure rather than a coin flip that looks right.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('member-call producers (W2-1)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'member-call-producer'), () => {});
  }, 60000);

  /** Return-shape ACCESSES targets for one reader, by target node id. */
  const shapeTargetsOf = (reader: string): string[] =>
    getRelationships(result, 'ACCESSES')
      .filter((e) => e.source === reader && e.targetLabel === 'Property')
      .map((e) => e.rel.targetId);

  it('still resolves a FREE-function producer at the precise tier', () => {
    // Asserted first: every assertion below is vacuous if the pass stopped
    // emitting altogether, which is the obvious wrong way to "fix" this.
    const edge = getRelationships(result, 'ACCESSES').find(
      (e) => e.source === 'readFree' && e.targetLabel === 'Property',
    );
    expect(edge).toBeDefined();
    expect(edge!.rel.targetId).toContain('makeSignal.secretFlag');
    expect(edge!.rel.confidence).toBe(0.9);
  });

  it('resolves a member-call producer to the METHOD that returned the shape', () => {
    const targets = shapeTargetsOf('readMake');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toContain('SignalService.make.secretFlag');
  });

  it('separates two methods on the SAME class that own the same member name', () => {
    // The discriminating case. Matching on the last segment (`make` / `other`)
    // alone cannot tell these apart from each other or from the free function,
    // because the owner qualifier in the node id is `<Class>.<method>`.
    const targets = shapeTargetsOf('readOther');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toContain('SignalService.other.secretFlag');
  });

  it('does not let a member-call reader reach the FREE function of the same shape', () => {
    // `makeSignal` owns a `secretFlag` too. A whole-graph textual join on
    // `.secretFlag` would happily return it.
    for (const target of [...shapeTargetsOf('readMake'), ...shapeTargetsOf('readOther')]) {
      expect(target).not.toContain('makeSignal.secretFlag');
    }
  });

  it('claims nothing when the member is on NEITHER shape', () => {
    // The receiver is typed and the producer's shape is known, so this is a
    // disproof, not an absence of evidence — it must not fall through to the
    // 0.5 name tier and get answered by an unrelated same-named key.
    expect(shapeTargetsOf('readAbsent')).toEqual([]);
  });
});
