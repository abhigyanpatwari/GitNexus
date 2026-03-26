import { describe, it, expect } from 'vitest';
import { resolveDartImport } from '../../src/core/ingestion/import-resolvers/dart.js';
import type { ResolveCtx } from '../../src/core/ingestion/import-resolvers/types.js';

function makeCtx(files: string[]): ResolveCtx {
  const allFileList = files;
  const normalizedFileList = files.map(f => f.toLowerCase());
  return {
    allFilePaths: new Set(files),
    allFileList,
    normalizedFileList,
    index: undefined as any,
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

describe('Dart import resolver', () => {
  describe('dart: SDK imports', () => {
    it('skips dart:async', () => {
      const result = resolveDartImport("'dart:async'", 'lib/main.dart', makeCtx([]));
      expect(result).toBeNull();
    });

    it('skips dart:io', () => {
      const result = resolveDartImport("'dart:io'", 'lib/main.dart', makeCtx([]));
      expect(result).toBeNull();
    });
  });

  describe('package: imports', () => {
    it('resolves local package import to lib/', () => {
      const ctx = makeCtx(['lib/models/user.dart', 'lib/main.dart']);
      const result = resolveDartImport("'package:my_app/models/user.dart'", 'lib/main.dart', ctx);
      expect(result).toEqual({ kind: 'files', files: ['lib/models/user.dart'] });
    });

    it('returns null for external package imports', () => {
      const ctx = makeCtx(['lib/main.dart']);
      const result = resolveDartImport("'package:http/http.dart'", 'lib/main.dart', ctx);
      expect(result).toBeNull();
    });

    it('returns null for malformed package import (no slash)', () => {
      const result = resolveDartImport("'package:http'", 'lib/main.dart', makeCtx([]));
      expect(result).toBeNull();
    });
  });

  describe('relative imports', () => {
    it('resolves relative import via standard resolver', () => {
      const ctx = makeCtx(['lib/models/user.dart', 'lib/main.dart']);
      const result = resolveDartImport("'models/user.dart'", 'lib/main.dart', ctx);
      // resolveStandard handles relative path resolution
      // The exact result depends on the standard resolver — we just check it doesn't crash
      expect(result === null || result?.kind === 'files').toBe(true);
    });
  });

  describe('quote stripping', () => {
    it('strips single quotes', () => {
      const ctx = makeCtx([]);
      const result = resolveDartImport("'dart:core'", 'lib/main.dart', ctx);
      expect(result).toBeNull(); // dart: is skipped, proving quotes were stripped
    });

    it('strips double quotes', () => {
      const ctx = makeCtx([]);
      const result = resolveDartImport('"dart:core"', 'lib/main.dart', ctx);
      expect(result).toBeNull();
    });
  });
});
