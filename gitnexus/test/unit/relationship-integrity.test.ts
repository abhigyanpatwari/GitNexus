import { describe, expect, it } from 'vitest';
import { relationshipIntegrityForCaller } from '../../src/core/graph/relationship-integrity.js';

describe('caller integrity signal', () => {
  it.each([
    undefined,
    null,
    {},
    { version: 1 },
    { version: 2, checkedSites: 2, unverifiedEdges: 0, duplicatesSuppressed: 0 },
    { version: 1, checkedSites: -1, unverifiedEdges: 0, duplicatesSuppressed: 0 },
  ])('does not certify missing or invalid receipt %j', (receipt) => {
    expect(relationshipIntegrityForCaller(receipt)).toMatchObject({ status: 'unverified' });
  });
  it('reports verified scope without claiming resolution accuracy', () => {
    expect(
      relationshipIntegrityForCaller({
        version: 1,
        checkedSites: 2,
        unverifiedEdges: 0,
        duplicatesSuppressed: 1,
      }),
    ).toMatchObject({
      status: 'verified',
      checkedSites: 2,
      duplicatesSuppressed: 1,
      note: expect.stringContaining('not resolution accuracy'),
    });
  });
});
