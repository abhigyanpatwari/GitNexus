/**
 * Unit tests for the GDScript import resolution strategy.
 *
 * GDScript imports come from `preload("res://...")` / `load("res://...")`
 * calls. The strategy strips the `res://` prefix and looks the remaining
 * path up in the repository's file set.
 */

import { describe, it, expect } from 'vitest';
import { createImportResolver } from '../../src/core/ingestion/import-resolvers/resolver-factory.js';
import { gdscriptImportConfig } from '../../src/core/ingestion/import-resolvers/configs/gdscript.js';
import type { ResolveCtx } from '../../src/core/ingestion/import-resolvers/types.js';
import { buildSuffixIndex } from '../../src/core/ingestion/import-resolvers/utils.js';

function makeCtx(files: string[]): ResolveCtx {
  const allFileList = files;
  const normalizedFileList = files.map((f) => f.replace(/\\/g, '/'));
  const index = buildSuffixIndex(normalizedFileList, allFileList);
  return {
    allFilePaths: new Set(files),
    allFileList,
    normalizedFileList,
    index,
    resolveCache: new Map(),
    configs: {
      tsconfigPaths: null,
      goModule: null,
      composerConfig: null,
      swiftPackageConfig: null,
      csharpConfigs: [],
    },
  };
}

describe('GDScript import resolver', () => {
  const resolve = createImportResolver(gdscriptImportConfig);

  it('resolves a res:// path that matches a repo-relative file', () => {
    const ctx = makeCtx(['player.gd', 'main.gd', 'hud.gd']);
    expect(resolve('res://player.gd', 'main.gd', ctx)).toEqual({
      kind: 'files',
      files: ['player.gd'],
    });
  });

  it('resolves a res:// path inside a subdirectory', () => {
    const ctx = makeCtx(['characters/player.gd', 'main.gd']);
    expect(resolve('res://characters/player.gd', 'main.gd', ctx)).toEqual({
      kind: 'files',
      files: ['characters/player.gd'],
    });
  });

  it('also resolves res:// paths pointing at scene files', () => {
    const ctx = makeCtx(['player.tscn', 'main.gd']);
    expect(resolve('res://player.tscn', 'main.gd', ctx)).toEqual({
      kind: 'files',
      files: ['player.tscn'],
    });
  });

  it('returns null for a res:// path that does not match any file', () => {
    const ctx = makeCtx(['player.gd']);
    expect(resolve('res://missing.gd', 'main.gd', ctx)).toBeNull();
  });

  it('returns null for import paths that do not start with res://', () => {
    const ctx = makeCtx(['player.gd']);
    expect(resolve('player.gd', 'main.gd', ctx)).toBeNull();
    expect(resolve('./player.gd', 'main.gd', ctx)).toBeNull();
  });
});
