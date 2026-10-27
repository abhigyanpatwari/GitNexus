import { describe, expect, it } from 'vitest';
import {
  defineRenameOverflowFixtureTests,
  renameCases,
  renameOverflowIds,
} from '../helpers/rename-integration-cases.js';

// Second half of the R rename fixtures, split out to fit the Windows shard budget; the first half
// and the partition pins live in rename-provider-r.test.ts.
describe('R rename overflow fixtures', () => {
  it('are all discovered', () => {
    const overflow = renameCases.filter(
      (fixture) => fixture.language === 'r' && renameOverflowIds.has(fixture.id),
    );
    expect(overflow).toHaveLength(57);
  });
});

defineRenameOverflowFixtureTests('r');
