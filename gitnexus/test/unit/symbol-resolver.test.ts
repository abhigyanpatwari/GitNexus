import { describe, it, expect, beforeEach } from 'vitest';
import {
  createResolutionContext,
  type ResolutionContext,
} from '../../src/core/ingestion/model/resolution-context.js';
import { createSymbolTable } from '../../src/core/ingestion/model/symbol-table.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { isFileInPackageDir } from '../../src/core/ingestion/model/resolution-context.js';

/** Helper: resolve to single best definition (refuses ambiguous global) */
const resolveOne = (ctx: ResolutionContext, name: string, fromFile: string) => {
  const tiered = ctx.resolve(name, fromFile);
  if (!tiered) return null;
  if (tiered.tier === 'global' && tiered.candidates.length !== 1) return null;
  return tiered.candidates[0];
};

/** Helper: resolve with tier metadata (refuses ambiguous global) */
const resolveInternal = (ctx: ResolutionContext, name: string, fromFile: string) => {
  const tiered = ctx.resolve(name, fromFile);
  if (!tiered) return null;
  if (tiered.tier === 'global' && tiered.candidates.length !== 1) return null;
  return {
    definition: tiered.candidates[0],
    tier: tiered.tier,
    candidateCount: tiered.candidates.length,
  };
};

describe('ResolutionContext.resolve — resolveSymbol compatibility', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  describe('Tier 1: Same-file resolution', () => {
    it('resolves symbol defined in the same file', () => {
      ctx.model.symbols.add('src/models/user.ts', 'User', 'Class:src/models/user.ts:User', 'Class');

      const result = resolveOne(ctx, 'User', 'src/models/user.ts');

      expect(result).not.toBeNull();
      expect(result!.nodeId).toBe('Class:src/models/user.ts:User');
      expect(result!.filePath).toBe('src/models/user.ts');
      expect(result!.type).toBe('Class');
    });

    it('prefers same-file over imported definition', () => {
      ctx.model.symbols.add('src/local.ts', 'Config', 'Class:src/local.ts:Config', 'Class');
      ctx.model.symbols.add('src/shared.ts', 'Config', 'Class:src/shared.ts:Config', 'Class');
      ctx.importMap.set('src/local.ts', new Set(['src/shared.ts']));

      const result = resolveOne(ctx, 'Config', 'src/local.ts');

      expect(result!.nodeId).toBe('Class:src/local.ts:Config');
      expect(result!.filePath).toBe('src/local.ts');
    });
  });

  describe('Tier 2: Import-scoped resolution', () => {
    it('resolves symbol from an imported file', () => {
      ctx.model.symbols.add(
        'src/services/auth.ts',
        'AuthService',
        'Class:src/services/auth.ts:AuthService',
        'Class',
      );
      ctx.importMap.set('src/controllers/login.ts', new Set(['src/services/auth.ts']));

      const result = resolveOne(ctx, 'AuthService', 'src/controllers/login.ts');

      expect(result).not.toBeNull();
      expect(result!.nodeId).toBe('Class:src/services/auth.ts:AuthService');
      expect(result!.filePath).toBe('src/services/auth.ts');
    });

    it('prefers imported definition over non-imported with same name', () => {
      ctx.model.symbols.add(
        'src/services/logger.ts',
        'Logger',
        'Class:src/services/logger.ts:Logger',
        'Class',
      );
      ctx.model.symbols.add(
        'src/testing/mock-logger.ts',
        'Logger',
        'Class:src/testing/mock-logger.ts:Logger',
        'Class',
      );
      ctx.importMap.set('src/app.ts', new Set(['src/services/logger.ts']));

      const result = resolveOne(ctx, 'Logger', 'src/app.ts');

      expect(result!.nodeId).toBe('Class:src/services/logger.ts:Logger');
      expect(result!.filePath).toBe('src/services/logger.ts');
    });

    it('handles file with no imports — unique global falls through', () => {
      ctx.model.symbols.add('src/utils.ts', 'Helper', 'Class:src/utils.ts:Helper', 'Class');

      const result = resolveOne(ctx, 'Helper', 'src/app.ts');

      expect(result).not.toBeNull();
      expect(result!.nodeId).toBe('Class:src/utils.ts:Helper');
    });
  });

  describe('Tier 3: Global resolution', () => {
    it('resolves unique global when not in imports', () => {
      ctx.model.symbols.add(
        'src/external/base.ts',
        'BaseModel',
        'Class:src/external/base.ts:BaseModel',
        'Class',
      );
      ctx.importMap.set('src/app.ts', new Set(['src/other.ts']));

      const result = resolveOne(ctx, 'BaseModel', 'src/app.ts');

      expect(result).not.toBeNull();
      expect(result!.nodeId).toBe('Class:src/external/base.ts:BaseModel');
    });

    it('refuses ambiguous global — returns null when multiple candidates exist', () => {
      ctx.model.symbols.add('src/a.ts', 'Config', 'Class:src/a.ts:Config', 'Class');
      ctx.model.symbols.add('src/b.ts', 'Config', 'Class:src/b.ts:Config', 'Class');

      const result = resolveOne(ctx, 'Config', 'src/other.ts');

      expect(result).toBeNull();
    });

    it('ctx.resolve returns all candidates at global tier (consumers decide)', () => {
      ctx.model.symbols.add('src/a.ts', 'Config', 'Class:src/a.ts:Config', 'Class');
      ctx.model.symbols.add('src/b.ts', 'Config', 'Class:src/b.ts:Config', 'Class');

      const tiered = ctx.resolve('Config', 'src/other.ts');

      expect(tiered).not.toBeNull();
      expect(tiered!.tier).toBe('global');
      expect(tiered!.candidates.length).toBe(2);
    });
  });

  describe('null cases', () => {
    it('returns null for unknown symbol', () => {
      const result = resolveOne(ctx, 'NonExistent', 'src/app.ts');
      expect(result).toBeNull();
    });

    it('returns null when symbol table is empty', () => {
      const result = resolveOne(ctx, 'Anything', 'src/app.ts');
      expect(result).toBeNull();
    });
  });

  describe('type preservation', () => {
    it('preserves Interface type for heritage resolution', () => {
      ctx.model.symbols.add(
        'src/interfaces.ts',
        'ILogger',
        'Interface:src/interfaces.ts:ILogger',
        'Interface',
      );
      ctx.importMap.set('src/app.ts', new Set(['src/interfaces.ts']));

      const result = resolveOne(ctx, 'ILogger', 'src/app.ts');

      expect(result!.type).toBe('Interface');
    });

    it('preserves Class type for heritage resolution', () => {
      ctx.model.symbols.add('src/base.ts', 'BaseService', 'Class:src/base.ts:BaseService', 'Class');
      ctx.importMap.set('src/app.ts', new Set(['src/base.ts']));

      const result = resolveOne(ctx, 'BaseService', 'src/app.ts');

      expect(result!.type).toBe('Class');
    });
  });

  describe('heritage-specific scenarios', () => {
    it('resolves C# interface vs class ambiguity via imports', () => {
      ctx.model.symbols.add(
        'src/logging/ilogger.cs',
        'ILogger',
        'Interface:src/logging/ilogger.cs:ILogger',
        'Interface',
      );
      ctx.model.symbols.add(
        'src/testing/ilogger.cs',
        'ILogger',
        'Class:src/testing/ilogger.cs:ILogger',
        'Class',
      );
      ctx.importMap.set('src/services/auth.cs', new Set(['src/logging/ilogger.cs']));

      const result = resolveOne(ctx, 'ILogger', 'src/services/auth.cs');

      expect(result!.type).toBe('Interface');
      expect(result!.filePath).toBe('src/logging/ilogger.cs');
    });

    it('resolves parent class from imported file for extends', () => {
      ctx.model.symbols.add(
        'src/api/controller.ts',
        'UserController',
        'Class:src/api/controller.ts:UserController',
        'Class',
      );
      ctx.model.symbols.add(
        'src/base/controller.ts',
        'BaseController',
        'Class:src/base/controller.ts:BaseController',
        'Class',
      );
      ctx.importMap.set('src/api/controller.ts', new Set(['src/base/controller.ts']));

      const result = resolveOne(ctx, 'BaseController', 'src/api/controller.ts');

      expect(result!.nodeId).toBe('Class:src/base/controller.ts:BaseController');
    });
  });
});

describe('ResolutionContext.resolve — tier metadata', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('returns same-file tier for Tier 1 match', () => {
    ctx.model.symbols.add('src/a.ts', 'Foo', 'Class:src/a.ts:Foo', 'Class');

    const result = resolveInternal(ctx, 'Foo', 'src/a.ts');

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('same-file');
    expect(result!.candidateCount).toBe(1);
    expect(result!.definition.nodeId).toBe('Class:src/a.ts:Foo');
  });

  it('returns import-scoped tier for Tier 2 match', () => {
    ctx.model.symbols.add('src/logger.ts', 'Logger', 'Class:src/logger.ts:Logger', 'Class');
    ctx.model.symbols.add('src/mock.ts', 'Logger', 'Class:src/mock.ts:Logger', 'Class');
    ctx.importMap.set('src/app.ts', new Set(['src/logger.ts']));

    const result = resolveInternal(ctx, 'Logger', 'src/app.ts');

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('import-scoped');
  });

  it('returns global tier for Tier 3 match', () => {
    ctx.model.symbols.add('src/only.ts', 'Singleton', 'Class:src/only.ts:Singleton', 'Class');

    const result = resolveInternal(ctx, 'Singleton', 'src/other.ts');

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('global');
    expect(result!.candidateCount).toBe(1);
  });

  it('returns null for ambiguous global — refuses to guess', () => {
    ctx.model.symbols.add('src/a.ts', 'Config', 'Class:src/a.ts:Config', 'Class');
    ctx.model.symbols.add('src/b.ts', 'Config', 'Class:src/b.ts:Config', 'Class');

    const result = resolveInternal(ctx, 'Config', 'src/other.ts');

    expect(result).toBeNull();
  });

  it('returns null for unknown symbol', () => {
    const result = resolveInternal(ctx, 'Ghost', 'src/any.ts');
    expect(result).toBeNull();
  });

  it('Tier 1 wins over Tier 2 — same-file takes priority', () => {
    ctx.model.symbols.add('src/app.ts', 'Util', 'Function:src/app.ts:Util', 'Function');
    ctx.model.symbols.add('src/lib.ts', 'Util', 'Function:src/lib.ts:Util', 'Function');
    ctx.importMap.set('src/app.ts', new Set(['src/lib.ts']));

    const result = resolveInternal(ctx, 'Util', 'src/app.ts');

    expect(result!.tier).toBe('same-file');
    expect(result!.definition.filePath).toBe('src/app.ts');
  });
});

describe('negative tests — ambiguous refusal per language family', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('TS/JS: two Logger definitions with no import → returns null', () => {
    ctx.model.symbols.add(
      'src/services/logger.ts',
      'Logger',
      'Class:src/services/logger.ts:Logger',
      'Class',
    );
    ctx.model.symbols.add(
      'src/testing/logger.ts',
      'Logger',
      'Class:src/testing/logger.ts:Logger',
      'Class',
    );

    const result = resolveOne(ctx, 'Logger', 'src/app.ts');
    expect(result).toBeNull();
  });

  it('Java: same-named class in different packages, no import → returns null', () => {
    ctx.model.symbols.add(
      'com/example/models/User.java',
      'User',
      'Class:com/example/models/User.java:User',
      'Class',
    );
    ctx.model.symbols.add(
      'com/example/dto/User.java',
      'User',
      'Class:com/example/dto/User.java:User',
      'Class',
    );

    const result = resolveOne(ctx, 'User', 'com/example/services/UserService.java');
    expect(result).toBeNull();
  });

  it('C/C++: type defined in transitively-included header → returns null (not reachable via direct import)', () => {
    ctx.model.symbols.add('src/c.h', 'Widget', 'Struct:src/c.h:Widget', 'Struct');
    ctx.model.symbols.add('src/d.h', 'Widget', 'Struct:src/d.h:Widget', 'Struct');
    ctx.importMap.set('src/a.c', new Set(['src/b.h']));

    const result = resolveOne(ctx, 'Widget', 'src/a.c');
    expect(result).toBeNull();
  });

  it('C#: two IService interfaces in different namespaces, no import → returns null', () => {
    ctx.model.symbols.add(
      'src/Services/IService.cs',
      'IService',
      'Interface:src/Services/IService.cs:IService',
      'Interface',
    );
    ctx.model.symbols.add(
      'src/Testing/IService.cs',
      'IService',
      'Interface:src/Testing/IService.cs:IService',
      'Interface',
    );

    const result = resolveOne(ctx, 'IService', 'src/App.cs');
    expect(result).toBeNull();
  });
});

describe('heritage false-positive guard', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('null from resolve prevents false edge — generateId fallback produces synthetic ID, not wrong match', () => {
    ctx.model.symbols.add(
      'src/api/base.ts',
      'BaseController',
      'Class:src/api/base.ts:BaseController',
      'Class',
    );
    ctx.model.symbols.add(
      'src/testing/base.ts',
      'BaseController',
      'Class:src/testing/base.ts:BaseController',
      'Class',
    );

    const result = resolveOne(ctx, 'BaseController', 'src/routes/admin.ts');
    expect(result).toBeNull();

    ctx.importMap.set('src/routes/admin.ts', new Set(['src/api/base.ts']));
    const resolved = resolveOne(ctx, 'BaseController', 'src/routes/admin.ts');
    expect(resolved).not.toBeNull();
    expect(resolved!.filePath).toBe('src/api/base.ts');
  });
});

// These two describe blocks (`lookupExactFull` and `SM-16: SymbolTable.getFiles()`)
// intentionally use `createSymbolTable()` directly instead of going through
// `createSemanticModel()`. The behaviors under test belong to the pure DAG
// leaf — file/callable indexes, getFiles iterator — and do not involve the
// owner-scoped registries. Testing them on the bare leaf keeps the unit
// isolated. Do not migrate these blocks to createSemanticModel() "for
// consistency" — that would add unused registry setup and weaken the
// isolation property.
describe('lookupExactFull', () => {
  it('returns full SymbolDefinition for same-file lookup via O(1) direct storage', () => {
    const symbolTable = createSymbolTable();
    symbolTable.add('src/models/user.ts', 'User', 'Class:src/models/user.ts:User', 'Class');

    const result = symbolTable.lookupExactFull('src/models/user.ts', 'User');

    expect(result).not.toBeUndefined();
    expect(result!.nodeId).toBe('Class:src/models/user.ts:User');
    expect(result!.filePath).toBe('src/models/user.ts');
    expect(result!.type).toBe('Class');
  });

  it('returns undefined for non-existent symbol', () => {
    const symbolTable = createSymbolTable();
    const result = symbolTable.lookupExactFull('src/app.ts', 'NonExistent');
    expect(result).toBeUndefined();
  });

  it('returns undefined for wrong file', () => {
    const symbolTable = createSymbolTable();
    symbolTable.add('src/a.ts', 'Foo', 'Class:src/a.ts:Foo', 'Class');

    const result = symbolTable.lookupExactFull('src/b.ts', 'Foo');
    expect(result).toBeUndefined();
  });

  it('preserves optional callable metadata on stored definitions', () => {
    const symbolTable = createSymbolTable();
    symbolTable.add('src/math.ts', 'sum', 'Function:src/math.ts:sum', 'Function', {
      parameterCount: 2,
    });

    const fromExact = symbolTable.lookupExactFull('src/math.ts', 'sum');
    const fromCallable = symbolTable.lookupCallableByName('sum')[0];

    expect(fromExact?.parameterCount).toBe(2);
    expect(fromCallable.parameterCount).toBe(2);
  });
});

describe('isFileInPackageDir', () => {
  it('matches file directly in the package directory', () => {
    expect(isFileInPackageDir('internal/auth/handler.go', '/internal/auth/')).toBe(true);
  });

  it('matches with leading path segments', () => {
    expect(isFileInPackageDir('myrepo/internal/auth/handler.go', '/internal/auth/')).toBe(true);
    expect(
      isFileInPackageDir('src/github.com/user/repo/internal/auth/handler.go', '/internal/auth/'),
    ).toBe(true);
  });

  it('rejects files in subdirectories', () => {
    expect(isFileInPackageDir('internal/auth/middleware/jwt.go', '/internal/auth/')).toBe(false);
  });

  it('matches any file extension in the directory', () => {
    expect(isFileInPackageDir('internal/auth/README.md', '/internal/auth/')).toBe(true);
    expect(isFileInPackageDir('Models/User.cs', '/Models/')).toBe(true);
    expect(isFileInPackageDir('internal/auth/handler_test.go', '/internal/auth/')).toBe(true);
  });

  it('rejects files not in the package', () => {
    expect(isFileInPackageDir('internal/db/connection.go', '/internal/auth/')).toBe(false);
  });

  it('handles backslash paths (Windows)', () => {
    expect(isFileInPackageDir('internal\\auth\\handler.go', '/internal/auth/')).toBe(true);
  });

  it('matches C# namespace directories', () => {
    expect(isFileInPackageDir('MyProject/Models/User.cs', '/MyProject/Models/')).toBe(true);
    expect(isFileInPackageDir('MyProject/Models/Order.cs', '/MyProject/Models/')).toBe(true);
    expect(isFileInPackageDir('MyProject/Models/Sub/Nested.cs', '/MyProject/Models/')).toBe(false);
  });
});

describe('Tier 2b: PackageMap resolution (Go)', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('resolves symbol via PackageMap when not in ImportMap', () => {
    ctx.model.symbols.add(
      'internal/auth/handler.go',
      'HandleLogin',
      'Function:internal/auth/handler.go:HandleLogin',
      'Function',
    );
    ctx.packageMap.set('cmd/server/main.go', new Set(['/internal/auth/']));

    const result = ctx.resolve('HandleLogin', 'cmd/server/main.go');

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates[0].filePath).toBe('internal/auth/handler.go');
  });

  it('does not resolve symbol from wrong package', () => {
    ctx.model.symbols.add(
      'internal/db/connection.go',
      'Connect',
      'Function:internal/db/connection.go:Connect',
      'Function',
    );
    ctx.packageMap.set('cmd/server/main.go', new Set(['/internal/auth/']));

    const result = ctx.resolve('Connect', 'cmd/server/main.go');

    // Not in imported package, single global def → global tier
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('global');
  });

  it('Tier 2a (ImportMap) takes precedence over Tier 2b (PackageMap)', () => {
    ctx.model.symbols.add(
      'internal/auth/handler.go',
      'Validate',
      'Function:internal/auth/handler.go:Validate',
      'Function',
    );
    ctx.model.symbols.add(
      'internal/db/validator.go',
      'Validate',
      'Function:internal/db/validator.go:Validate',
      'Function',
    );

    ctx.importMap.set('cmd/server/main.go', new Set(['internal/db/validator.go']));
    ctx.packageMap.set('cmd/server/main.go', new Set(['/internal/auth/']));

    const result = ctx.resolve('Validate', 'cmd/server/main.go');

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates[0].filePath).toBe('internal/db/validator.go');
  });

  it('resolves both symbols in same imported package', () => {
    ctx.model.symbols.add(
      'internal/auth/handler.go',
      'Run',
      'Function:internal/auth/handler.go:Run',
      'Function',
    );
    ctx.model.symbols.add(
      'internal/auth/worker.go',
      'Run',
      'Function:internal/auth/worker.go:Run',
      'Function',
    );
    ctx.packageMap.set('cmd/main.go', new Set(['/internal/auth/']));

    const result = ctx.resolve('Run', 'cmd/main.go');

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates.length).toBe(2);
  });

  it('returns global without packageMap when ambiguous', () => {
    ctx.model.symbols.add(
      'internal/auth/handler.go',
      'X',
      'Function:internal/auth/handler.go:X',
      'Function',
    );
    ctx.model.symbols.add(
      'internal/db/handler.go',
      'X',
      'Function:internal/db/handler.go:X',
      'Function',
    );

    const result = resolveInternal(ctx, 'X', 'cmd/main.go');

    // No import or package match, 2 candidates → ambiguous → null
    expect(result).toBeNull();
  });
});

describe('per-file cache', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('caches results per file', () => {
    ctx.model.symbols.add('src/a.ts', 'Foo', 'Class:src/a.ts:Foo', 'Class');

    ctx.enableCache('src/a.ts');
    const r1 = ctx.resolve('Foo', 'src/a.ts');
    const r2 = ctx.resolve('Foo', 'src/a.ts');
    ctx.clearCache();

    // Same object reference from cache
    expect(r1).toBe(r2);
    expect(ctx.getStats().cacheHits).toBe(1);
    expect(ctx.getStats().cacheMisses).toBe(1);
  });

  it('resolve works without cache enabled', () => {
    ctx.model.symbols.add('src/a.ts', 'Foo', 'Class:src/a.ts:Foo', 'Class');

    const result = ctx.resolve('Foo', 'src/a.ts');

    expect(result).not.toBeNull();
    expect(result!.candidates[0].nodeId).toBe('Class:src/a.ts:Foo');
    expect(ctx.getStats().cacheHits).toBe(0);
  });

  it('cache does not leak across files', () => {
    ctx.model.symbols.add('src/a.ts', 'Foo', 'Class:src/a.ts:Foo', 'Class');

    ctx.enableCache('src/a.ts');
    ctx.resolve('Foo', 'src/a.ts'); // cached for a.ts

    // Resolve from different file — should NOT use cache
    const r = ctx.resolve('Foo', 'src/b.ts');
    ctx.clearCache();

    // Foo is not in src/b.ts, so same-file fails. Falls to global with 1 candidate.
    expect(r!.tier).toBe('global');
  });
});

// Tier 2a uses importMap (file-level imports). Go resolves cross-package symbols
// via packageMap (Tier 2b) instead, so no Go Tier 2a test is needed. Kotlin and
// PHP support file-level imports but the importMap path is language-agnostic —
// the existing TS/Java/Python/C# fixtures prove correctness at the infra level.
describe('SM-16: Tier 2a — iterate importedFiles with lookupExactAll', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('collects definitions from all imported files', () => {
    ctx.model.symbols.add('src/a.ts', 'Widget', 'Class:src/a.ts:Widget', 'Class');
    ctx.model.symbols.add('src/b.ts', 'Widget', 'Class:src/b.ts:Widget', 'Class');
    ctx.importMap.set('src/app.ts', new Set(['src/a.ts', 'src/b.ts']));

    const result = ctx.resolve('Widget', 'src/app.ts');

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates.length).toBe(2);
    expect(result!.candidates.map((c) => c.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('skips files with no matching symbol — no false positives', () => {
    ctx.model.symbols.add('src/a.ts', 'Widget', 'Class:src/a.ts:Widget', 'Class');
    ctx.model.symbols.add('src/b.ts', 'Button', 'Class:src/b.ts:Button', 'Class');
    ctx.importMap.set('src/app.ts', new Set(['src/a.ts', 'src/b.ts']));

    const result = ctx.resolve('Widget', 'src/app.ts');

    expect(result!.candidates.length).toBe(1);
    expect(result!.candidates[0].filePath).toBe('src/a.ts');
  });

  it('returns all overloads from a single imported file', () => {
    // Same-name method overloads in one file
    ctx.model.symbols.add('src/math.ts', 'add', 'fn:math:add:0', 'Function', { parameterCount: 1 });
    ctx.model.symbols.add('src/math.ts', 'add', 'fn:math:add:2', 'Function', { parameterCount: 2 });
    ctx.importMap.set('src/app.ts', new Set(['src/math.ts']));

    const result = ctx.resolve('add', 'src/app.ts');

    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates.length).toBe(2);
  });

  it('Java: resolves class from import via lookupExactAll per file', () => {
    ctx.model.symbols.add(
      'com/example/models/User.java',
      'User',
      'Class:com/example/models/User.java:User',
      'Class',
    );
    ctx.importMap.set(
      'com/example/services/UserService.java',
      new Set(['com/example/models/User.java']),
    );

    const result = ctx.resolve('User', 'com/example/services/UserService.java');

    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates[0].filePath).toBe('com/example/models/User.java');
  });

  it('Python: resolves function from imported module file', () => {
    ctx.model.symbols.add('models.py', 'User', 'Class:models.py:User', 'Class');
    ctx.importMap.set('app.py', new Set(['models.py']));

    const result = ctx.resolve('User', 'app.py');

    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates[0].filePath).toBe('models.py');
  });

  it('C#: resolves interface from imported file', () => {
    ctx.model.symbols.add(
      'src/Services/IService.cs',
      'IService',
      'Interface:src/Services/IService.cs:IService',
      'Interface',
    );
    ctx.importMap.set('src/Controllers/HomeController.cs', new Set(['src/Services/IService.cs']));

    const result = ctx.resolve('IService', 'src/Controllers/HomeController.cs');

    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates[0].type).toBe('Interface');
  });

  it('TypeScript: resolves re-exported class via named binding chain', () => {
    // index.ts re-exports User from models.ts
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.namedImportMap.set(
      'src/index.ts',
      new Map([['User', { sourcePath: 'src/models.ts', exportedName: 'User' }]]),
    );
    ctx.namedImportMap.set(
      'src/app.ts',
      new Map([['User', { sourcePath: 'src/index.ts', exportedName: 'User' }]]),
    );

    const result = ctx.resolve('User', 'src/app.ts');

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates[0].filePath).toBe('src/models.ts');
  });
});

describe('SM-16: Tier 2b — iterate getFiles() + isFileInPackageDir', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('Go: resolves symbol in package dir via file iteration', () => {
    ctx.model.symbols.add(
      'internal/auth/handler.go',
      'Authenticate',
      'Function:internal/auth/handler.go:Authenticate',
      'Function',
    );
    ctx.model.symbols.add(
      'internal/db/repo.go',
      'Authenticate',
      'Function:internal/db/repo.go:Authenticate',
      'Function',
    );
    ctx.packageMap.set('cmd/main.go', new Set(['/internal/auth/']));

    const result = ctx.resolve('Authenticate', 'cmd/main.go');

    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates.length).toBe(1);
    expect(result!.candidates[0].filePath).toBe('internal/auth/handler.go');
  });

  it('C#: resolves class from namespace directory', () => {
    ctx.model.symbols.add(
      'MyApp/Models/User.cs',
      'User',
      'Class:MyApp/Models/User.cs:User',
      'Class',
    );
    ctx.model.symbols.add('MyApp/Other/User.cs', 'User', 'Class:MyApp/Other/User.cs:User', 'Class');
    ctx.packageMap.set('MyApp/Controllers/UserController.cs', new Set(['/MyApp/Models/']));

    const result = ctx.resolve('User', 'MyApp/Controllers/UserController.cs');

    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates.length).toBe(1);
    expect(result!.candidates[0].filePath).toBe('MyApp/Models/User.cs');
  });

  it('Tier 2a (ImportMap) still takes precedence over Tier 2b (PackageMap)', () => {
    ctx.model.symbols.add(
      'internal/auth/handler.go',
      'Validate',
      'Function:internal/auth/handler.go:Validate',
      'Function',
    );
    ctx.model.symbols.add(
      'internal/db/validator.go',
      'Validate',
      'Function:internal/db/validator.go:Validate',
      'Function',
    );
    ctx.importMap.set('cmd/main.go', new Set(['internal/db/validator.go']));
    ctx.packageMap.set('cmd/main.go', new Set(['/internal/auth/']));

    const result = ctx.resolve('Validate', 'cmd/main.go');

    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates[0].filePath).toBe('internal/db/validator.go');
  });
});

describe('SM-16: Tier 3 global — lookupClassByName + lookupImplByName + lookupCallableByName', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('returns class-like symbol (Class) at global tier', () => {
    ctx.model.symbols.add('src/user.ts', 'User', 'Class:src/user.ts:User', 'Class');

    const result = ctx.resolve('User', 'src/app.ts');

    expect(result!.tier).toBe('global');
    expect(result!.candidates[0].type).toBe('Class');
  });

  it('returns callable symbol (Function) at global tier', () => {
    ctx.model.symbols.add(
      'src/utils.ts',
      'parseDate',
      'Function:src/utils.ts:parseDate',
      'Function',
    );

    const result = ctx.resolve('parseDate', 'src/app.ts');

    expect(result!.tier).toBe('global');
    expect(result!.candidates[0].type).toBe('Function');
  });

  it('returns both Class and Function with the same name at global tier', () => {
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/factories.ts', 'User', 'Function:src/factories.ts:User', 'Function');

    const result = ctx.resolve('User', 'src/app.ts');

    expect(result!.tier).toBe('global');
    expect(result!.candidates.length).toBe(2);
    const types = result!.candidates.map((c) => c.type).sort();
    expect(types).toEqual(['Class', 'Function']);
  });

  it('Rust: returns Impl node at global tier (needed for method resolution)', () => {
    ctx.model.symbols.add('src/user.rs', 'User', 'Struct:src/user.rs:User', 'Struct');
    ctx.model.symbols.add('src/user.rs', 'User', 'Impl:src/user.rs:User', 'Impl');

    const result = ctx.resolve('User', 'src/main.rs');

    expect(result!.tier).toBe('global');
    const types = result!.candidates.map((c) => c.type).sort();
    expect(types).toContain('Struct');
    expect(types).toContain('Impl');
  });

  it('Rust: Impl is separate from Class-like types — does not affect heritage (lookupClassByName)', () => {
    // SM-23 DAG: registry lookups go through SemanticModel; SymbolTable
    // is a pure leaf with no registry knowledge.
    const model = createSemanticModel();
    model.symbols.add('src/user.rs', 'User', 'Struct:src/user.rs:User', 'Struct');
    model.symbols.add('src/user.rs', 'User', 'Impl:src/user.rs:User', 'Impl');

    // lookupClassByName excludes Impl (preserves heritage resolution correctness)
    const classDefs = model.types.lookupClassByName('User');
    expect(classDefs.map((d) => d.type)).toEqual(['Struct']);

    // lookupImplByName returns only Impl nodes
    const implDefs = model.types.lookupImplByName('User');
    expect(implDefs.map((d) => d.type)).toEqual(['Impl']);
  });

  it('ambiguous global returns all candidates (consumers decide)', () => {
    ctx.model.symbols.add('src/a.ts', 'Config', 'Class:src/a.ts:Config', 'Class');
    ctx.model.symbols.add('src/b.ts', 'Config', 'Class:src/b.ts:Config', 'Class');

    const result = ctx.resolve('Config', 'src/other.ts');

    expect(result!.tier).toBe('global');
    expect(result!.candidates.length).toBe(2);
  });

  it('A4 intermediate: Method reachable via both callable and method indexes dedups to one Tier 3 candidate', () => {
    // A method with an owner lands in callableByName (because Method is
    // still in FREE_CALLABLE_TYPES during the Unit 3 intermediate state) AND in
    // methodsByName (because A4 Unit 2 dual-indexes every method
    // registration). Tier 3 must dedup by nodeId so consumers see each
    // method exactly once.
    ctx.model.symbols.add('src/user.ts', 'save', 'Method:src/user.ts:User.save', 'Method', {
      ownerId: 'Class:src/user.ts:User',
    });

    const result = ctx.resolve('save', 'src/app.ts');

    expect(result!.tier).toBe('global');
    const nodeIds = result!.candidates.map((c) => c.nodeId);
    expect(nodeIds).toEqual(['Method:src/user.ts:User.save']);
  });

  it('returns null when no symbol exists at any tier', () => {
    const result = ctx.resolve('NonExistent', 'src/app.ts');
    expect(result).toBeNull();
  });

  it('TypeScript: resolves Enum at global tier', () => {
    ctx.model.symbols.add('src/status.ts', 'Status', 'Enum:src/status.ts:Status', 'Enum');

    const result = ctx.resolve('Status', 'src/app.ts');

    expect(result!.tier).toBe('global');
    expect(result!.candidates[0].type).toBe('Enum');
  });

  it('Kotlin: resolves data class (Record) at global tier', () => {
    ctx.model.symbols.add('src/User.kt', 'User', 'Record:src/User.kt:User', 'Record');

    const result = ctx.resolve('User', 'src/Main.kt');

    expect(result!.tier).toBe('global');
    expect(result!.candidates[0].type).toBe('Record');
  });

  it('PHP: resolves Trait at global tier', () => {
    ctx.model.symbols.add(
      'src/Loggable.php',
      'Loggable',
      'Trait:src/Loggable.php:Loggable',
      'Trait',
    );

    const result = ctx.resolve('Loggable', 'src/App.php');

    expect(result!.tier).toBe('global');
    expect(result!.candidates[0].type).toBe('Trait');
  });

  it('Java: resolves Interface at global tier', () => {
    ctx.model.symbols.add(
      'com/example/IService.java',
      'IService',
      'Interface:com/example/IService.java:IService',
      'Interface',
    );

    const result = ctx.resolve('IService', 'com/example/ServiceImpl.java');

    expect(result!.tier).toBe('global');
    expect(result!.candidates[0].type).toBe('Interface');
  });

  it('Go: resolves Struct at global tier', () => {
    ctx.model.symbols.add(
      'internal/model/user.go',
      'User',
      'Struct:internal/model/user.go:User',
      'Struct',
    );

    const result = ctx.resolve('User', 'cmd/main.go');

    expect(result!.tier).toBe('global');
    expect(result!.candidates[0].type).toBe('Struct');
  });
});

describe('SM-16: SymbolTable.getFiles()', () => {
  it('returns all indexed file paths', () => {
    const table = createSymbolTable();
    table.add('src/a.ts', 'Foo', 'Class:a:Foo', 'Class');
    table.add('src/b.ts', 'Bar', 'Class:b:Bar', 'Class');
    table.add('src/c.ts', 'Baz', 'Function:c:Baz', 'Function');

    const files = [...table.getFiles()];
    expect(files.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('returns empty iterator for empty symbol table', () => {
    const table = createSymbolTable();
    const files = [...table.getFiles()];
    expect(files).toHaveLength(0);
  });

  it('does not duplicate files with multiple symbols', () => {
    const table = createSymbolTable();
    table.add('src/a.ts', 'Foo', 'Class:a:Foo', 'Class');
    table.add('src/a.ts', 'Bar', 'Class:a:Bar', 'Class');

    const files = [...table.getFiles()];
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('src/a.ts');
  });
});

describe('SM-16: walkBindingChain — no allDefs parameter', () => {
  it('resolves non-aliased import via lookupExactAll at depth=0', () => {
    const ctx = createResolutionContext();
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.namedImportMap.set(
      'src/app.ts',
      new Map([['User', { sourcePath: 'src/models.ts', exportedName: 'User' }]]),
    );

    const result = ctx.resolve('User', 'src/app.ts');

    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates[0].filePath).toBe('src/models.ts');
  });

  it('resolves aliased import (U → User) via chain walk', () => {
    const ctx = createResolutionContext();
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.namedImportMap.set(
      'src/app.ts',
      new Map([['U', { sourcePath: 'src/models.ts', exportedName: 'User' }]]),
    );

    const result = ctx.resolve('U', 'src/app.ts');

    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates[0].nodeId).toBe('Class:src/models.ts:User');
  });

  it('follows re-export chain A → B → C', () => {
    const ctx = createResolutionContext();
    ctx.model.symbols.add('src/models.ts', 'Widget', 'Class:src/models.ts:Widget', 'Class');
    // B re-exports Widget from C
    ctx.namedImportMap.set(
      'src/index.ts',
      new Map([['Widget', { sourcePath: 'src/models.ts', exportedName: 'Widget' }]]),
    );
    // A imports Widget from B
    ctx.namedImportMap.set(
      'src/app.ts',
      new Map([['Widget', { sourcePath: 'src/index.ts', exportedName: 'Widget' }]]),
    );

    const result = ctx.resolve('Widget', 'src/app.ts');

    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates[0].filePath).toBe('src/models.ts');
  });
});

// ── F1: Tier 3 TypeAlias/Const/Variable exclusion (documented intentional gap) ──

describe('SM-16: Tier 3 — TypeAlias, Const, Variable are NOT returned', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('TypeAlias is not reachable at Tier 3', () => {
    ctx.model.symbols.add('src/types.ts', 'Handler', 'TypeAlias:src/types.ts:Handler', 'TypeAlias');
    const result = ctx.resolve('Handler', 'src/app.ts');
    expect(result).toBeNull();
  });

  it('Const is not reachable at Tier 3', () => {
    ctx.model.symbols.add(
      'src/config.ts',
      'MAX_RETRIES',
      'Const:src/config.ts:MAX_RETRIES',
      'Const',
    );
    const result = ctx.resolve('MAX_RETRIES', 'src/app.ts');
    expect(result).toBeNull();
  });

  it('Variable is not reachable at Tier 3', () => {
    ctx.model.symbols.add('src/state.ts', 'counter', 'Variable:src/state.ts:counter', 'Variable');
    const result = ctx.resolve('counter', 'src/app.ts');
    expect(result).toBeNull();
  });

  it('Class-like and callable ARE reachable at Tier 3 (control)', () => {
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/utils.ts', 'getUser', 'Function:src/utils.ts:getUser', 'Function');

    const classResult = ctx.resolve('User', 'src/app.ts');
    expect(classResult).not.toBeNull();
    expect(classResult!.tier).toBe('global');

    const funcResult = ctx.resolve('getUser', 'src/app.ts');
    expect(funcResult).not.toBeNull();
    expect(funcResult!.tier).toBe('global');
  });

  it('Macro (C/C++) is reachable at Tier 3 via callable index', () => {
    ctx.model.symbols.add('src/macros.h', 'ASSERT', 'Macro:src/macros.h:ASSERT', 'Macro');
    const result = ctx.resolve('ASSERT', 'src/main.c');
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('global');
    expect(result!.candidates[0].type).toBe('Macro');
  });

  it('Delegate (C#) is reachable at Tier 3 via callable index', () => {
    ctx.model.symbols.add('src/Events.cs', 'OnClick', 'Delegate:src/Events.cs:OnClick', 'Delegate');
    const result = ctx.resolve('OnClick', 'src/App.cs');
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('global');
    expect(result!.candidates[0].type).toBe('Delegate');
  });
});

// ── packageDirIndex invalidation regression test ──

describe('SM-16: Tier 2b — packageDirIndex picks up symbols added after clear()', () => {
  it('resolves newly added symbol after clear() resets the index', () => {
    const ctx = createResolutionContext();
    // Initial setup: one symbol in package dir
    ctx.model.symbols.add('pkg/models/user.go', 'User', 'Struct:pkg/models/user.go:User', 'Struct');
    ctx.packageMap.set('cmd/main.go', new Set(['/pkg/models/']));

    // Prime the packageDirIndex via a Tier 2b resolution
    const first = ctx.resolve('User', 'cmd/main.go');
    expect(first!.tier).toBe('import-scoped');

    // Full reset (simulates pipeline re-run)
    ctx.clear();

    // Re-add symbols with a NEW file in the package dir
    ctx.model.symbols.add('pkg/models/user.go', 'User', 'Struct:pkg/models/user.go:User', 'Struct');
    ctx.model.symbols.add(
      'pkg/models/order.go',
      'Order',
      'Struct:pkg/models/order.go:Order',
      'Struct',
    );
    ctx.packageMap.set('cmd/main.go', new Set(['/pkg/models/']));

    // The new symbol must be visible — packageDirIndex was invalidated by clear()
    const second = ctx.resolve('Order', 'cmd/main.go');
    expect(second).not.toBeNull();
    expect(second!.tier).toBe('import-scoped');
    expect(second!.candidates[0].filePath).toBe('pkg/models/order.go');
  });
});

// ── F7: Tier 2b language fixtures — Rust, Kotlin, PHP ──

describe('SM-16: Tier 2b — Rust package-scoped resolution', () => {
  it('resolves struct in package dir via Tier 2b', () => {
    const ctx = createResolutionContext();
    ctx.model.symbols.add('src/models/user.rs', 'User', 'Struct:src/models/user.rs:User', 'Struct');
    ctx.model.symbols.add('src/other/user.rs', 'User', 'Struct:src/other/user.rs:User', 'Struct');
    ctx.packageMap.set('src/main.rs', new Set(['/src/models/']));

    const result = ctx.resolve('User', 'src/main.rs');
    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates.length).toBe(1);
    expect(result!.candidates[0].filePath).toBe('src/models/user.rs');
  });
});

describe('SM-16: Tier 2b — Kotlin package-scoped resolution', () => {
  it('resolves class in package dir via Tier 2b', () => {
    const ctx = createResolutionContext();
    ctx.model.symbols.add(
      'com/app/models/User.kt',
      'User',
      'Class:com/app/models/User.kt:User',
      'Class',
    );
    ctx.model.symbols.add(
      'com/app/other/User.kt',
      'User',
      'Class:com/app/other/User.kt:User',
      'Class',
    );
    ctx.packageMap.set('com/app/Main.kt', new Set(['/com/app/models/']));

    const result = ctx.resolve('User', 'com/app/Main.kt');
    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates.length).toBe(1);
    expect(result!.candidates[0].filePath).toBe('com/app/models/User.kt');
  });
});

describe('SM-16: Tier 2b — PHP namespace directory resolution', () => {
  it('resolves class in namespace dir via Tier 2b', () => {
    const ctx = createResolutionContext();
    ctx.model.symbols.add('app/Models/User.php', 'User', 'Class:app/Models/User.php:User', 'Class');
    ctx.model.symbols.add('app/Other/User.php', 'User', 'Class:app/Other/User.php:User', 'Class');
    ctx.packageMap.set('app/Controllers/UserController.php', new Set(['/app/Models/']));

    const result = ctx.resolve('User', 'app/Controllers/UserController.php');
    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates.length).toBe(1);
    expect(result!.candidates[0].filePath).toBe('app/Models/User.php');
  });
});
