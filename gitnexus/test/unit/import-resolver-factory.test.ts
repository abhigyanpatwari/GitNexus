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
import {
  javaJvmStrategy,
  kotlinJvmStrategy,
} from '../../src/core/ingestion/import-resolvers/configs/jvm.js';
import { pythonImportStrategy } from '../../src/core/ingestion/import-resolvers/configs/python.js';
import { csharpNamespaceStrategy } from '../../src/core/ingestion/import-resolvers/configs/csharp.js';
import { dartPackageStrategy } from '../../src/core/ingestion/import-resolvers/configs/dart.js';
import { rustModuleStrategy } from '../../src/core/ingestion/import-resolvers/configs/rust.js';
import { phpPsr4Strategy } from '../../src/core/ingestion/import-resolvers/configs/php.js';
import { swiftPackageStrategy } from '../../src/core/ingestion/import-resolvers/configs/swift.js';
import { rubyRequireStrategy } from '../../src/core/ingestion/import-resolvers/configs/ruby.js';

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

function makeCtx(files: string[], overrides: Partial<ResolveCtx['configs']> = {}): ResolveCtx {
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
      ...overrides,
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
// compile time, so those tests could never fail. Each strategy now has at
// least one behavioral assertion below; the Go and C# full-chain tests also
// double as strategy-order guards because their `kind: 'package'` output is
// unreachable through `createStandardStrategy`.
// ---------------------------------------------------------------------------

describe('goPackageStrategy', () => {
  it('resolves go.mod package imports to a package result with dirSuffix', () => {
    const files = ['cmd/server/main.go', 'cmd/server/handler.go'];
    const ctx = makeCtx(files, { goModule: { modulePath: 'example.com/app' } });

    const result = goPackageStrategy('example.com/app/cmd/server', 'main.go', ctx);
    // `kind: 'package'` + `dirSuffix` is unique to goPackageStrategy — the
    // standard strategy always returns `kind: 'files'`. Asserting the exact
    // shape makes format regressions observable (e.g. prefix/suffix slash
    // normalization) and makes strategy ordering observable via the
    // full-chain test in `goImportConfig` below.
    expect(result).toEqual({
      kind: 'package',
      files: expect.arrayContaining(files),
      dirSuffix: '/cmd/server/',
    });
  });

  it('returns null for imports outside the go module (allows chain to continue)', () => {
    const ctx = makeCtx(['vendor/other/pkg/foo.go'], {
      goModule: { modulePath: 'example.com/app' },
    });
    const result = goPackageStrategy('github.com/other/pkg', 'main.go', ctx);
    expect(result).toBeNull();
  });

  it('returns null when goModule is not configured', () => {
    const ctx = makeCtx(['cmd/server/main.go']);
    expect(ctx.configs.goModule).toBeNull();
    const result = goPackageStrategy('example.com/app/cmd/server', 'main.go', ctx);
    expect(result).toBeNull();
  });

  it('returns null when module prefix matches but package directory has no .go files', () => {
    // Documented fall-through in configs/go.ts:27 — when resolveGoPackageDir
    // returns non-null but resolveGoPackage returns an empty files list
    // (external module coincidentally sharing the prefix, or a subpackage with
    // no .go sources), the strategy returns null so the chain can continue.
    const ctx = makeCtx(['README.md', 'cmd/server/config.yaml'], {
      goModule: { modulePath: 'example.com/app' },
    });
    const result = goPackageStrategy('example.com/app/cmd/server', 'main.go', ctx);
    expect(result).toBeNull();
  });

  it('goImportConfig full chain produces the package-kind result (strategy-order guard)', () => {
    const files = ['cmd/server/main.go', 'cmd/server/handler.go'];
    const ctx = makeCtx(files, { goModule: { modulePath: 'example.com/app' } });

    const resolver = createImportResolver(goImportConfig);
    const result = resolver('example.com/app/cmd/server', 'main.go', ctx);
    // If goPackageStrategy were moved after createStandardStrategy, the
    // standard strategy's suffix resolution would return a single file with
    // `kind: 'files'` (or null), not `kind: 'package'` with a dirSuffix.
    // Asserting the full shape (not just kind) guards against a future
    // regression that emits `kind: 'package'` with mismatched files.
    expect(result).toEqual({
      kind: 'package',
      files: expect.arrayContaining(files),
      dirSuffix: '/cmd/server/',
    });
  });
});

describe('javaJvmStrategy', () => {
  it('resolves wildcard imports to .java files in the package directory', () => {
    const files = [
      'src/main/java/com/example/foo/Bar.java',
      'src/main/java/com/example/foo/Baz.java',
      'src/main/java/com/example/other/Unrelated.java',
    ];
    const ctx = makeCtx(files);
    const result = javaJvmStrategy('com.example.foo.*', 'App.java', ctx);
    expect(result?.kind).toBe('files');
    expect(result?.files).toEqual(
      expect.arrayContaining([
        'src/main/java/com/example/foo/Bar.java',
        'src/main/java/com/example/foo/Baz.java',
      ]),
    );
    expect(result?.files).not.toContain('src/main/java/com/example/other/Unrelated.java');
  });

  it('resolves member imports to the owning class file', () => {
    const files = ['src/main/java/com/example/Constants.java'];
    const ctx = makeCtx(files);
    // JVM member import: last segment is an ALL_CAPS constant / lowercase
    // member; resolver walks back to the class path `com/example/Constants`.
    const result = javaJvmStrategy('com.example.Constants.VALUE', 'App.java', ctx);
    expect(result).toEqual({ kind: 'files', files });
  });

  it('returns null when no matching .java files exist', () => {
    const ctx = makeCtx(['src/main/java/other/Foo.java']);
    const result = javaJvmStrategy('com.example.missing.*', 'App.java', ctx);
    expect(result).toBeNull();
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

  it('resolves member imports to the owning class file', () => {
    const files = ['src/main/kotlin/com/example/Constants.kt'];
    const ctx = makeCtx(files);
    const result = kotlinJvmStrategy('com.example.Constants.VALUE', 'App.kt', ctx);
    expect(result).toEqual({ kind: 'files', files });
  });

  it('returns null for wildcard with no matching files (allows chain to continue)', () => {
    const ctx = makeCtx(['src/main/kotlin/com/example/other/Foo.kt']);
    const result = kotlinJvmStrategy('com.example.missing.*', 'App.kt', ctx);
    expect(result).toBeNull();
  });

  it('kotlinImportConfig full chain resolves wildcard via the JVM strategy', () => {
    // Note: this is a behavioral smoke test, NOT a strategy-order guard.
    // `createStandardStrategy(Kotlin)` explicitly returns null for any import
    // ending in `.*` (see standard.ts:137), so reordering `kotlinImportConfig`
    // strategies would still produce the same result — the standard strategy
    // would return null and the chain would fall through to kotlinJvmStrategy
    // regardless of position. A genuine ordering guard for Kotlin would need
    // a non-wildcard fixture where both strategies resolve to different files.
    const files = ['src/main/kotlin/com/example/foo/Bar.kt'];
    const ctx = makeCtx(files);
    const resolver = createImportResolver(kotlinImportConfig);
    const result = resolver('com.example.foo.*', 'App.kt', ctx);
    expect(result).toEqual({ kind: 'files', files });
  });
});

describe('rustModuleStrategy', () => {
  it('resolves scoped grouped imports to per-item files', () => {
    const files = ['src/models/User.rs', 'src/models/Repo.rs'];
    const ctx = makeCtx(files);
    // `use crate::models::{User, Repo}` — the strategy resolves each item
    // individually against the allFilePaths set via resolveRustImportInternal.
    const result = rustModuleStrategy('crate::models::{User, Repo}', 'src/lib.rs', ctx);
    // Exact file discovery depends on resolveRustImportInternal's search
    // heuristics; we assert the shape + that at least one item resolved.
    expect(result?.kind).toBe('files');
    expect(result?.files.length).toBeGreaterThan(0);
  });

  it('returns null for non-grouped imports (delegates to standard fallback)', () => {
    const ctx = makeCtx(['src/models.rs']);
    // Plain `use crate::models` — rustModuleStrategy only handles grouped
    // forms; standard strategy handles the crate:: -> path translation.
    const result = rustModuleStrategy('crate::models', 'src/lib.rs', ctx);
    expect(result).toBeNull();
  });
});

describe('csharpNamespaceStrategy', () => {
  it('resolves namespace imports via .csproj root-namespace mapping', () => {
    const files = ['src/Services/Auth/AuthService.cs', 'src/Services/Auth/TokenService.cs'];
    const ctx = makeCtx(files, {
      csharpConfigs: [{ rootNamespace: 'MyCo', projectDir: 'src' }],
    });

    const result = csharpNamespaceStrategy('MyCo.Services.Auth', 'App.cs', ctx);
    // Multi-file namespace resolution produces `kind: 'package'` with
    // dirSuffix — unique to csharpNamespaceStrategy; the standard strategy
    // always emits `kind: 'files'`. Asserting the full shape (including the
    // exact dirSuffix format) guards against format regressions.
    expect(result).toEqual({
      kind: 'package',
      files: expect.arrayContaining(files),
      dirSuffix: '/src/Services/Auth/',
    });
  });

  it('returns null when no csharpConfigs are configured', () => {
    const ctx = makeCtx(['src/Services/Auth/AuthService.cs']);
    expect(ctx.configs.csharpConfigs).toEqual([]);
    const result = csharpNamespaceStrategy('MyCo.Services.Auth', 'App.cs', ctx);
    expect(result).toBeNull();
  });

  it('csharpImportConfig full chain produces package-kind (strategy-order guard)', () => {
    const files = ['src/Services/Auth/AuthService.cs', 'src/Services/Auth/TokenService.cs'];
    const ctx = makeCtx(files, {
      csharpConfigs: [{ rootNamespace: 'MyCo', projectDir: 'src' }],
    });

    const resolver = createImportResolver(csharpImportConfig);
    const result = resolver('MyCo.Services.Auth', 'App.cs', ctx);
    // If csharpNamespaceStrategy were reordered after createStandardStrategy,
    // the result would be `kind: 'files'` (suffix match) or null, never
    // `kind: 'package'` with a dirSuffix. Asserting the full shape (not just
    // kind) guards against a regression that emits `kind: 'package'` with
    // mismatched files.
    expect(result).toEqual({
      kind: 'package',
      files: expect.arrayContaining(files),
      dirSuffix: '/src/Services/Auth/',
    });
  });
});

describe('phpPsr4Strategy', () => {
  it('resolves PSR-4 namespace imports via composer.json autoload map', () => {
    const files = ['app/Services/UserService.php'];
    const ctx = makeCtx(files, {
      composerConfig: {
        psr4: new Map([['App\\', 'app/']]),
      },
    });
    const result = phpPsr4Strategy('App\\Services\\UserService', 'index.php', ctx);
    expect(result).toEqual({ kind: 'files', files });
  });

  it('returns null when no file matches the namespace via PSR-4 or suffix fallback', () => {
    const ctx = makeCtx(['app/Services/OtherService.php'], {
      composerConfig: { psr4: new Map([['App\\', 'app/']]) },
    });
    const result = phpPsr4Strategy('App\\Services\\UserService', 'index.php', ctx);
    expect(result).toBeNull();
  });
});

describe('swiftPackageStrategy', () => {
  it('resolves SwiftPM target imports to files in the target directory', () => {
    const files = [
      'Package/Sources/SiuperModel/Foo.swift',
      'Package/Sources/SiuperModel/Bar.swift',
      'Package/Sources/Other/Unrelated.swift',
    ];
    const ctx = makeCtx(files, {
      swiftPackageConfig: {
        targets: new Map([['SiuperModel', 'Package/Sources/SiuperModel']]),
      },
    });
    const result = swiftPackageStrategy('SiuperModel', 'App.swift', ctx);
    expect(result?.kind).toBe('files');
    expect(result?.files).toEqual(
      expect.arrayContaining([
        'Package/Sources/SiuperModel/Foo.swift',
        'Package/Sources/SiuperModel/Bar.swift',
      ]),
    );
    expect(result?.files).not.toContain('Package/Sources/Other/Unrelated.swift');
  });

  it('returns null for unknown targets (external frameworks like Foundation)', () => {
    const ctx = makeCtx(['Package/Sources/SiuperModel/Foo.swift'], {
      swiftPackageConfig: {
        targets: new Map([['SiuperModel', 'Package/Sources/SiuperModel']]),
      },
    });
    const result = swiftPackageStrategy('Foundation', 'App.swift', ctx);
    expect(result).toBeNull();
  });
});

describe('rubyRequireStrategy', () => {
  it('resolves require_relative paths via suffix matching', () => {
    const files = ['lib/models/user.rb'];
    const ctx = makeCtx(files);
    const result = rubyRequireStrategy('./models/user', 'lib/app.rb', ctx);
    expect(result).toEqual({ kind: 'files', files });
  });

  it('returns null when no file matches the require path', () => {
    const ctx = makeCtx(['lib/models/user.rb']);
    const result = rubyRequireStrategy('./missing/file', 'lib/app.rb', ctx);
    expect(result).toBeNull();
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

  it('absorbs unresolved external dotted imports instead of suffix-matching local basename files', () => {
    const ctx = makeCtx(['accounts/apps.py', 'billing/apps.py']);
    const result = pythonImportStrategy('django.apps', 'accounts/apps.py', ctx);
    expect(result).toEqual({ kind: 'files', files: [] });
  });

  it('absorbs unresolved nested external dotted imports like django.urls and django.core.*', () => {
    const ctx = makeCtx(['config/asgi.py', 'config/urls.py', 'config/wsgi.py']);

    expect(pythonImportStrategy('django.urls', 'config/urls.py', ctx)).toEqual({
      kind: 'files',
      files: [],
    });
    expect(pythonImportStrategy('django.core.asgi', 'config/asgi.py', ctx)).toEqual({
      kind: 'files',
      files: [],
    });
    expect(pythonImportStrategy('django.core.wsgi', 'config/wsgi.py', ctx)).toEqual({
      kind: 'files',
      files: [],
    });
  });

  it('keeps dotted internal imports unresolved here when the leading package exists in-repo', () => {
    const ctx = makeCtx(['accounts/models.py', 'billing/models.py']);
    const result = pythonImportStrategy('accounts.models', 'billing/models.py', ctx);
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
