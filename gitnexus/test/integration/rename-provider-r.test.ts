import { describe, expect, it } from 'vitest';
import {
  defineRenameFixtureTests,
  renameCases,
  renameOverflowIds,
} from '../helpers/rename-integration-cases.js';

// The fixture runner builds its test list from the directory, so an empty or renamed directory
// would define no test and stay green. Pin the number of R cases: adding one means raising it.
// The Windows shard budget holds about half of them, so the overflow ids run from
// rename-provider-r-part2.test.ts; the two counts below must add up to the pin.
describe('R rename fixtures', () => {
  it('are all discovered', () => {
    expect(renameCases.filter((fixture) => fixture.language === 'r')).toHaveLength(110);
  });

  it('split exactly between this file and the overflow file', () => {
    const ids = renameCases.filter((fixture) => fixture.language === 'r').map((f) => f.id);
    const overflow = ids.filter((id) => renameOverflowIds.has(id));
    expect(overflow).toHaveLength(55);
    expect(ids.length - overflow.length).toBe(55);
    // An overflow id naming no R fixture would silently shrink the second file.
    expect([...renameOverflowIds].filter((id) => id.startsWith('r/') && !ids.includes(id))).toEqual(
      [],
    );
  });
});

defineRenameFixtureTests('r');
