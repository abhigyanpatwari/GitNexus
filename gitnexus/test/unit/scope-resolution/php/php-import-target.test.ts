import type { ParsedFile, ParsedImport, SymbolDefinition } from 'gitnexus-shared';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadComposerConfig,
  type ComposerConfig,
} from '../../../../src/core/ingestion/language-config.js';
import {
  loadPhpComposerConfig,
  resolvePhpImportTargetInternal,
} from '../../../../src/core/ingestion/languages/php/import-target.js';

const composerConfig: ComposerConfig = { psr4: new Map([['App', 'app']]) };

function parsedFile(filePath: string, definitions: readonly SymbolDefinition[]): ParsedFile {
  return { filePath, localDefs: definitions } as ParsedFile;
}

function definition(
  filePath: string,
  type: SymbolDefinition['type'],
  name: string,
): SymbolDefinition {
  return {
    nodeId: `def:${filePath}:${type}:${name}`,
    filePath,
    type,
    qualifiedName: name,
  };
}

const functionImport: ParsedImport = {
  kind: 'named',
  localName: 'getUser',
  importedName: 'getUser',
  targetRaw: 'App\\Models\\getUser',
  importedSymbolKind: 'function',
};

describe('resolvePhpImportTargetInternal declaration selection', () => {
  it('rejects namespaces outside an authoritative PSR-4 map', () => {
    const files = new Set(['app/Models/User.php', 'lib/Legacy/Missing.php']);

    expect(
      resolvePhpImportTargetInternal(
        'Vendor\\Ghost\\Missing',
        'app/Main.php',
        files,
        composerConfig,
      ),
    ).toBeNull();
    expect(
      resolvePhpImportTargetInternal('App\\Models\\User', 'app/Main.php', files, composerConfig),
    ).toBe('app/Models/User.php');
  });

  it('rejects ambiguous function and constant declaration fallbacks', () => {
    const first = 'app/Ghost/First.php';
    const second = 'app/Ghost/Second.php';
    const parsedFiles = [
      parsedFile(first, [
        definition(first, 'Function', 'missing'),
        definition(first, 'Variable', 'MISSING'),
      ]),
      parsedFile(second, [
        definition(second, 'Function', 'missing'),
        definition(second, 'Variable', 'MISSING'),
      ]),
    ];
    const files = new Set(parsedFiles.map((parsed) => parsed.filePath));

    for (const [name, importedSymbolKind] of [
      ['missing', 'function'],
      ['MISSING', 'const'],
    ] as const) {
      const parsedImport: ParsedImport = {
        kind: 'named',
        localName: name,
        importedName: name,
        targetRaw: `App\\Ghost\\${name}`,
        importedSymbolKind,
      };

      expect(
        resolvePhpImportTargetInternal(
          parsedImport.targetRaw,
          'app/Main.php',
          files,
          composerConfig,
          { parsedFiles, parsedImport },
        ),
      ).toBeNull();
    }
  });

  it('preserves suffix fallback without authoritative namespace evidence', () => {
    const files = new Set(['lib/Legacy/Missing.php']);
    const importPath = 'Vendor\\Ghost\\Missing';

    expect(resolvePhpImportTargetInternal(importPath, 'app/Main.php', files)).toBe(
      'lib/Legacy/Missing.php',
    );
    expect(
      resolvePhpImportTargetInternal(importPath, 'app/Main.php', files, { psr4: new Map() }),
    ).toBe('lib/Legacy/Missing.php');
    expect(
      resolvePhpImportTargetInternal(importPath, 'app/Main.php', files, {
        psr4: new Map([['', 'src']]),
      }),
    ).toBeNull();
    expect(
      resolvePhpImportTargetInternal(importPath, 'app/Main.php', files, {
        psr4: new Map([['App', 'app']]),
        hasUnmodeledAutoload: true,
      }),
    ).toBe('lib/Legacy/Missing.php');
  });

  it('resolves catch-all PSR-4 class and function imports inside the configured root', () => {
    const user = '/repo/src/Vendor/Models/User.php';
    const helpers = '/repo/src/Vendor/Models/helpers.php';
    const parsedFiles = [
      parsedFile(user, [definition(user, 'Class', 'Vendor\\Models\\User')]),
      parsedFile(helpers, [definition(helpers, 'Function', 'Vendor\\Models\\findUser')]),
    ];
    const config: ComposerConfig = { psr4: new Map([['', '/repo/src']]) };
    const files = new Set(parsedFiles.map((parsed) => parsed.filePath));

    expect(
      resolvePhpImportTargetInternal('Vendor\\Models\\User', '/repo/app/Main.php', files, config),
    ).toBe(user);

    const parsedImport: ParsedImport = {
      kind: 'named',
      localName: 'findUser',
      importedName: 'findUser',
      targetRaw: 'Vendor\\Models\\findUser',
      importedSymbolKind: 'function',
    };
    expect(
      resolvePhpImportTargetInternal(parsedImport.targetRaw, '/repo/app/Main.php', files, config, {
        parsedFiles,
        parsedImport,
      }),
    ).toBe(helpers);
  });

  it('does not suffix-resolve outside an authoritative catch-all directory', () => {
    const decoy = '/repo/legacy/Vendor/Ghost/Missing.php';
    expect(
      resolvePhpImportTargetInternal(
        'Vendor\\Ghost\\Missing',
        '/repo/app/Main.php',
        new Set([decoy]),
        { psr4: new Map([['', '/repo/src']]) },
      ),
    ).toBeNull();
  });

  it('loads production and development PSR-4 mappings', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gitnexus-php-composer-'));
    try {
      writeFileSync(
        join(repo, 'composer.json'),
        JSON.stringify({
          autoload: { 'psr-4': { 'App\\': 'app\\' }, classmap: ['legacy/'] },
          'autoload-dev': { 'psr-4': { 'Tests\\': ['tests/', 'fallback-tests/'] } },
        }),
      );

      const config = loadPhpComposerConfig(repo);
      expect([...(config?.psr4.entries() ?? [])]).toEqual([
        ['App', 'app'],
        ['Tests', 'tests'],
      ]);
      expect(config?.hasUnmodeledAutoload).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps both Composer config loaders conservative for unmodeled autoload entries', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gitnexus-php-composer-shared-'));
    try {
      writeFileSync(
        join(repo, 'composer.json'),
        JSON.stringify({
          autoload: {
            'psr-4': { 'App\\': ['app/', 'fallback-app/'] },
            files: ['src/helpers.php'],
          },
        }),
      );

      const config = await loadComposerConfig(repo);
      expect([...(config?.psr4.entries() ?? [])]).toEqual([['App', 'app']]);
      expect(config?.hasUnmodeledAutoload).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('finds a unique function declaration when the symbol name is not a filename', () => {
    const user = '/repo/app/Models/User.php';
    const factory = '/repo/app/Models/UserFactory.php';
    const parsedFiles = [
      parsedFile(user, [definition(user, 'Class', 'User')]),
      parsedFile(factory, [definition(factory, 'Function', 'getUser')]),
    ];

    expect(
      resolvePhpImportTargetInternal(
        functionImport.targetRaw,
        '/repo/app/Main.php',
        new Set(parsedFiles.map((parsed) => parsed.filePath)),
        composerConfig,
        { parsedFiles, parsedImport: functionImport },
      ),
    ).toBe(factory);
  });

  it('reuses directory selection without leaking candidates across namespaces', () => {
    const models = '/repo/app/Models/functions.php';
    const services = '/repo/app/Services/functions.php';
    const parsedFiles = [
      parsedFile(models, [definition(models, 'Function', 'getUser')]),
      parsedFile(services, [definition(services, 'Function', 'getUser')]),
    ];

    const first = resolvePhpImportTargetInternal(
      functionImport.targetRaw,
      '/repo/app/Main.php',
      new Set(parsedFiles.map((parsed) => parsed.filePath)),
      composerConfig,
      { parsedFiles, parsedImport: functionImport },
    );
    const second = resolvePhpImportTargetInternal(
      functionImport.targetRaw,
      '/repo/app/Main.php',
      new Set(parsedFiles.map((parsed) => parsed.filePath)),
      composerConfig,
      { parsedFiles, parsedImport: functionImport },
    );

    expect(first).toBe(models);
    expect(second).toBe(models);
  });

  it('fails closed when the namespace has duplicate function declarations', () => {
    const first = '/repo/app/Models/First.php';
    const second = '/repo/app/Models/Second.php';
    const parsedFiles = [
      parsedFile(first, [definition(first, 'Function', 'getUser')]),
      parsedFile(second, [definition(second, 'Function', 'getUser')]),
    ];

    expect(
      resolvePhpImportTargetInternal(
        functionImport.targetRaw,
        '/repo/app/Main.php',
        new Set(parsedFiles.map((parsed) => parsed.filePath)),
        composerConfig,
        { parsedFiles, parsedImport: functionImport },
      ),
    ).toBeNull();
  });

  it('never resolves into a different root that shares a directory suffix', () => {
    const app = '/repo/app/Models/functions.php';
    const vendor = '/repo/vendor/pkg/app/Models/helpers.php';
    const parsedFiles = [
      parsedFile(app, []),
      parsedFile(vendor, [definition(vendor, 'Function', 'getUser')]),
    ];

    const result = resolvePhpImportTargetInternal(
      functionImport.targetRaw,
      '/repo/app/Main.php',
      new Set(parsedFiles.map((parsed) => parsed.filePath)),
      composerConfig,
      { parsedFiles, parsedImport: functionImport },
    );

    expect(result).not.toBe(vendor);
  });

  it('stays out of suffix-colliding roots even when both declare the function', () => {
    const app = '/repo/app/Models/functions.php';
    const vendor = '/repo/vendor/pkg/app/Models/helpers.php';
    const parsedFiles = [
      parsedFile(app, [definition(app, 'Function', 'getUser')]),
      parsedFile(vendor, [definition(vendor, 'Function', 'getUser')]),
    ];

    const result = resolvePhpImportTargetInternal(
      functionImport.targetRaw,
      '/repo/app/Main.php',
      new Set(parsedFiles.map((parsed) => parsed.filePath)),
      composerConfig,
      { parsedFiles, parsedImport: functionImport },
    );

    expect(result).not.toBe(vendor);
  });

  it('resolves a constant only when its namespace directory has one candidate file', () => {
    const constants = '/repo/app/Config/constants.php';
    const parsedFiles = [parsedFile(constants, [])];
    const parsedImport: ParsedImport = {
      kind: 'named',
      localName: 'MAX_RETRIES',
      importedName: 'MAX_RETRIES',
      targetRaw: 'App\\Config\\MAX_RETRIES',
      importedSymbolKind: 'const',
    };

    expect(
      resolvePhpImportTargetInternal(
        parsedImport.targetRaw,
        '/repo/app/Main.php',
        new Set([constants]),
        composerConfig,
        { parsedFiles, parsedImport },
      ),
    ).toBe(constants);
  });
});
