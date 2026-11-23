import { describe, expect, expectTypeOf, it } from 'vitest';
import { referenceEdgeKey } from '../../src/core/ingestion/scope-resolution/graph-bridge/edges.js';

type ReferenceSite = Parameters<typeof referenceEdgeKey>[3];

describe('reference edge span contract', () => {
  it('accepts complete spans and legacy points, but rejects partial end coordinates', () => {
    expectTypeOf<{
      kind: string;
      atRange: { startLine: number; startCol: number; endLine: number };
    }>().not.toMatchTypeOf<ReferenceSite>();
    expectTypeOf<{
      kind: string;
      atRange: { startLine: number; startCol: number; endCol: number };
    }>().not.toMatchTypeOf<ReferenceSite>();

    expect(
      referenceEdgeKey('CALLS', 'caller', 'target', {
        kind: 'call',
        atRange: { startLine: 2, startCol: 3 },
      }),
    ).toBe('CALLS:caller->target:2:3');
    expect(
      referenceEdgeKey('CALLS', 'caller', 'target', {
        kind: 'call',
        atRange: { startLine: 2, startCol: 3, endLine: 4, endCol: 5 },
      }),
    ).toBe('CALLS:caller->target:2:3:4:5');
  });
});
