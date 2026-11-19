/**
 * R: classes are calls, so a member's id used to carry no owner. Two classes in one
 * file that shared a member name (`push`, `items`, `deposit`, `balance`, a `setMethod`
 * generic, an S4 slot) minted the same id, and the second class lost the member. The
 * id now carries the owning class.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to R parsing or resolution.
// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

const FILE = 'R/classes.R';

describe('R members of several classes in one file', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-class-member-ids'), () => {});
  }, 60000);

  /** Ids of the nodes with this label and name, sorted. */
  const idsOf = (label: string, name: string): string[] => {
    const ids: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === label && n.properties.name === name && n.properties.filePath === FILE) {
        ids.push(n.id);
      }
    });
    return ids.sort();
  };

  /** `ownerName -> memberName` for every edge of this type, sorted. */
  const owned = (type: 'HAS_METHOD' | 'HAS_PROPERTY'): string[] =>
    getRelationships(result, type)
      .map((e) => `${e.source}->${e.target}`)
      .sort();

  it('keeps one node per class for a shared R6 method name', () => {
    expect(idsOf('Method', 'push').map((id) => id.replace(/#\d+$/, ''))).toEqual([
      `Method:${FILE}:Queue.push`,
      `Method:${FILE}:Stack.push`,
    ]);
    expect(idsOf('Method', 'initialize')).toHaveLength(2);
  });

  it('keeps one node per class for a shared R6 field name', () => {
    expect(idsOf('Property', 'items')).toEqual([
      `Property:${FILE}:Queue.items`,
      `Property:${FILE}:Stack.items`,
    ]);
  });

  it('keeps one node per class for a shared RefClass method and field name', () => {
    expect(idsOf('Method', 'deposit').map((id) => id.replace(/#\d+$/, ''))).toEqual([
      `Method:${FILE}:Account.deposit`,
      `Method:${FILE}:Wallet.deposit`,
    ]);
    expect(idsOf('Property', 'balance')).toEqual([
      `Property:${FILE}:Account.balance`,
      `Property:${FILE}:Wallet.balance`,
    ]);
  });

  it('keeps one node per class for a shared S4 slot and setMethod generic', () => {
    expect(idsOf('Property', 'size')).toEqual([
      `Property:${FILE}:Circle.size`,
      `Property:${FILE}:Square.size`,
    ]);
    expect(idsOf('Method', 'area').map((id) => id.replace(/#\d+$/, ''))).toEqual([
      `Method:${FILE}:Circle.area`,
      `Method:${FILE}:Square.area`,
    ]);
  });

  it('gives every class its own HAS_METHOD edges', () => {
    const methods = owned('HAS_METHOD');
    for (const owner of ['Stack', 'Queue']) {
      for (const m of ['initialize', 'push', 'twice']) expect(methods).toContain(`${owner}->${m}`);
    }
    for (const owner of ['Account', 'Wallet']) expect(methods).toContain(`${owner}->deposit`);
    for (const owner of ['Circle', 'Square']) expect(methods).toContain(`${owner}->area`);
    expect(methods).toHaveLength(10);
  });

  it('gives every class its own HAS_PROPERTY edges', () => {
    expect(owned('HAS_PROPERTY')).toEqual([
      'Account->balance',
      'Circle->size',
      'Queue->items',
      'Square->size',
      'Stack->items',
      'Wallet->balance',
    ]);
  });

  it('points each owner edge at its own class member node', () => {
    const edges = getRelationships(result, 'HAS_METHOD').filter((e) => e.target === 'push');
    const pairs = edges.map((e) => `${e.rel.sourceId}->${e.rel.targetId.replace(/#\d+$/, '')}`);
    expect(pairs.sort()).toEqual([
      `Class:${FILE}:Queue->Method:${FILE}:Queue.push`,
      `Class:${FILE}:Stack->Method:${FILE}:Stack.push`,
    ]);
  });

  it('resolves self$push() inside each class to that class own push', () => {
    const calls = getRelationships(result, 'CALLS').filter((e) => e.target === 'push');
    const pairs = calls.map(
      (e) => `${e.rel.sourceId.replace(/#\d+$/, '')}->${e.rel.targetId.replace(/#\d+$/, '')}`,
    );
    expect([...new Set(pairs)].sort()).toEqual([
      `Method:${FILE}:Queue.twice->Method:${FILE}:Queue.push`,
      `Method:${FILE}:Stack.twice->Method:${FILE}:Stack.push`,
    ]);
  });
});
