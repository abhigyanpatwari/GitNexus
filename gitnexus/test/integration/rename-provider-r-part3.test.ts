import { describe, expect, it } from 'vitest';
import {
  defineRenameFixturePartTests,
  renameCases,
  renameFixturePart,
} from '../helpers/rename-integration-cases.js';

// Part 3 of the five R rename fixture parts, split out to fit the Windows shard budget; part 1
// and the partition pins live in rename-provider-r.test.ts.
describe('R rename fixtures, part 3', () => {
  it('are all discovered', () => {
    const part = renameCases.filter(
      (fixture) => fixture.language === 'r' && renameFixturePart(fixture.id) === 3,
    );
    expect(part).toHaveLength(23);
  });
});

defineRenameFixturePartTests('r', 3);
