/**
 * Unit tests for the import resolver factory and per-strategy composition.
 *
 * Validates that:
 * - createImportResolver chains strategies in order
 * - First non-null result wins
 * - Empty files array stops the chain (absorbing sentinel)
 * - All per-language configs produce valid resolvers
 */

import { describe, it, expect } from 'vitest';
import { createImportResolver } from '../../src/core/ingestion/import-resolvers/resolver-factory.js';
import { createStandardStrategy } from '../../src/core/ingestion/import-resolvers/standard.js';
import type {
  ImportResolutionConfig,
  ImportResolverStrategy,
  ResolveCtx,
} from '../../src/core/ingestion/import-resolvers/types.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildSuffixIndex } from '../../src/core/ingestion/import-resolvers/utils.js';

// ── Per-language strategy imports ──────────────────────────────────────
import { goPackageStrategy } from '../../src/core/ingestion/import-resolvers/go.js';
import {
  javaJvmStrategy,
  kotlinJvmStrategy,
} from '../../src/core/ingestion/import-resolvers/jvm.js';
import { rustModuleStrategy } from '../../src/core/ingestion/import-resolvers/rust.js';
import { pythonImportStrategy } from '../../src/core/ingestion/import-resolvers/python.js';
import { csharpNamespaceStrategy } from '../../src/core/ingestion/import-resolvers/csharp.js';
import { phpPsr4Strategy } from '../../src/core/ingestion/import-resolvers/php.js';
import { swiftPackageStrategy } from '../../src/core/ingestion/import-resolvers/swift.js';
import {
  dartPackageStrategy,
  dartRelativeStrategy,
} from '../../src/core/ingestion/import-resolvers/dart.js';
import { rubyRequireStrategy } from '../../src/core/ingestion/import-resolvers/ruby.js';

// ── Per-language config imports ────────────────────────────────────────
import {
  typescriptImportConfig,
  javascriptImportConfig,
  vueImportConfig,
} from '../../src/core/ingestion/import-resolvers/configs/typescript-javascript.js';
import {
  cImportConfig,
  cppImportConfig,
} from '../../src/core/ingestion/import-resolvers/configs/c-cpp.js';
import { goImportConfig } from '../../src/core/ingestion/import-resolvers/configs/go.js';
import {
  javaImportConfig,
  kotlinImportConfig,
} from '../../src/core/ingestion/import-resolvers/configs/jvm.js';
import { pythonImportConfig } from '../../src/core/ingestion/import-resolvers/configs/python.js';
import { rustImportConfig } from '../../src/core/ingestion/import-resolvers/configs/rust.js';
import { csharpImportConfig } from '../../src/core/ingestion/import-resolvers/configs/csharp.js';
import { phpImportConfig } from '../../src/core/ingestion/import-resolvers/configs/php.js';
import { swiftImportConfig } from '../../src/core/ingestion/import-resolvers/configs/swift.js';
import { dartImportConfig } from '../../src/core/ingestion/import-resolvers/configs/dart.js';
import { rubyImportConfig } from '../../src/core/ingestion/import-resolvers/configs/ruby.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(files: string[]): ResolveCtx {
  const allFileList = files;
  const normalizedFileList = files.map((p) => p.replace(/\\/g, '/'));
  const allFilePaths = new Set(allFileList);
  const index = buildSuffixIndex(normalizedFileList, allFileList);
  return {
    allFilePaths,
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
// createImportResolver — factory behavior
// ---------------------------------------------------------------------------

describe('createImportResolver', () => {
  it('returns null when no strategies match', () => {
    const config: ImportResolutionConfig = {
      language: SupportedLanguages.TypeScript,
      strategies: [],
    };
    const resolver = createImportResolver(config);
    expect(resolver('./foo', 'src/index.ts', makeCtx([]))).toBeNull();
  });

  it('returns first non-null result from strategy chain', () => {
    const strategyA: ImportResolverStrategy = () => null;
    const strategyB: ImportResolverStrategy = () => ({ kind: 'files', files: ['b.ts'] });
    const strategyC: ImportResolverStrategy = () => ({ kind: 'files', files: ['c.ts'] });

    const resolver = createImportResolver({
      language: SupportedLanguages.TypeScript,
      strategies: [strategyA, strategyB, strategyC],
    });

    const result = resolver('./foo', 'src/index.ts', makeCtx(['b.ts', 'c.ts']));
    expect(result).toEqual({ kind: 'files', files: ['b.ts'] });
  });

  it('stops chain when strategy returns result with empty files (absorbing sentinel)', () => {
    const absorber: ImportResolverStrategy = () => ({ kind: 'files', files: [] });
    const shouldNotRun: ImportResolverStrategy = () => ({ kind: 'files', files: ['should-not.ts'] });

    const resolver = createImportResolver({
      language: SupportedLanguages.TypeScript,
      strategies: [absorber, shouldNotRun],
    });

    const result = resolver('./foo', 'src/index.ts', makeCtx([]));
    expect(result).toEqual({ kind: 'files', files: [] });
  });

  it('passes correct arguments to strategies', () => {
    const ctx = makeCtx(['src/utils.ts']);
    const captured: { raw: string; fp: string }[] = [];

    const spy: ImportResolverStrategy = (raw, fp) => {
      captured.push({ raw, fp });
      return null;
    };

    const resolver = createImportResolver({
      language: SupportedLanguages.TypeScript,
      strategies: [spy],
    });

    resolver('./utils', 'src/index.ts', ctx);
    expect(captured).toEqual([{ raw: './utils', fp: 'src/index.ts' }]);
  });
});

// ---------------------------------------------------------------------------
// Per-language strategies — exported and callable
// ---------------------------------------------------------------------------

describe('per-language strategy exports', () => {
  it('goPackageStrategy is a function', () => {
    expect(typeof goPackageStrategy).toBe('function');
  });

  it('javaJvmStrategy is a function', () => {
    expect(typeof javaJvmStrategy).toBe('function');
  });

  it('kotlinJvmStrategy is a function', () => {
    expect(typeof kotlinJvmStrategy).toBe('function');
  });

  it('rustModuleStrategy is a function', () => {
    expect(typeof rustModuleStrategy).toBe('function');
  });

  it('pythonImportStrategy is a function', () => {
    expect(typeof pythonImportStrategy).toBe('function');
  });

  it('csharpNamespaceStrategy is a function', () => {
    expect(typeof csharpNamespaceStrategy).toBe('function');
  });

  it('phpPsr4Strategy is a function', () => {
    expect(typeof phpPsr4Strategy).toBe('function');
  });

  it('swiftPackageStrategy is a function', () => {
    expect(typeof swiftPackageStrategy).toBe('function');
  });

  it('dartPackageStrategy is a function', () => {
    expect(typeof dartPackageStrategy).toBe('function');
  });

  it('dartRelativeStrategy is a function', () => {
    expect(typeof dartRelativeStrategy).toBe('function');
  });

  it('rubyRequireStrategy is a function', () => {
    expect(typeof rubyRequireStrategy).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Per-language configs — all construct cleanly
// ---------------------------------------------------------------------------

describe('per-language import configs', () => {
  const configs: { name: string; config: ImportResolutionConfig }[] = [
    { name: 'TypeScript', config: typescriptImportConfig },
    { name: 'JavaScript', config: javascriptImportConfig },
    { name: 'Vue', config: vueImportConfig },
    { name: 'C', config: cImportConfig },
    { name: 'C++', config: cppImportConfig },
    { name: 'Go', config: goImportConfig },
    { name: 'Java', config: javaImportConfig },
    { name: 'Kotlin', config: kotlinImportConfig },
    { name: 'Python', config: pythonImportConfig },
    { name: 'Rust', config: rustImportConfig },
    { name: 'C#', config: csharpImportConfig },
    { name: 'PHP', config: phpImportConfig },
    { name: 'Swift', config: swiftImportConfig },
    { name: 'Dart', config: dartImportConfig },
    { name: 'Ruby', config: rubyImportConfig },
  ];

  for (const { name, config } of configs) {
    it(`${name} config has strategies and constructs a resolver`, () => {
      expect(config.strategies.length).toBeGreaterThan(0);
      expect(() => createImportResolver(config)).not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// createStandardStrategy — reusable across languages
// ---------------------------------------------------------------------------

describe('createStandardStrategy', () => {
  it('creates a reusable strategy from a language', () => {
    const strategy = createStandardStrategy(SupportedLanguages.TypeScript);
    expect(typeof strategy).toBe('function');
  });

  it('resolves relative imports', () => {
    const strategy = createStandardStrategy(SupportedLanguages.TypeScript);
    const ctx = makeCtx(['src/utils.ts']);
    const result = strategy('./utils', 'src/index.ts', ctx);
    expect(result).toEqual({ kind: 'files', files: ['src/utils.ts'] });
  });

  it('returns null for unresolvable imports', () => {
    const strategy = createStandardStrategy(SupportedLanguages.TypeScript);
    const ctx = makeCtx([]);
    const result = strategy('./nonexistent', 'src/index.ts', ctx);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Python strategy — absorbs unresolved relative imports
// ---------------------------------------------------------------------------

describe('pythonImportStrategy', () => {
  it('absorbs unresolved relative imports with empty-files sentinel', () => {
    const ctx = makeCtx([]);
    const result = pythonImportStrategy('.nonexistent', 'src/app.py', ctx);
    expect(result).toEqual({ kind: 'files', files: [] });
  });

  it('returns null for non-relative imports (allows chain to continue)', () => {
    const ctx = makeCtx([]);
    const result = pythonImportStrategy('os', 'src/app.py', ctx);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dart strategies — absorbs SDK / external package imports
// ---------------------------------------------------------------------------

describe('dartPackageStrategy', () => {
  it('absorbs dart: SDK imports', () => {
    const ctx = makeCtx([]);
    const result = dartPackageStrategy("'dart:async'", 'lib/main.dart', ctx);
    expect(result).toEqual({ kind: 'files', files: [] });
  });

  it('absorbs external package: imports', () => {
    const ctx = makeCtx([]);
    const result = dartPackageStrategy("'package:http/http.dart'", 'lib/main.dart', ctx);
    expect(result).toEqual({ kind: 'files', files: [] });
  });

  it('returns null for relative imports (chains to dartRelativeStrategy)', () => {
    const ctx = makeCtx([]);
    const result = dartPackageStrategy("'models.dart'", 'lib/main.dart', ctx);
    expect(result).toBeNull();
  });
});
