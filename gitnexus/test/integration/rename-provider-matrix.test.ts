import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { defineRenameFixtureTests, renameCases } from '../helpers/rename-integration-cases.js';

describe('persisted semantic rename coverage', () => {
  it('has successful rename fixtures for every supported language', () => {
    expect(
      new Set(
        renameCases.filter((entry) => entry.status === 'success').map((entry) => entry.language),
      ),
    ).toEqual(new Set(Object.values(SupportedLanguages)));
  });
});

defineRenameFixtureTests(0);
