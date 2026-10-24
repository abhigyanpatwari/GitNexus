import { describe, expect, it } from 'vitest';
import { defineRenameFixtureTests, renameCases } from '../helpers/rename-integration-cases.js';

// The fixture runner builds its test list from the directory, so an empty or renamed directory
// would define no test and stay green. Pin the number of R cases: adding one means raising it.
describe('R rename fixtures', () => {
  it('are all discovered', () => {
    expect(renameCases.filter((fixture) => fixture.language === 'r')).toHaveLength(58);
  });
});

defineRenameFixtureTests('r');
