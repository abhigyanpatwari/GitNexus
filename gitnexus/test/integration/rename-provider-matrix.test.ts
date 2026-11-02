import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SupportedLanguages } from 'gitnexus-shared';
import { renameCases } from '../helpers/rename-integration-cases.js';

const fixtureLanguages = [...new Set(renameCases.map((entry) => entry.language))].sort();

describe('persisted semantic rename coverage', () => {
  it('has successful rename fixtures for every supported language', () => {
    expect(
      new Set(
        renameCases.filter((entry) => entry.status === 'success').map((entry) => entry.language),
      ),
    ).toEqual(new Set(Object.values(SupportedLanguages)));
  });

  // Fixtures only run through a per-language file (it also shards CI), so a missing or
  // mis-targeted file would leave its fixtures silently unexecuted.
  it.each(fixtureLanguages)(
    'runs the persisted fixtures of %s from its own rename-provider file',
    async (language) => {
      const file = new URL(`./rename-provider-${language}.test.ts`, import.meta.url);
      const source = (await fs.readFile(fileURLToPath(file), 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(source).toMatch(
        new RegExp(`\\bdefineRenameFixtureTests\\(\\s*(['"\`])${language}\\1\\s*\\)`),
      );
    },
  );
});
