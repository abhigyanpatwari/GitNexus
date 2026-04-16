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

// ── Per-language strategy imports (from config files) ──────────────────
import { goPackageStrategy } from '../../src/core/ingestion/import-resolvers/configs/go.js';
import { kotlinJvmStrategy } from '../../src/core/ingestion/import-resolvers/configs/jvm.js';
import { pythonImportStrategy } from '../../src/core/ingestion/import-resolvers/configs/python.js';
import { csharpNamespaceStrategy } from '../../src/core/ingestion/import-resolvers/configs/csharp.js';
import { dartPackageStrategy } from '../../src/core/ingestion/import-resolvers/configs/dart.js';

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
    const shouldNotRun: ImportResolverStrategy = () => ({
      kind: 'files',
      files: ['should-not.ts'],
    });

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
// Per-language strategies — behavioral coverage
//
// The previous `typeof strategy === 'function'` assertions were tautological:
// TypeScript's `ImportResolverStrategy` type enforces the function shape at
// compile time, so those tests could never fail. Python and Dart already have
// deep behavioral tests below; Go / Kotlin / C# are covered here. The
// remaining strategies (Java, Rust, PHP, Swift, Ruby) are exercised via the
// per-language `createImportResolver(config)` smoke tests and the factory
// behavior suite, which together verify exports, wiring, and composition.
// ---------------------------------------------------------------------------

describe('goPackageStrategy', () => {
  it('resolves go.mod package imports to a package result with dirSuffix', () => {
    const files = ['cmd/server/main.go', 'cmd/server/handler.go'];
    const ctx = makeCtx(files);
    ctx.configs.goModule = { modulePath: 'example.com/app' };

    const result = goPackageStrategy('example.com/app/cmd/server', 'main.go', ctx);
    // `kind: 'package'` + `dirSuffix` is unique to goPackageStrategy — the
    // standard strategy always returns `kind: 'files'`. Asserting this shape
    // makes config-level strategy ordering observable via the full-chain test
    // in `goImportConfig` below.
    expect(result?.kind).toBe('package');
    expect(result?.files).toEqual(expect.arrayContaining(files));
    if (result?.kind === 'package') {
      expect(result.dirSuffix).toContain('cmd/server');
    }
  });

  it('returns null for imports outside the go module (allows chain to continue)', () => {
    const ctx = makeCtx(['vendor/other/pkg/foo.go']);
    ctx.configs.goModule = { modulePath: 'example.com/app' };
    const result = goPackageStrategy('github.com/other/pkg', 'main.go', ctx);
    expect(result).toBeNull();
  });

  it('returns null when goModule is not configured', () => {
    const ctx = makeCtx(['cmd/server/main.go']);
    expect(ctx.configs.goModule).toBeNull();
    const result = goPackageStrategy('example.com/app/cmd/server', 'main.go', ctx);
    expect(result).toBeNull();
  });

  it('goImportConfig full chain produces the package-kind result (strategy-order guard)', () => {
    const files = ['cmd/server/main.go', 'cmd/server/handler.go'];
    const ctx = makeCtx(files);
    ctx.configs.goModule = { modulePath: 'example.com/app' };

    const resolver = createImportResolver(goImportConfig);
    const result = resolver('example.com/app/cmd/server', 'main.go', ctx);
    // If goPackageStrategy were moved after createStandardStrategy, the
    // standard strategy's suffix resolution would return a single file with
    // `kind: 'files'` (or null), not `kind: 'package'` with a dirSuffix.
    expect(result?.kind).toBe('package');
  });
});

describe('kotlinJvmStrategy', () => {
  it('resolves wildcard imports to files in the package directory', () => {
    const files = [
      'src/main/kotlin/com/example/foo/Bar.kt',
      'src/main/kotlin/com/example/foo/Baz.kt',
      'src/main/kotlin/com/example/other/Unrelated.kt',
    ];
    const ctx = makeCtx(files);

    const result = kotlinJvmStrategy('com.example.foo.*', 'App.kt', ctx);
    expect(result?.kind).toBe('files');
    expect(result?.files).toEqual(
      expect.arrayContaining([
        'src/main/kotlin/com/example/foo/Bar.kt',
        'src/main/kotlin/com/example/foo/Baz.kt',
      ]),
    );
    expect(result?.files).not.toContain('src/main/kotlin/com/example/other/Unrelated.kt');
  });

  it('returns null for wildcard with no matching files (allows chain to continue)', () => {
    const ctx = makeCtx(['src/main/kotlin/com/example/other/Foo.kt']);
    const result = kotlinJvmStrategy('com.example.missing.*', 'App.kt', ctx);
    expect(result).toBeNull();
  });

  it('kotlinImportConfig full chain resolves wildcard via the JVM strategy', () => {
    const files = ['src/main/kotlin/com/example/foo/Bar.kt'];
    const ctx = makeCtx(files);
    const resolver = createImportResolver(kotlinImportConfig);
    const result = resolver('com.example.foo.*', 'App.kt', ctx);
    // Standard strategy returns null for `.*` imports (see standard.ts:137),
    // so only kotlinJvmStrategy can produce this result.
    expect(result).toEqual({ kind: 'files', files });
  });
});

describe('csharpNamespaceStrategy', () => {
  it('resolves namespace imports via .csproj root-namespace mapping', () => {
    const files = ['src/Services/Auth/AuthService.cs', 'src/Services/Auth/TokenService.cs'];
    const ctx = makeCtx(files);
    ctx.configs.csharpConfigs = [{ rootNamespace: 'MyCo', projectDir: 'src' }];

    const result = csharpNamespaceStrategy('MyCo.Services.Auth', 'App.cs', ctx);
    // Multi-file namespace resolution produces `kind: 'package'` with
    // dirSuffix — unique to csharpNamespaceStrategy; the standard strategy
    // always emits `kind: 'files'`.
    expect(result?.kind).toBe('package');
    expect(result?.files).toEqual(expect.arrayContaining(files));
    if (result?.kind === 'package') {
      expect(result.dirSuffix).toContain('Services/Auth');
    }
  });

  it('returns null when no csharpConfigs are configured', () => {
    const ctx = makeCtx(['src/Services/Auth/AuthService.cs']);
    expect(ctx.configs.csharpConfigs).toEqual([]);
    const result = csharpNamespaceStrategy('MyCo.Services.Auth', 'App.cs', ctx);
    expect(result).toBeNull();
  });

  it('csharpImportConfig full chain produces package-kind (strategy-order guard)', () => {
    const files = ['src/Services/Auth/AuthService.cs', 'src/Services/Auth/TokenService.cs'];
    const ctx = makeCtx(files);
    ctx.configs.csharpConfigs = [{ rootNamespace: 'MyCo', projectDir: 'src' }];

    const resolver = createImportResolver(csharpImportConfig);
    const result = resolver('MyCo.Services.Auth', 'App.cs', ctx);
    // If csharpNamespaceStrategy were reordered after createStandardStrategy,
    // the result would be `kind: 'files'` (suffix match) or null, never
    // `kind: 'package'` with a dirSuffix.
    expect(result?.kind).toBe('package');
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
