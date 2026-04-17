/**
 * Unit tests for the production Dart import resolution strategies.
 *
 * Tests dartPackageStrategy and dartRelativeStrategy from configs/dart.ts —
 * the actual strategies composed by createImportResolver(dartImportConfig).
 *
 * Key behavioral note:
 * - dartPackageStrategy returns { kind: 'files', files: [] } (absorbing sentinel)
 *   for dart: SDK imports and unresolved external packages, which stops the
 *   strategy chain. This differs from the old monolithic resolver that returned null.
 *   Both produce zero import edges at runtime (applyImportResult treats them identically).
 */

import { describe, it, expect } from 'vitest';
import {
  dartPackageStrategy,
  dartRelativeStrategy,
} from '../../src/core/ingestion/import-resolvers/configs/dart.js';
import { createImportResolver } from '../../src/core/ingestion/import-resolvers/resolver-factory.js';
import { dartImportConfig } from '../../src/core/ingestion/import-resolvers/configs/dart.js';
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

// ---------------------------------------------------------------------------
// dartPackageStrategy — absorbs SDK / external package imports
// ---------------------------------------------------------------------------

describe('dartPackageStrategy', () => {
  describe('dart: SDK imports', () => {
    it('absorbs dart:async with empty-files sentinel', () => {
      const result = dartPackageStrategy("'dart:async'", 'lib/main.dart', makeCtx([]));
      expect(result).toEqual({ kind: 'files', files: [] });
    });

    it('absorbs dart:io with empty-files sentinel', () => {
      const result = dartPackageStrategy("'dart:io'", 'lib/main.dart', makeCtx([]));
      expect(result).toEqual({ kind: 'files', files: [] });
    });
  });

  describe('package: imports', () => {
    it('resolves local package import to lib/', () => {
      const ctx = makeCtx(['lib/models/user.dart', 'lib/main.dart']);
      const result = dartPackageStrategy("'package:my_app/models/user.dart'", 'lib/main.dart', ctx);
      expect(result).toEqual({ kind: 'files', files: ['lib/models/user.dart'] });
    });

    it('absorbs external package imports with empty-files sentinel', () => {
      const ctx = makeCtx(['lib/main.dart']);
      const result = dartPackageStrategy("'package:http/http.dart'", 'lib/main.dart', ctx);
      expect(result).toEqual({ kind: 'files', files: [] });
    });

    it('absorbs malformed package import (no slash) with empty-files sentinel', () => {
      const result = dartPackageStrategy("'package:http'", 'lib/main.dart', makeCtx([]));
      expect(result).toEqual({ kind: 'files', files: [] });
    });
  });

  describe('relative imports', () => {
    it('returns null for relative imports (chains to dartRelativeStrategy)', () => {
      const ctx = makeCtx([]);
      const result = dartPackageStrategy("'models.dart'", 'lib/main.dart', ctx);
      expect(result).toBeNull();
    });
  });

  describe('quote stripping', () => {
    it('strips single quotes', () => {
      const result = dartPackageStrategy("'dart:core'", 'lib/main.dart', makeCtx([]));
      // dart: is absorbed, proving quotes were stripped
      expect(result).toEqual({ kind: 'files', files: [] });
    });

    it('strips double quotes', () => {
      const result = dartPackageStrategy('"dart:core"', 'lib/main.dart', makeCtx([]));
      expect(result).toEqual({ kind: 'files', files: [] });
    });
  });
});

// ---------------------------------------------------------------------------
// dartRelativeStrategy — bare relative paths via standard resolution
// ---------------------------------------------------------------------------

describe('dartRelativeStrategy', () => {
  it('resolves bare relative path by prepending ./', () => {
    const ctx = makeCtx(['lib/models/user.dart', 'lib/main.dart']);
    const result = dartRelativeStrategy("'./models/user.dart'", 'lib/main.dart', ctx);
    expect(result).toEqual({ kind: 'files', files: ['lib/models/user.dart'] });
  });

  it('returns null for unresolvable relative import', () => {
    const ctx = makeCtx([]);
    const result = dartRelativeStrategy("'nonexistent.dart'", 'lib/main.dart', ctx);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full resolver — dartImportConfig composed via factory
// ---------------------------------------------------------------------------

describe('Dart import resolver (full config)', () => {
  const resolve = createImportResolver(dartImportConfig);

  it('absorbs dart: SDK imports', () => {
    const result = resolve("'dart:async'", 'lib/main.dart', makeCtx([]));
    expect(result).toEqual({ kind: 'files', files: [] });
  });

  it('resolves local package: import', () => {
    const ctx = makeCtx(['lib/models/user.dart']);
    const result = resolve("'package:my_app/models/user.dart'", 'lib/main.dart', ctx);
    expect(result).toEqual({ kind: 'files', files: ['lib/models/user.dart'] });
  });

  it('absorbs external package: import', () => {
    const ctx = makeCtx(['lib/main.dart']);
    const result = resolve("'package:http/http.dart'", 'lib/main.dart', ctx);
    expect(result).toEqual({ kind: 'files', files: [] });
  });

  it('resolves relative import via second strategy', () => {
    const ctx = makeCtx(['lib/models/user.dart', 'lib/main.dart']);
    const result = resolve("'./models/user.dart'", 'lib/main.dart', ctx);
    expect(result).toEqual({ kind: 'files', files: ['lib/models/user.dart'] });
  });
});
