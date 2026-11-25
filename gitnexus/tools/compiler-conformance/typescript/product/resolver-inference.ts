import { describe, it, before as beforeAll } from 'node:test';
import { expect } from 'expect';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from '../support/fixture.js';

// ---------------------------------------------------------------------------
// Overloaded receiver: two classes with the same method name (save) must not
// collide in the receiverKey map. The fix preserves @startIndex in the key so
// User.save@idx1 and Repo.save@idx2 remain distinct even when the enclosing
// scope funcName is the same.
// ---------------------------------------------------------------------------

describe('TypeScript overloaded-receiver resolution (receiverKey collision fix)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-overloaded-receiver'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('emits exactly 2 save() CALLS edges — one per class', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);
    const targets = saveCalls.map((c) => c.targetFilePath).sort();
    expect(targets[0]).toContain('Repo');
    expect(targets[1]).toContain('User');
  });
});

// ---------------------------------------------------------------------------
// this.users member access iterable: for (const user of this.users)
// ---------------------------------------------------------------------------

describe('TypeScript member access iterable for-loop', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-member-access-for-loop'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('does not borrow a parameter type for a nonexistent receiver field', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.filter((c) => c.source === 'processMissingUsers' && c.target === 'save')).toEqual(
      [],
    );
  });
});
