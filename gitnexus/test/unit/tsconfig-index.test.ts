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

  it('reads a package-form `extends` out of node_modules when it is installed', async () => {
    // `node_modules` is not INDEXED — it is dependency code, not the
    // repository's own — but that is different from not reading it. A shared
    // internal base is exactly where a monorepo puts the `paths` its packages
    // import through, so refusing to open it loses aliases the repository does
    // declare.
    const root = repo({
      'node_modules/@acme/tsconfig/tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: 'src', paths: { '~/*': ['./shared/*'] } },
      }),
      'tsconfig.json': JSON.stringify({ extends: '@acme/tsconfig' }),
    });

    const scope = tsconfigFor(await loadTsconfigIndex(root), 'src/main.ts');

    // Resolved relative to the config that DECLARED them, which is tsc's rule
    // and not an artefact of reading from `node_modules`: `extends` never
    // rebases `baseUrl`. So a package base points at its own directory, and
    // that is worth pinning rather than wishing away — it is the reason a
    // published base config rarely contributes aliases a repo's own files
    // resolve through, and why the `@tsconfig/*` family (which sets `target`
    // and `lib`, never `paths`) is a no-op here either way.
    expect(scope?.baseUrl).toBe('node_modules/@acme/tsconfig/src');
    expect(scope?.paths[0]?.targets).toEqual(['node_modules/@acme/tsconfig/src/shared/*']);
  });

  it('keeps the extending config’s own options when the package is not installed', async () => {
    // An un-installed checkout is a shape a static analyser must expect and a
    // compiler may refuse. Degrading to fewer resolutions is correct; inventing
    // a base is not.
    const root = repo({
      'tsconfig.json': JSON.stringify({
        extends: '@tsconfig/node20/tsconfig.json',
        compilerOptions: { baseUrl: 'src' },
      }),
    });

    const scope = tsconfigFor(await loadTsconfigIndex(root), 'src/main.ts');

    expect(scope?.baseUrl).toBe('src');
  });

  it('prefers an exact `paths` pattern over a wildcard that also matches', async () => {
    // `a` and `a*` both match `a` with the same literal prefix length, so
    // sorting on length alone left tsc's exact-wins rule to declaration order.
    const root = repo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { 'a*': ['./wild/*'], a: ['./exact'] },
        },
      }),
    });

    const scope = tsconfigFor(await loadTsconfigIndex(root), 'src/main.ts');
    const exact = scope?.paths.find((mapping) => mapping.pattern === 'a');

    expect(exact?.targets).toEqual(['exact']);
  });
});

describe('which config governs a file', () => {
  it('lets a child config with no baseUrl shadow the root, rather than inheriting it', async () => {
    // The child project declares no `baseUrl`, which in TypeScript means its
    // non-relative specifiers are PACKAGE lookups. Dropping the empty child let
    // `tsconfigFor` fall through to the root and apply the root's aliases to
    // the child's files — inventing a resolution the child never declared.
    const root = repo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
      'apps/web/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
    });
    const index = await loadTsconfigIndex(root);

    const child = tsconfigFor(index, 'apps/web/src/main.ts');
    expect(child?.dir).toBe('apps/web');
    expect(child?.baseUrl).toBeNull();
    expect(child?.paths).toEqual([]);

    // The root still governs everything outside that package.
    expect(tsconfigFor(index, 'tools/script.ts')?.baseUrl).toBe('');
  });

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
