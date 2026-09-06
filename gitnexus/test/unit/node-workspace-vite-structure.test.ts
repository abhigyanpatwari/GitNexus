import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadNodeWorkspacePackages } from '../../src/core/ingestion/import-resolvers/node-workspace-packages.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

async function entriesFor(config: string, legacy = false): Promise<readonly string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-vite-structure-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@test/config',
      ...(legacy ? { main: './dist/bundle.js' } : { exports: { '.': './dist/bundle.js' } }),
    }),
  );
  fs.writeFileSync(path.join(root, 'vite.config.ts'), config);
  for (const name of ['wrong', 'right', 'index']) {
    fs.writeFileSync(path.join(root, 'src', `${name}.ts`), `export const ${name} = 1;`);
  }
  return (await loadNodeWorkspacePackages(root))!.byName.get('@test/config')!.entries;
}

describe('Vite discovery follows only the exported static build.lib.entry', () => {
  it('refuses conventional legacy main fallbacks when a config is dynamic', async () => {
    expect(
      await entriesFor(`export default { build: { lib: { entry: dynamic } } };`, true),
    ).toEqual(['dist/bundle']);
  });

  it('does not let a conventional legacy entry outrank the explicit Vite entry', async () => {
    expect(
      await entriesFor(`export default { build: { lib: { entry: 'src/right.ts' } } };`, true),
    ).toEqual(['dist/bundle', 'src/right']);
  });
  it.each([
    `const old = { lib: { entry: 'src/wrong.ts' } };`,
    `const text = "lib: { entry: 'src/wrong.ts' }";`,
    'const text = `lib: { entry: "src/wrong.ts" }`;',
  ])('ignores unrelated config-shaped syntax: %s', async (prefix) => {
    const entries = await entriesFor(
      `${prefix}\nexport default { build: { lib: { entry: 'src/right.ts' } } };`,
    );
    expect(entries).toContain('src/right');
    expect(entries).not.toContain('src/wrong');
  });

  it.each([
    `const old = { lib: { entry: 'src/wrong.ts' } }; export default {};`,
    `export default choose({ build: { lib: { entry: 'src/wrong.ts' } } });`,
    `import { defineConfig } from './custom'; export default defineConfig({ build: { lib: { entry: 'src/wrong.ts' } } });`,
    `function defineConfig() { return {}; } export default defineConfig({ build: { lib: { entry: 'src/wrong.ts' } } });`,
    `export default { build: { lib: { entry: 'src/wrong.ts', ...override } } };`,
    `export default { build: { lib: { entry: 'src/wrong.ts' } }, ...override };`,
    `export default { build: { lib: { entry: 'src/wrong.ts', ['entry']: dynamic } } };`,
    `export default { build: { lib: { entry: dynamic } } };`,
    `export default process.env.X ? {} : { build: { lib: { entry: 'src/wrong.ts' } } };`,
  ])('refuses an unestablished entry without conventional fallback: %s', async (config) => {
    expect(await entriesFor(config)).toEqual(['dist/bundle']);
  });

  it('accepts quoted property names through defineConfig', async () => {
    expect(
      await entriesFor(
        `import { defineConfig } from 'vite'; export default defineConfig({ 'build': { "lib": { entry: 'src/right.ts' } } });`,
      ),
    ).toContain('src/right');
  });
});
