/**
 * `tsconfig` loading for module resolution (#2953).
 *
 * The previous loader read three filenames at the repo root, required `paths`
 * to exist, and kept only `targets[0]`. Each arm here is one of the things that
 * made it unusable for resolution — and the `extends` arms are where the
 * subtlety is, because `baseUrl` and `paths` routinely live in different files.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadTsconfigIndex,
  tsconfigFor,
} from '../../src/core/ingestion/languages/typescript/tsconfig.js';

const roots: string[] = [];

function repo(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-tsc-'));
  roots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('extends chains', () => {
  it('inherits `baseUrl` from the config it extends', async () => {
    const root = repo({
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
    });

    const scope = tsconfigFor(await loadTsconfigIndex(root), 'src/main.ts');

    expect(scope?.baseUrl).toBe('src');
  });

  it('resolves own `paths` targets against the INHERITED baseUrl', async () => {
    // The subtle one. This config declares `paths` but no `baseUrl`, so the
    // effective base is the inherited `src`. Resolving the targets against this
    // config's own directory instead loads the right alias pattern and points
    // every target at the wrong place — an alias that silently resolves to
    // nothing, or worse to a same-named file one directory up.
    const root = repo({
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
      'tsconfig.json': JSON.stringify({
        extends: './tsconfig.base.json',
        compilerOptions: { paths: { '@/*': ['./features/*'] } },
      }),
    });

    const scope = tsconfigFor(await loadTsconfigIndex(root), 'src/main.ts');

    expect(scope?.paths[0]?.targets).toEqual(['src/features/*']);
  });

  it('lets an own `baseUrl` win over the inherited one', async () => {
    const root = repo({
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
      'tsconfig.json': JSON.stringify({
        extends: './tsconfig.base.json',
        compilerOptions: { baseUrl: 'app', paths: { '@/*': ['./features/*'] } },
      }),
    });

    const scope = tsconfigFor(await loadTsconfigIndex(root), 'app/main.ts');

    expect(scope?.baseUrl).toBe('app');
    expect(scope?.paths[0]?.targets).toEqual(['app/features/*']);
  });

  it('rebases a base config’s `baseUrl` to that config’s own directory', async () => {
    // `extends` does not rebase: `"baseUrl": "."` inside `configs/` means
    // `configs/`, even when extended from the repo root.
    const root = repo({
      'configs/tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
      'tsconfig.json': JSON.stringify({ extends: './configs/tsconfig.base.json' }),
    });

    const scope = tsconfigFor(await loadTsconfigIndex(root), 'src/main.ts');

    expect(scope?.baseUrl).toBe('configs');
  });

  it('ignores an `extends` that names a package in node_modules', async () => {
    // Not indexed, so it contributes no `baseUrl`/`paths` — and inventing one
    // would be a guess. The own options must survive.
    const root = repo({
      'tsconfig.json': JSON.stringify({
        extends: '@tsconfig/node20/tsconfig.json',
        compilerOptions: { baseUrl: 'src' },
      }),
    });

    const scope = tsconfigFor(await loadTsconfigIndex(root), 'src/main.ts');

    expect(scope?.baseUrl).toBe('src');
  });
});

describe('which config governs a file', () => {
  it('takes the nearest config, not the root one', async () => {
    const root = repo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
      'apps/web/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
    });
    const index = await loadTsconfigIndex(root);

    // A monorepo's per-package config is what governs that package's files;
    // the root config governing them was the old loader's whole model.
    expect(tsconfigFor(index, 'apps/web/src/main.ts')?.baseUrl).toBe('apps/web/src');
    expect(tsconfigFor(index, 'tools/script.ts')?.baseUrl).toBe('');
  });
});

describe('parsing', () => {
  it('reads a config written as JSONC', async () => {
    const root = repo({
      'tsconfig.json': `{
        // the base for absolute imports
        "compilerOptions": {
          /* block */
          "baseUrl": "src",
        },
      }`,
    });

    expect(tsconfigFor(await loadTsconfigIndex(root), 'src/a.ts')?.baseUrl).toBe('src');
  });

  it('keeps every `paths` target, in order', async () => {
    // The old loader kept `targets[0]`, which silently mis-resolves the common
    // `["./src/*", "./generated/*"]` shape.
    const root = repo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*', './generated/*'] } },
      }),
    });

    const scope = tsconfigFor(await loadTsconfigIndex(root), 'src/a.ts');

    expect(scope?.paths[0]?.targets).toEqual(['src/*', 'generated/*']);
  });

  it('returns null for a repo with no config at all', async () => {
    expect(await loadTsconfigIndex(repo({ 'src/a.ts': '' }))).toBeNull();
  });
});
