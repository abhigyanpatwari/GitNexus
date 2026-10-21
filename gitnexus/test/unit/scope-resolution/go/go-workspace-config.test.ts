import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureGoWorkspaceConfig,
  loadGoWorkspaceConfig,
  locateGoImport,
  parseGoModulePath,
  parseGoWorkUses,
  type GoImportLocation,
  type GoWorkspaceConfig,
} from '../../../../src/core/ingestion/languages/go/workspace-config.js';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function fixture(files: Readonly<Record<string, string>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-go-workspace-'));
  temporary.push(dir);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

describe('parseGoModulePath', () => {
  it.each([
    ['a plain directive', 'module example.com/app\n\ngo 1.21\n', 'example.com/app'],
    [
      'a trailing comment',
      '// header\nmodule github.com/acme/orders/v2 // Deprecated: use v3\n',
      'github.com/acme/orders/v2',
    ],
    ['a double-quoted path', 'module "example.com/quoted"\n', 'example.com/quoted'],
    ['a raw-quoted path and CRLF', 'module `example.com/raw`\r\ngo 1.21\r\n', 'example.com/raw'],
    ['no module directive', 'go 1.21\nrequire example.com/dep v1.0.0\n', null],
    ['a commented-out directive', '// module example.com/commented\n', null],
    ['an empty file', '', null],
  ])('reads %s', (_shape, goMod, expected) => {
    expect(parseGoModulePath(goMod)).toBe(expected);
  });
});

describe('parseGoWorkUses', () => {
  it.each([
    ['a single directive', 'go 1.22\n\nuse ./api\n', ['./api']],
    [
      'a block with comments and quotes',
      'use (\n\t./api\n\t./web // frontend\n\t"./my tools"\n)\n',
      ['./api', './web', './my tools'],
    ],
    ['the root and an escaping path, as written', 'use .\nuse ../outside\n', ['.', '../outside']],
    ['a commented-out directive', 'go 1.22\n// use ./ignored\n', []],
  ])('reads %s', (_shape, goWork, expected) => {
    expect(parseGoWorkUses(goWork)).toEqual(expected);
  });
});

/** Two services whose directories are named unlike their modules, and a major-
 *  version module in a directory that names neither its path nor its suffix. */
const MONOREPO: GoWorkspaceConfig = {
  modules: [
    { modulePath: 'github.com/acme/billing', dir: 'billing-service' },
    { modulePath: 'github.com/acme/orders', dir: 'orders-service' },
    { modulePath: 'example.com/generator/v2', dir: 'tools/codegen' },
  ],
  workFiles: [],
};

/** A root module, a nested module with an unrelated path, and a nested module
 *  whose path extends the root's. */
const ROOT_AND_NESTED: GoWorkspaceConfig = {
  modules: [
    { modulePath: 'example.com/platform', dir: '' },
    { modulePath: 'github.com/acme/ledger', dir: 'services/billing' },
    { modulePath: 'example.com/platform/tools', dir: 'tools' },
  ],
  workFiles: [],
};

/** Two `go.mod` files declaring one path (copied examples, test data). */
const DUPLICATE_MODULES = [
  { modulePath: 'example.com/app', dir: 'a' },
  { modulePath: 'example.com/app', dir: 'b' },
  { modulePath: 'example.com/consumer', dir: 'c' },
];
const DUPLICATES_WITH_WORK: GoWorkspaceConfig = {
  modules: DUPLICATE_MODULES,
  workFiles: [{ dir: '', use: ['a', 'c'] }],
};
const DUPLICATES_WITHOUT_WORK: GoWorkspaceConfig = { modules: DUPLICATE_MODULES, workFiles: [] };

const moduleDirs = (dirs: readonly string[]): GoImportLocation => ({ kind: 'module', dirs });

describe('locateGoImport', () => {
  it.each<[string, GoWorkspaceConfig, string, string, GoImportLocation]>([
    [
      'the module owning the path, not the directory name',
      MONOREPO,
      'github.com/acme/orders/internal/repository',
      'orders-service/cmd/orders/main.go',
      moduleDirs(['orders-service/internal/repository']),
    ],
    [
      'another in-repo module',
      MONOREPO,
      'github.com/acme/billing/internal/repository',
      'orders-service/cmd/orders/main.go',
      moduleDirs(['billing-service/internal/repository']),
    ],
    [
      'a major-version module in an unrelated directory',
      MONOREPO,
      'example.com/generator/v2/models',
      'tools/codegen/cmd/gen/main.go',
      moduleDirs(['tools/codegen/models']),
    ],
    [
      'a nested module root package',
      MONOREPO,
      'example.com/generator/v2',
      'tools/codegen/cmd/gen/main.go',
      moduleDirs(['tools/codegen']),
    ],
    [
      'a Windows-separated importer',
      MONOREPO,
      'github.com/acme/orders/internal/repository',
      'orders-service\\cmd\\orders\\main.go',
      moduleDirs(['orders-service/internal/repository']),
    ],
    [
      'an owned path from outside every module',
      MONOREPO,
      'github.com/acme/orders/internal/repository',
      'scripts/main.go',
      moduleDirs(['orders-service/internal/repository']),
    ],
    [
      'the standard library from inside a module',
      MONOREPO,
      'fmt',
      'orders-service/cmd/orders/main.go',
      { kind: 'external' },
    ],
    [
      'a dependency sharing an in-repo path tail',
      MONOREPO,
      'github.com/other/billing/internal/repository',
      'orders-service/cmd/orders/main.go',
      { kind: 'external' },
    ],
    [
      'a module path that only shares characters, not a segment',
      MONOREPO,
      'github.com/acme/orders-api/client',
      'orders-service/cmd/orders/main.go',
      { kind: 'external' },
    ],
    [
      'an unowned path from outside every module',
      MONOREPO,
      'github.com/other/lib/util',
      'scripts/main.go',
      { kind: 'gopath' },
    ],
    [
      "the root module's own package",
      ROOT_AND_NESTED,
      'example.com/platform/internal/repository',
      'cmd/server/main.go',
      moduleDirs(['internal/repository']),
    ],
    [
      "the root module's root package",
      ROOT_AND_NESTED,
      'example.com/platform',
      'services/billing/cmd/billing/main.go',
      moduleDirs(['']),
    ],
    [
      "the longest module path, the shorter one's directory being the nested module's",
      ROOT_AND_NESTED,
      'example.com/platform/tools/lint',
      'cmd/server/main.go',
      moduleDirs(['tools/lint']),
    ],
    [
      'no directory of the root module inside a nested module',
      ROOT_AND_NESTED,
      'example.com/platform/services/billing/internal/repository',
      'cmd/server/main.go',
      moduleDirs([]),
    ],
    [
      "a nested module's own package",
      ROOT_AND_NESTED,
      'github.com/acme/ledger/internal/repository',
      'services/billing/cmd/billing/main.go',
      moduleDirs(['services/billing/internal/repository']),
    ],
    [
      "the importer's own module among duplicates",
      DUPLICATES_WITH_WORK,
      'example.com/app/models',
      'b/main.go',
      moduleDirs(['b/models']),
    ],
    [
      'the go.work module among duplicates',
      DUPLICATES_WITH_WORK,
      'example.com/app/models',
      'c/main.go',
      moduleDirs(['a/models']),
    ],
    [
      'nothing among duplicates without a go.work',
      DUPLICATES_WITHOUT_WORK,
      'example.com/app/models',
      'c/main.go',
      moduleDirs([]),
    ],
  ])('selects %s', (_case, config, importPath, fromFile, expected) => {
    expect(locateGoImport(config, importPath, fromFile)).toEqual(expected);
  });
});

describe('captureGoWorkspaceConfig', () => {
  const NESTED = {
    'go.mod': 'module example.com/root\n',
    'svc/go.mod': 'module example.com/svc\n',
    'svc/main.go': 'package main\n',
    // Declares no module: not a module root, the files stay the root's.
    'broken/go.mod': 'go 1.21\n',
    'go.work': 'use (\n\t./svc\n\t../outside\n\t/abs\n\t.\n)\n',
  };

  it.each<[string, Readonly<Record<string, string>>, GoWorkspaceConfig | null]>([
    [
      'every go.mod and go.work, sorted, with in-repo uses only',
      NESTED,
      {
        modules: [
          { modulePath: 'example.com/root', dir: '' },
          { modulePath: 'example.com/svc', dir: 'svc' },
        ],
        workFiles: [{ dir: '', use: ['', 'svc'] }],
      },
    ],
    ['nothing when no go.mod declares a module', { 'main.go': 'package main\n' }, null],
  ])('captures %s', async (_case, files, expected) => {
    const dir = fixture(files);
    // Reversed: the result must not depend on listing order.
    const paths = Object.keys(files).reverse();
    expect(await captureGoWorkspaceConfig(dir, paths)).toEqual(expected);
  });

  it('loads the same config standalone as analyze captures from the scan', async () => {
    const dir = fixture(NESTED);
    expect(await loadGoWorkspaceConfig(dir)).toEqual(
      await captureGoWorkspaceConfig(dir, Object.keys(NESTED)),
    );
  });

  // Manifests capture deliberately skips: each case lists `svc/go.mod` but
  // leaves it unreadable as a manifest, so only the root module is captured.
  const ROOT_ONLY: GoWorkspaceConfig = {
    modules: [{ modulePath: 'example.com/root', dir: '' }],
    workFiles: [],
  };
  it.each<[string, (dir: string) => void]>([
    [
      'a symlink, even to a real go.mod outside the repository',
      (dir) => {
        const outside = fixture({ 'go.mod': 'module example.com/outside\n' });
        fs.symlinkSync(path.join(outside, 'go.mod'), path.join(dir, 'svc/go.mod'));
      },
    ],
    [
      'a manifest over the source-file size cap',
      (dir) => {
        fs.writeFileSync(
          path.join(dir, 'svc/go.mod'),
          `module example.com/svc\n${'//\n'.repeat(4096)}`,
        );
        vi.stubEnv('GITNEXUS_MAX_FILE_SIZE', '1');
      },
    ],
    ['a directory named go.mod', (dir) => fs.mkdirSync(path.join(dir, 'svc/go.mod'))],
    ['a manifest gone since the scan listed it', () => undefined],
  ])('skips %s', async (_case, arrange) => {
    const dir = fixture({ 'go.mod': 'module example.com/root\n', 'svc/main.go': 'package main\n' });
    arrange(dir);
    expect(await captureGoWorkspaceConfig(dir, ['go.mod', 'svc/go.mod'])).toEqual(ROOT_ONLY);
  });

  // A module boundary that silently vanished would send its imports to the
  // wrong module, so a manifest that fails to read surfaces as an error.
  it('throws when a go.mod cannot be read', async () => {
    const dir = fixture({
      'go.mod': 'module example.com/root\n',
      'svc/go.mod': 'module example.com/svc\n',
    });
    const locked = path.join(dir, 'svc/go.mod');
    fs.chmodSync(locked, 0o000);
    try {
      await expect(captureGoWorkspaceConfig(dir, ['go.mod', 'svc/go.mod'])).rejects.toThrow(
        /EACCES/,
      );
    } finally {
      fs.chmodSync(locked, 0o644);
    }
  });

  it('throws when the standalone scan fails instead of reporting no modules', async () => {
    const dir = fixture({ 'go.mod': 'module example.com/root\n' });
    await expect(loadGoWorkspaceConfig(path.join(dir, 'go.mod'))).rejects.toThrow();
  });
});
