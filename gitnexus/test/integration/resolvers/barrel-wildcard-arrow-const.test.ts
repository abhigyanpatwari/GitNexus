import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';

const base = {
  'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
  'packages/ui/package.json': '{ "name": "@x/ui", "version": "1.0.0", "main": "src/index.ts" }\n',
  'packages/ui/src/index.ts': `export * from './components';\n`,
  'packages/ui/src/components/index.ts': `export { alpha, beta } from './Impl';\n`,
  'packages/ui/src/components/Impl/index.ts': `export * from './Impl';\n`,
  'packages/app/package.json':
    '{ "name": "@x/app", "version": "1.0.0", "main": "src/main.ts", "dependencies": { "@x/ui": "1.0.0" } }\n',
  'packages/app/src/main.ts': `import { alpha, beta } from '@x/ui';\nexport function render() { alpha('a'); beta('b'); }\n`,
};
async function run(name: string, extra: Record<string, string>, remove: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gn-c2b-${name}-`));
  const files: Record<string, string> = { ...base, ...extra };
  for (const r of remove) delete files[r];
  try {
    writeFixtureRepo(dir, files);
    const result = await runPipelineFromRepo(dir, () => {});
    return getRelationships(result, 'CALLS')
      .filter((e) => e.sourceFilePath.includes('packages/app/src/main'))
      .map((e) => e.target)
      .sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
describe('C2 probe 2', () => {
  it('E: impl is a .tsx file with plain function exports', async () => {
    expect(
      await run('e', {
        'packages/ui/src/components/Impl/Impl.tsx': `export function alpha(s: string) { return s; }\nexport function beta(s: string) { return s; }\n`,
      }),
    ).toEqual(['alpha', 'beta']);
  }, 60000);
  it('F: impl is .ts with ARROW CONST exports', async () => {
    expect(
      await run('f', {
        'packages/ui/src/components/Impl/Impl.ts': `export const alpha = (s: string) => { return s; };\nexport const beta = (s: string) => { return s; };\n`,
      }),
    ).toEqual(['alpha', 'beta']);
  }, 60000);
  it('G: impl is .ts with a React import + forwardRef generic const alongside plain fns', async () => {
    expect(
      await run('g', {
        'packages/ui/src/components/Impl/Impl.ts': `import React from 'react';\nexport const Widget = React.forwardRef<HTMLButtonElement, { label: string }>((props, ref) => { return null; });\nexport function alpha(s: string) { return s; }\nexport function beta(s: string) { return s; }\n`,
      }),
    ).toEqual(['alpha', 'beta']);
  }, 60000);
  it('H: main is .tsx and ALSO uses a JSX element', async () => {
    expect(
      await run(
        'h',
        {
          'packages/ui/src/components/Impl/Impl.ts': `export function alpha(s: string) { return s; }\nexport function beta(s: string) { return s; }\nexport function Widget(p: { label: string }) { return null; }\n`,
          'packages/ui/src/components/index.ts': `export { alpha, beta, Widget } from './Impl';\n`,
          'packages/app/src/main.tsx': `import { alpha, beta, Widget } from '@x/ui';\nexport function render() { alpha('a'); beta('b'); return <Widget label="x" />; }\n`,
        },
        ['packages/app/src/main.ts'],
      ),
    ).toEqual(['Widget', 'alpha', 'beta']);
  }, 60000);
  it('B1: a class METHOD sharing a top-level const name never wins the wildcard fan-out', async () => {
    // `export *` can only publish module-level declarations. `Foo.render` is
    // callable and outranked the value shadow in the callable-preferred index,
    // binding `import { render }` to a symbol it can never reach. The safe
    // outcome is the pre-existing one: a value shadow yields NO CALLS edge.
    expect(
      await run('b1', {
        'packages/ui/src/components/Impl/Impl.ts': `export const alpha = (s: string) => { return s; };\nexport const beta = 42;\nexport class Foo { beta() { return 1; } }\n`,
      }),
    ).toEqual(['alpha']);
  }, 60000);
  it('B1 control: the arrow const still wins over its own Variable shadow', async () => {
    expect(
      await run('b1c', {
        'packages/ui/src/components/Impl/Impl.ts': `export const alpha = (s: string) => { return s; };\nexport const beta = (s: string) => { return s; };\nexport class Foo { alpha() { return 1; } }\n`,
      }),
    ).toEqual(['alpha', 'beta']);
  }, 60000);
  it('I: dir index has wildcard AND a named re-export from a sibling', async () => {
    expect(
      await run('i', {
        'packages/ui/src/components/Impl/index.ts': `export * from './Impl';\nexport { beta } from './Beta';\n`,
        'packages/ui/src/components/Impl/Impl.ts': `export function alpha(s: string) { return s; }\n`,
        'packages/ui/src/components/Impl/Beta.ts': `export function beta(s: string) { return s; }\n`,
      }),
    ).toEqual(['alpha', 'beta']);
  }, 60000);
});
