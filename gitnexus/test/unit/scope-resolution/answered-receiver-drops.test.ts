/**
 * A `receiver-unresolved` drop is a claim that the site was lost with no
 * candidate. The receiver-bound pass records it as soon as its own cases give
 * up, but the read/write passes that run after it (return-shape members,
 * unique-name properties) can still answer the same site with an `ACCESSES`
 * edge. Such a site is not lost, so its drop is withdrawn — and ONLY its drop:
 * every other outcome, and every drop at a site nothing answered, stays.
 */

import { describe, it, expect } from 'vitest';
import {
  answeredSiteKey,
  withdrawAnsweredReceiverDrops,
} from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';
import type { ResolutionOutcome } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';

type SiteKind = 'call' | 'read' | 'write';

const at = (startLine: number, startCol: number) => ({
  startLine,
  startCol,
  endLine: startLine,
  endCol: startCol + 1,
});

function drop(name: string, siteKind: SiteKind, line = 4, col = 2): ResolutionOutcome {
  return {
    kind: 'suppressed',
    reason: 'receiver-unresolved',
    candidateIds: [],
    phase: 'receiver-bound-calls',
    filePath: 'src/producer.js',
    name,
    range: at(line, col),
    siteKind,
  };
}

/** The one site the later pass answered: the WRITE of `wickRatio` at 4:2. */
const ANSWERED = new Set([answeredSiteKey('src/producer.js', at(4, 2), 'write', 'wickRatio')]);

describe('withdrawAnsweredReceiverDrops', () => {
  it.each<{ readonly label: string; readonly outcome: ResolutionOutcome; readonly kept: boolean }>([
    { label: 'the answered write itself', outcome: drop('wickRatio', 'write'), kept: false },
    // `a.b` and `a.b.c()` start at the same column, so position alone cannot
    // tell the read the later pass answered from the call nothing answered.
    {
      label: 'a call at the same position with another name',
      outcome: drop('save', 'call'),
      kept: true,
    },
    {
      label: 'a read of the same name at the same position',
      outcome: drop('wickRatio', 'read'),
      kept: true,
    },
    {
      label: 'the same write one column over',
      outcome: drop('wickRatio', 'write', 4, 3),
      kept: true,
    },
    {
      label: 'a different suppression at the answered site',
      outcome: {
        kind: 'suppressed',
        reason: 'member-lookup-ambiguous',
        candidateIds: ['a', 'b'],
        phase: 'receiver-bound-calls',
        filePath: 'src/producer.js',
        name: 'wickRatio',
        range: at(4, 2),
        siteKind: 'write',
      },
      kept: true,
    },
    {
      label: 'a drop that carries no site kind',
      outcome: {
        kind: 'suppressed',
        reason: 'receiver-unresolved',
        candidateIds: [],
        phase: 'receiver-bound-calls',
        filePath: 'src/producer.js',
        name: 'wickRatio',
        range: at(4, 2),
      },
      kept: true,
    },
  ])('$label kept=$kept', ({ outcome, kept }) => {
    const outcomes = [outcome];
    const withdrawn = withdrawAnsweredReceiverDrops(outcomes, ANSWERED);
    expect({ outcomes, withdrawn }).toEqual({
      outcomes: kept ? [outcome] : [],
      withdrawn: kept ? 0 : 1,
    });
  });

  it('keeps the survivors in their recorded order', () => {
    const first = drop('save', 'call', 1, 0);
    const answered = drop('wickRatio', 'write');
    const last = drop('secretFlag', 'write', 9, 9);
    const outcomes = [first, answered, last];
    withdrawAnsweredReceiverDrops(outcomes, ANSWERED);
    expect(outcomes).toEqual([first, last]);
  });

  it('withdraws nothing when nothing was answered', () => {
    const outcomes = [drop('wickRatio', 'write')];
    expect(withdrawAnsweredReceiverDrops(outcomes, new Set())).toBe(0);
    expect(outcomes).toHaveLength(1);
  });
});
