import { describe, expect, it } from 'vitest';
import type { ResolutionOutcome } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';
import {
  MAX_OVERLOAD_IDENTITIES_PER_SITE,
  MAX_OVERLOAD_SUMMARY_BYTES,
  MAX_UNRESOLVED_OVERLOAD_SITES,
  probeOverloadBoundaries,
  summarizeUnresolvedOverloads,
} from '../../../src/core/ingestion/scope-resolution/unresolved-overloads.js';

type Suppressed = Extract<ResolutionOutcome, { kind: 'suppressed' }>;
const target = 'Method:src/Host.java:Host.find#1~String';
const otherTarget = 'Method:src/Host.java:Host.find#1~Long';
const owner = 'Class:src/Host.java:Host';
const caller = 'Method:src/Caller.java:Caller.run#0';

function suppressed(overrides: Partial<Suppressed> = {}): Suppressed {
  return {
    kind: 'suppressed',
    phase: 'receiver-bound-calls',
    filePath: 'src/Caller.java',
    name: 'find',
    range: { startLine: 5, startCol: 2, endLine: 5, endCol: 20 },
    reason: 'overload-ambiguous',
    candidateIds: ['def:Host.find.String', 'def:Host.find.Long'],
    candidateGraphIds: [target, otherTarget],
    candidateOwnerIds: [owner],
    callerId: caller,
    candidateSetComplete: true,
    siteKind: 'call',
    ...overrides,
  };
}

function resolved(outcome: Suppressed): Extract<ResolutionOutcome, { kind: 'resolved' }> {
  return {
    kind: 'resolved',
    phase: outcome.phase,
    filePath: outcome.filePath,
    name: outcome.name,
    range: outcome.range,
    targetId: target,
  };
}

const probe = (
  summary: unknown,
  ids: readonly string[],
  direction: 'upstream' | 'downstream' | 'both' = 'upstream',
) => probeOverloadBoundaries(summary, new Set(ids), direction);

describe('persisted unresolved overload coverage', () => {
  it('records a measured-clean receipt, distinct from an absent receipt', () => {
    const clean = summarizeUnresolvedOverloads([]);
    expect(clean).toEqual({
      schemaVersion: 1,
      complete: true,
      totalSites: 0,
      omittedSites: 0,
      sites: [],
    });
    expect(probe(clean, [target])).toEqual({ notes: [], sites: 0 });
    expect(probe(undefined, [target])).toMatchObject({
      sites: 0,
      notes: [expect.stringContaining('not recorded')],
    });
    expect(probe(summarizeUnresolvedOverloads([], false), [target]).notes).toEqual([
      expect.stringContaining('partial'),
    ]);
  });

  it('matches public candidate, caller and declaring-owner IDs in their own directions', () => {
    const summary = summarizeUnresolvedOverloads([suppressed()]);
    expect(probe(summary, [target]).sites).toBe(1);
    expect(probe(summary, [owner]).sites).toBe(1);
    expect(probe(summary, [caller], 'downstream').sites).toBe(1);
    expect(probe(summary, [caller], 'both').sites).toBe(1);
    expect(probe(summary, [caller])).toEqual({ sites: 0, notes: [] });
    expect(probe(summary, [target], 'downstream')).toEqual({ sites: 0, notes: [] });
    expect(probe(summary, ['def:Host.find.String'])).toEqual({ sites: 0, notes: [] });
    expect(probe(summary, ['Class:src/Host.java:Unrelated'])).toEqual({ sites: 0, notes: [] });
  });

  it('counts one site once when several candidates, owners or phases match', () => {
    const outcome = suppressed();
    const summary = summarizeUnresolvedOverloads([
      outcome,
      outcome,
      suppressed({
        phase: 'receiver-dispatch',
        reason: 'overload-unknown',
        name: 'qualified.find',
      }),
    ]);
    expect(summary.totalSites).toBe(1);
    expect(probe(summary, [target, otherTarget, owner, caller], 'both').sites).toBe(1);
    expect(summary.sites[0].reasons).toEqual(['overload-ambiguous', 'overload-unknown']);
  });

  it('reconciles resolved-after-suppressed only within the same decision phase', () => {
    const primary = suppressed();
    expect(summarizeUnresolvedOverloads([primary, resolved(primary)]).sites).toEqual([]);
    const dispatch = suppressed({ phase: 'receiver-dispatch', reason: 'overload-unknown' });
    const summary = summarizeUnresolvedOverloads([primary, dispatch, resolved(primary)]);
    expect(summary.totalSites).toBe(1);
    expect(summary.sites[0].reasons).toEqual(['overload-unknown']);
    expect(probe(summary, [target]).sites).toBe(1);
  });

  it('uses the last decision in a phase and excludes proven inapplicable calls', () => {
    const first = suppressed();
    const last = suppressed({ candidateGraphIds: [otherTarget], candidateIds: ['def:other'] });
    expect(probe(summarizeUnresolvedOverloads([first, last]), [target])).toEqual({
      sites: 0,
      notes: [],
    });
    expect(
      summarizeUnresolvedOverloads([first, suppressed({ reason: 'overload-inapplicable' })]).sites,
    ).toEqual([]);
    expect(summarizeUnresolvedOverloads([resolved(first), first]).totalSites).toBe(1);
  });

  it('does not label property accesses or unrelated suppressions as missed calls', () => {
    const summary = summarizeUnresolvedOverloads([
      suppressed({ reason: 'member-lookup-ambiguous', siteKind: 'read' }),
      suppressed({ reason: 'member-lookup-ambiguous', siteKind: 'write' }),
      suppressed({ reason: 'receiver-unresolved' }),
      suppressed({ reason: 'selected-callable-deleted' }),
      { ...resolved(suppressed()), kind: 'fallback-guessed', targetId: target },
      {
        kind: 'reexport-ambiguous',
        phase: 'exports',
        filePath: 'src/barrel.ts',
        name: 'find',
        candidateIds: ['def:one', 'def:two'],
      },
    ]);
    expect(summary).toMatchObject({ complete: true, totalSites: 0, sites: [] });
    const oldMember = summarizeUnresolvedOverloads([
      suppressed({ reason: 'member-lookup-ambiguous', siteKind: undefined }),
    ]);
    expect(oldMember).toMatchObject({ complete: false, totalSites: 0 });
    expect(probe(oldMember, [target]).notes.join(' ')).toContain('partial');
  });

  it.each([
    { candidateGraphIds: undefined },
    { candidateGraphIds: [] },
    { callerId: undefined },
    { candidateSetComplete: undefined },
    { candidateSetComplete: false },
  ])('does not certify absent keys when attribution is incomplete: %j', (overrides) => {
    const summary = summarizeUnresolvedOverloads([suppressed(overrides)]);
    expect(summary.complete).toBe(false);
    expect(probe(summary, ['Method:elsewhere:unseen'])).toEqual({
      sites: 0,
      notes: [expect.stringContaining('partial')],
    });
  });

  it('keeps known matches as measured floors in a partial summary', () => {
    const summary = summarizeUnresolvedOverloads([suppressed({ candidateSetComplete: false })]);
    expect(probe(summary, [target])).toEqual({
      sites: 1,
      notes: [expect.stringContaining('1 call site'), expect.stringContaining('partial')],
    });
  });

  it('bounds site count and never treats an omitted candidate as measured zero', () => {
    const outcomes = Array.from({ length: MAX_UNRESOLVED_OVERLOAD_SITES + 1 }, (_, index) =>
      suppressed({
        range: { startLine: index + 1, startCol: 0, endLine: index + 1, endCol: 1 },
        candidateIds: [`def:${index}`],
        candidateGraphIds: [`Method:file:${index}`],
      }),
    );
    const summary = summarizeUnresolvedOverloads(outcomes);
    expect(summary).toMatchObject({
      complete: false,
      totalSites: outcomes.length,
      omittedSites: 1,
    });
    expect(summary.sites).toHaveLength(MAX_UNRESOLVED_OVERLOAD_SITES);
    const retained = new Set(summary.sites.flatMap((site) => site.candidateIds));
    const omitted = outcomes.find((outcome) => !retained.has(outcome.candidateGraphIds![0]))!;
    expect(probe(summary, omitted.candidateGraphIds!).notes.join(' ')).toContain('partial');
  });

  it('bounds per-site identities and serialized bytes with explicit partial coverage', () => {
    const many = Array.from(
      { length: MAX_OVERLOAD_IDENTITIES_PER_SITE + 1 },
      (_, index) => `Method:file:${index}`,
    );
    const refs = summarizeUnresolvedOverloads([suppressed({ candidateGraphIds: many })]);
    expect(refs.complete).toBe(false);
    expect(refs.sites[0].candidateIds).toHaveLength(MAX_OVERLOAD_IDENTITIES_PER_SITE);
    const huge = summarizeUnresolvedOverloads([
      suppressed({ name: 'x'.repeat(MAX_OVERLOAD_SUMMARY_BYTES) }),
    ]);
    expect(huge).toMatchObject({ complete: false, omittedSites: 1, sites: [] });
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThan(MAX_OVERLOAD_SUMMARY_BYTES);
  });

  it('is deterministic and preserves identities through JSON including prototype-shaped strings', () => {
    const one = suppressed({ candidateGraphIds: ['constructor', '__proto__', 'toString'] });
    const two = suppressed({ range: { startLine: 10, startCol: 2, endLine: 10, endCol: 20 } });
    const summary = summarizeUnresolvedOverloads([one, two]);
    expect(summarizeUnresolvedOverloads([two, one])).toEqual(summary);
    const restored = JSON.parse(JSON.stringify(summary));
    expect(probe(restored, ['__proto__', 'constructor'])).toEqual({
      sites: 1,
      notes: [expect.stringContaining('1 call site')],
    });
  });

  it('supports caller-file filtering without counting excluded sites', () => {
    const summary = summarizeUnresolvedOverloads([suppressed({ filePath: 'test/Caller.java' })]);
    expect(probeOverloadBoundaries(summary, new Set([target]), 'upstream', () => false)).toEqual({
      notes: [],
      sites: 0,
    });
  });

  it('hedges a capped traversal without inventing counts for unexamined targets', () => {
    const summary = summarizeUnresolvedOverloads([suppressed()]);
    expect(
      probeOverloadBoundaries(summary, new Set(['unexamined']), 'upstream', () => true, false),
    ).toEqual({
      sites: 0,
      notes: [expect.stringContaining('traversal was incomplete')],
    });
    expect(
      probeOverloadBoundaries(
        summarizeUnresolvedOverloads([]),
        new Set([target]),
        'upstream',
        () => true,
        false,
      ),
    ).toEqual({
      sites: 0,
      notes: [],
    });
  });

  it.each([
    null,
    [],
    { schemaVersion: 2, complete: true, totalSites: 0, omittedSites: 0, sites: [] },
    { schemaVersion: 1, complete: true, totalSites: -1, omittedSites: 0, sites: [] },
    { schemaVersion: 1, complete: true, totalSites: 1, omittedSites: 0, sites: [] },
    { schemaVersion: 1, complete: true, totalSites: 1, omittedSites: 1, sites: [] },
    { schemaVersion: 1, complete: 'true', totalSites: 0, omittedSites: 0, sites: [] },
    Object.create({ schemaVersion: 1, complete: true, totalSites: 0, omittedSites: 0, sites: [] }),
  ])('treats malformed receipts as unverified: %j', (summary) => {
    expect(probe(summary, [target])).toEqual({
      sites: 0,
      notes: [expect.stringContaining('metadata is invalid')],
    });
  });

  it('rejects malformed, duplicated or forged site identities', () => {
    const summary = summarizeUnresolvedOverloads([suppressed()]);
    for (const sites of [
      [{ ...summary.sites[0], candidateIds: ['same', 'same'] }],
      [{ ...summary.sites[0], id: 'invented' }],
      [{ ...summary.sites[0], range: { startLine: 1, startCol: 0, endLine: 0, endCol: 0 } }],
      [{ ...summary.sites[0], reasons: ['receiver-unresolved'] }],
      [summary.sites[0], summary.sites[0]],
    ]) {
      expect(
        probe({ ...summary, totalSites: sites.length, sites }, [target]).notes.join(' '),
      ).toContain('metadata is invalid');
    }
  });
});
