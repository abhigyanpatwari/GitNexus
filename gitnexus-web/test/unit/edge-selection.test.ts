import { describe, expect, it } from 'vitest';
import type { EdgeType } from '../../src/lib/constants';
import { copyEdgeSelection, edgeSelectionEquals } from '../../src/lib/edge-selection';

describe('edge selection helpers', () => {
  it('compares edge selections as unordered sets', () => {
    expect(
      edgeSelectionEquals(
        ['CALLS', 'IMPORTS', 'DEFINES'] as EdgeType[],
        ['DEFINES', 'CALLS', 'IMPORTS'] as EdgeType[],
      ),
    ).toBe(true);

    expect(
      edgeSelectionEquals(
        ['CALLS', 'IMPORTS'] as EdgeType[],
        ['CALLS', 'FETCHES'] as EdgeType[],
      ),
    ).toBe(false);

    expect(
      edgeSelectionEquals(
        ['CALLS', 'IMPORTS'] as EdgeType[],
        ['CALLS', 'CALLS'] as EdgeType[],
      ),
    ).toBe(false);
  });

  it('copies preset selections before storing them in mutable UI state', () => {
    const preset: readonly EdgeType[] = ['CONTAINS', 'DEFINES'];
    const copy = copyEdgeSelection(preset);

    copy.push('CALLS');

    expect(preset).toEqual(['CONTAINS', 'DEFINES']);
    expect(copy).toEqual(['CONTAINS', 'DEFINES', 'CALLS']);
  });
});
