import { describe, expect, it } from 'vitest';
import {
  defineRenameFixtureTests,
  renameCases,
  renameFixturePart,
  renameFixtureParts,
} from '../helpers/rename-integration-cases.js';

// The fixture runner builds its test list from the directory, so an empty or renamed directory
// would define no test and stay green. Pin the number of R cases: adding one means raising it.
// A Windows shard holds about a fifth of them, so the sorted ids are dealt into five parts: part 1
// runs here, parts 2 to 5 from rename-provider-r-part2.test.ts to rename-provider-r-part5.test.ts.
describe('R rename fixtures', () => {
  it('are all discovered', () => {
    expect(renameCases.filter((fixture) => fixture.language === 'r')).toHaveLength(114);
  });

  it('split evenly into five parts, each fixture in exactly one', () => {
    const ids = renameCases.filter((fixture) => fixture.language === 'r').map((f) => f.id);
    expect(renameFixtureParts.r).toBe(5);
    const counts = [1, 2, 3, 4, 5].map(
      (part) => ids.filter((id) => renameFixturePart(id) === part).length,
    );
    expect(counts).toEqual([23, 23, 23, 23, 22]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(ids.length);
  });
});

defineRenameFixtureTests('r');
