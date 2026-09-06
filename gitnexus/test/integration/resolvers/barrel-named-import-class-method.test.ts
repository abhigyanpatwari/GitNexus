import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';

/**
 * `namedImportsBindTopLevelOnly` (ECMAScript): `import { beta }` can never reach a
 * class member. Before the hook, `findExportByName`'s callable preference let
 * `Foo.beta()` outrank the top-level `const beta = 42` — or bind on its own when no
 * top-level `beta` existed — and the import produced a confident CALLS edge to a
 * symbol the module cannot export. Incorrect context is worse than missing: the
 * Variable shadow must win and emit no edge; the member must never bind.
 */
const impl = `export const beta = 42;\nexport function alpha(s: string) { return s; }\nexport class Foo { beta() { return 1; } }\n`;
const memberOnly = `export function alpha(s: string) { return s; }\nexport class Foo { beta() { return 1; } }\n`;

async function run(name: string, files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gn-named-member-${name}-`));
  writeFixtureRepo(dir, files);
  const result = await runPipelineFromRepo(dir, () => {});
  const targets = getRelationships(result, 'CALLS')
    .filter((e) => e.sourceFilePath.includes('src/main'))
    .map((e) => e.target)
    .sort();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return targets;
}

describe.each(['ts', 'js'])(
  'named imports bind module-level declarations only (%s)',
  (extension) => {
    // Keep identical scenarios while actually selecting each language's parser
    // and separately registered resolver.
    const fixture = (files: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(files).map(([file, content]) => [
          file.replace(/\.ts$/, `.${extension}`),
          extension === 'js' ? content.replaceAll(': string', '') : content,
        ]),
      );
    it('direct named import: a class method sharing a top-level value name emits no edge', async () => {
      const targets = await run(
        `direct-${extension}`,
        fixture({
          'package.json': '{ "name": "root", "private": true }\n',
          'src/Impl.ts': impl,
          'src/main.ts': `import { alpha, beta } from './Impl';\nexport function render() { alpha('a'); beta(); }\n`,
        }),
      );
      expect(targets).toEqual(['alpha']);
    }, 60000);

    it('direct named import: a class method with NO top-level declaration does not bind', async () => {
      const targets = await run(
        `member-only-${extension}`,
        fixture({
          'package.json': '{ "name": "root", "private": true }\n',
          'src/Impl.ts': memberOnly,
          'src/main.ts': `import { alpha, beta } from './Impl';\nexport function render() { alpha('a'); beta(); }\n`,
        }),
      );
      expect(targets).toEqual(['alpha']);
    }, 60000);

    it('named re-export through a barrel: same rule', async () => {
      const targets = await run(
        `barrel-${extension}`,
        fixture({
          'package.json': '{ "name": "root", "private": true }\n',
          'src/Impl.ts': impl,
          'src/index.ts': `export { alpha, beta } from './Impl';\n`,
          'src/main.ts': `import { alpha, beta } from './index';\nexport function render() { alpha('a'); beta(); }\n`,
        }),
      );
      expect(targets).toEqual(['alpha']);
    }, 60000);

    it('control: a top-level arrow-const behind the same barrel still binds', async () => {
      const targets = await run(
        `control-${extension}`,
        fixture({
          'package.json': '{ "name": "root", "private": true }\n',
          'src/Impl.ts': `export const beta = () => 1;\nexport function alpha(s: string) { return s; }\n`,
          'src/index.ts': `export { alpha, beta } from './Impl';\n`,
          'src/main.ts': `import { alpha, beta } from './index';\nexport function render() { alpha('a'); beta(); }\n`,
        }),
      );
      expect(targets).toEqual(['alpha', 'beta']);
    }, 60000);

    it('an aliased private import cannot guess a different module-private declaration', async () => {
      const targets = await run(
        `alias-${extension}`,
        fixture({
          'package.json': '{ "name": "root", "private": true }\n',
          'src/Impl.ts': 'export class Foo { beta() {} }\nfunction renamed() {}\n',
          'src/main.ts':
            "import { beta as renamed } from './Impl';\nexport function render() { renamed(); }\n",
        }),
      );
      expect(targets).toEqual([]);
    }, 60000);
  },
);
