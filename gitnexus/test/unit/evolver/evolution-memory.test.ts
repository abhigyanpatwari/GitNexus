import { describe, expect, it } from 'vitest';
import { InMemoryEvolutionMemory } from '../../../src/core/evolver/index.js';
import type { EvolutionMemoryRecord } from '../../../src/core/evolver/index.js';

const capturedAt = '2026-05-25T00:00:00.000Z';

function variantRecord(goalId = 'goal-1', variantId = 'variant-parameter-1'): EvolutionMemoryRecord {
  return {
    id: 'mem-variant-1',
    goalId,
    variantId,
    kind: 'variant',
    summary: 'Generated parameter variant for topK adjustment',
    createdAt: capturedAt,
    payload: { mutationType: 'parameter' },
  };
}

function trialRecord(variantId = 'variant-parameter-1'): EvolutionMemoryRecord {
  return {
    id: 'mem-trial-1',
    variantId,
    kind: 'trial',
    summary: 'Sandbox trial completed successfully',
    createdAt: capturedAt,
    payload: { protocolId: 'protocol-1' },
  };
}

function evaluationRecord(variantId = 'variant-parameter-1'): EvolutionMemoryRecord {
  return {
    id: 'mem-evaluation-1',
    variantId,
    kind: 'evaluation',
    summary: 'Evaluation verdict: promote',
    createdAt: capturedAt,
    payload: { verdict: 'promote' },
  };
}

function gateRecord(variantId = 'variant-parameter-1'): EvolutionMemoryRecord {
  return {
    id: 'mem-gate-1',
    variantId,
    kind: 'gate',
    summary: 'Gate decision: allow',
    createdAt: capturedAt,
    payload: { decision: 'allow' },
  };
}

function promotionRecord(variantId = 'variant-parameter-1'): EvolutionMemoryRecord {
  return {
    id: 'mem-promotion-1',
    variantId,
    kind: 'promotion',
    summary: 'Parameter variant promoted',
    createdAt: capturedAt,
    payload: { appliedAt: capturedAt },
  };
}

function correctionRecord(variantId = 'variant-parameter-1'): EvolutionMemoryRecord {
  return {
    id: 'mem-correction-1',
    variantId,
    kind: 'correction',
    summary: 'Rolled back due to regression',
    createdAt: capturedAt,
    payload: { actionType: 'rollback-parameters' },
  };
}

describe('InMemoryEvolutionMemory', () => {
  it('stores and retrieves records by kind', () => {
    const memory = new InMemoryEvolutionMemory();
    const variant = variantRecord();
    const trial = trialRecord();

    memory.add(variant);
    memory.add(trial);

    expect(memory.queryByKind('variant')).toEqual([variant]);
    expect(memory.queryByKind('trial')).toEqual([trial]);
    expect(memory.queryByKind('evaluation')).toEqual([]);
  });

  it('stores and retrieves records by goal id', () => {
    const memory = new InMemoryEvolutionMemory();
    const record1 = variantRecord('goal-1');
    const record2 = variantRecord('goal-2');

    memory.add(record1);
    memory.add(record2);

    expect(memory.queryByGoalId('goal-1')).toEqual([record1]);
    expect(memory.queryByGoalId('goal-2')).toEqual([record2]);
    expect(memory.queryByGoalId('goal-3')).toEqual([]);
  });

  it('stores and retrieves records by variant id', () => {
    const memory = new InMemoryEvolutionMemory();
    const variant = variantRecord('goal-1', 'variant-parameter-1');
    const trial = trialRecord('variant-parameter-1');
    const evaluation = evaluationRecord('variant-parameter-1');

    memory.add(variant);
    memory.add(trial);
    memory.add(evaluation);

    const results = memory.queryByVariantId('variant-parameter-1');
    expect(results).toHaveLength(3);
    expect(results).toEqual([variant, trial, evaluation]);
  });

  it('records a complete evolution run and queries across all stages', () => {
    const memory = new InMemoryEvolutionMemory();
    const variant = variantRecord();
    const trial = trialRecord();
    const evaluation = evaluationRecord();
    const gate = gateRecord();
    const promotion = promotionRecord();

    memory.add(variant);
    memory.add(trial);
    memory.add(evaluation);
    memory.add(gate);
    memory.add(promotion);

    const allForVariant = memory.queryByVariantId('variant-parameter-1');
    expect(allForVariant).toHaveLength(5);

    const allKinds = ['variant', 'trial', 'evaluation', 'gate', 'promotion'] as const;
    for (const kind of allKinds) {
      expect(memory.queryByKind(kind)).toHaveLength(1);
    }
  });

  it('returns read-only copies that do not mutate internal state', () => {
    const memory = new InMemoryEvolutionMemory();
    const record = variantRecord();
    memory.add(record);

    const results = memory.queryByKind('variant');
    results.pop();

    expect(memory.queryByKind('variant')).toEqual([record]);
  });

  it('ignores records without goal id when querying by goal id', () => {
    const memory = new InMemoryEvolutionMemory();
    const record: EvolutionMemoryRecord = {
      id: 'mem-no-goal',
      kind: 'trial',
      summary: 'Trial without goal',
      createdAt: capturedAt,
      payload: {},
    };
    memory.add(record);

    expect(memory.queryByGoalId('goal-1')).toEqual([]);
  });
});
