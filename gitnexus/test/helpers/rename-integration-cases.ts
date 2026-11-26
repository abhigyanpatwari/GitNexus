import { describe, it } from 'vitest';
import { runRenameFixture } from './run-rename-fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = fileURLToPath(new URL('../fixtures/rename-integration/', import.meta.url));
export const renameCases: Array<{
  id: string;
  directory: string;
  language: string;
  status: string;
}> = [];
for (const language of (await fs.readdir(fixtures, { withFileTypes: true })).filter((entry) =>
  entry.isDirectory(),
)) {
  for (const entry of (
    await fs.readdir(path.join(fixtures, language.name), { withFileTypes: true })
  ).filter((entry) => entry.isDirectory())) {
    const directory = path.join(fixtures, language.name, entry.name);
    const specification = JSON.parse(await fs.readFile(path.join(directory, 'case.json'), 'utf8'));
    if (specification.language !== language.name)
      throw new Error(`Fixture language mismatch: ${directory}`);
    renameCases.push({
      id: `${language.name}/${entry.name}`,
      directory,
      language: specification.language,
      status: specification.expect.status,
    });
  }
}

renameCases.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

// A language whose fixtures outgrow one CI shard budget runs them from several files. Its sorted
// fixture ids are dealt round-robin into `renameFixtureParts[language]` parts: part 1 runs from the
// language's main file through `defineRenameFixtureTests`, parts 2..n from their own files through
// `defineRenameFixturePartTests`, so every fixture is registered exactly once.
export const renameFixtureParts: Readonly<Record<string, number>> = { r: 5 };

const partById = new Map<string, number>();
const dealt = new Map<string, number>();
for (const fixture of renameCases) {
  const index = dealt.get(fixture.language) ?? 0;
  dealt.set(fixture.language, index + 1);
  partById.set(fixture.id, (index % (renameFixtureParts[fixture.language] ?? 1)) + 1);
}

/** The 1-based part (test file) that registers this fixture id. */
export function renameFixturePart(id: string): number {
  return partById.get(id) ?? 1;
}

// Separate files let CI distribute these real indexing runs across its shards.
export function defineRenameFixtureTests(language: string): void {
  defineRenameFixturePartTests(language, 1);
}

// Registers only part `part` of `language`'s fixtures, for that part's own test file.
export function defineRenameFixturePartTests(language: string, part: number): void {
  defineRenameFixtureCases(
    (fixture) => fixture.language === language && renameFixturePart(fixture.id) === part,
  );
}

function defineRenameFixtureCases(
  include: (fixture: (typeof renameCases)[number]) => boolean,
): void {
  describe('persisted semantic rename across providers (no mocks)', () => {
    it.each(renameCases.filter(include))(
      '$id',
      ({ directory }) => runRenameFixture(directory),
      180_000,
    );
  });
}
