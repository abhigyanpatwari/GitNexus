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
// Overloaded method disambiguation: interface with overloaded find + save,
// concrete class implements all three. TypeScript overloads collapse to one
// implementation signature — expect the implementation body, not individual
// overload signatures.
// ---------------------------------------------------------------------------

describe('TypeScript overloaded method disambiguation', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-overload-dispatch'), () => {});
    },
    { timeout: 60000 },
  );

  it('TypeScript overloads collapse — find has one METHOD_IMPLEMENTS edge from implementation body', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    // TS class overload signatures collapse to the implementation body's node ID.
    // Type-hash is intentionally skipped for TS because overload signatures are
    // declaration-only contracts, not true same-arity overloads like Java.
    const findEdges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('sql-repository') &&
        e.targetFilePath.includes('repository'),
    );
    expect(findEdges.length).toBe(1);
  });
});
