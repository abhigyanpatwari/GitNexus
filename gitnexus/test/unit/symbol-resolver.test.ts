import { describe, it, expect, beforeEach } from 'vitest';
import {
  createResolutionContext,
  type ResolutionContext,
} from '../../src/core/ingestion/resolution-context.js';
import { createSymbolTable } from '../../src/core/ingestion/symbol-table.js';
import { isFileInPackageDir } from '../../src/core/ingestion/import-processor.js';

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
      ctx.symbols.add('src/models/user.ts', 'User', 'Class:src/models/user.ts:User', 'Class');

      const result = resolveOne(ctx, 'User', 'src/models/user.ts');

      expect(result).not.toBeNull();
      expect(result!.nodeId).toBe('Class:src/models/user.ts:User');
      expect(result!.filePath).toBe('src/models/user.ts');
      expect(result!.type).toBe('Class');
    });

    it('prefers same-file over imported definition', () => {
      ctx.symbols.add('src/local.ts', 'Config', 'Class:src/local.ts:Config', 'Class');
      ctx.symbols.add('src/shared.ts', 'Config', 'Class:src/shared.ts:Config', 'Class');
      ctx.importMap.set('src/local.ts', new Set(['src/shared.ts']));

      const result = resolveOne(ctx, 'Config', 'src/local.ts');

      expect(result!.nodeId).toBe('Class:src/local.ts:Config');
      expect(result!.filePath).toBe('src/local.ts');
    });
  });

  describe('Tier 2: Import-scoped resolution', () => {
    it('resolves symbol from an imported file', () => {
      ctx.symbols.add(
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
      ctx.symbols.add(
        'src/services/logger.ts',
        'Logger',
        'Class:src/services/logger.ts:Logger',
        'Class',
      );
      ctx.symbols.add(
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
      ctx.symbols.add('src/utils.ts', 'Helper', 'Class:src/utils.ts:Helper', 'Class');

      const result = resolveOne(ctx, 'Helper', 'src/app.ts');

      expect(result).not.toBeNull();
      expect(result!.nodeId).toBe('Class:src/utils.ts:Helper');
    });
  });

  describe('Tier 3: Global resolution', () => {
    it('resolves unique global when not in imports', () => {
      ctx.symbols.add(
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
      ctx.symbols.add('src/a.ts', 'Config', 'Class:src/a.ts:Config', 'Class');
      ctx.symbols.add('src/b.ts', 'Config', 'Class:src/b.ts:Config', 'Class');

      const result = resolveOne(ctx, 'Config', 'src/other.ts');

      expect(result).toBeNull();
    });

    it('ctx.resolve returns all candidates at global tier (consumers decide)', () => {
      ctx.symbols.add('src/a.ts', 'Config', 'Class:src/a.ts:Config', 'Class');
      ctx.symbols.add('src/b.ts', 'Config', 'Class:src/b.ts:Config', 'Class');

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
      ctx.symbols.add(
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
      ctx.symbols.add('src/base.ts', 'BaseService', 'Class:src/base.ts:BaseService', 'Class');
      ctx.importMap.set('src/app.ts', new Set(['src/base.ts']));

      const result = resolveOne(ctx, 'BaseService', 'src/app.ts');

      expect(result!.type).toBe('Class');
    });
  });

  describe('heritage-specific scenarios', () => {
    it('resolves C# interface vs class ambiguity via imports', () => {
      ctx.symbols.add(
        'src/logging/ilogger.cs',
        'ILogger',
        'Interface:src/logging/ilogger.cs:ILogger',
        'Interface',
      );
      ctx.symbols.add(
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
      ctx.symbols.add(
        'src/api/controller.ts',
        'UserController',
        'Class:src/api/controller.ts:UserController',
        'Class',
      );
      ctx.symbols.add(
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
    ctx.symbols.add('src/a.ts', 'Foo', 'Class:src/a.ts:Foo', 'Class');

    const result = resolveInternal(ctx, 'Foo', 'src/a.ts');

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('same-file');
    expect(result!.candidateCount).toBe(1);
    expect(result!.definition.nodeId).toBe('Class:src/a.ts:Foo');
  });

  it('returns import-scoped tier for Tier 2 match', () => {
    ctx.symbols.add('src/logger.ts', 'Logger', 'Class:src/logger.ts:Logger', 'Class');
    ctx.symbols.add('src/mock.ts', 'Logger', 'Class:src/mock.ts:Logger', 'Class');
    ctx.importMap.set('src/app.ts', new Set(['src/logger.ts']));

    const result = resolveInternal(ctx, 'Logger', 'src/app.ts');

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('import-scoped');
  });

  it('returns global tier for Tier 3 match', () => {
    ctx.symbols.add('src/only.ts', 'Singleton', 'Class:src/only.ts:Singleton', 'Class');

    const result = resolveInternal(ctx, 'Singleton', 'src/other.ts');

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('global');
    expect(result!.candidateCount).toBe(1);
  });

  it('returns null for ambiguous global — refuses to guess', () => {
    ctx.symbols.add('src/a.ts', 'Config', 'Class:src/a.ts:Config', 'Class');
    ctx.symbols.add('src/b.ts', 'Config', 'Class:src/b.ts:Config', 'Class');

    const result = resolveInternal(ctx, 'Config', 'src/other.ts');

    expect(result).toBeNull();
  });

  it('returns null for unknown symbol', () => {
    const result = resolveInternal(ctx, 'Ghost', 'src/any.ts');
    expect(result).toBeNull();
  });

  it('Tier 1 wins over Tier 2 — same-file takes priority', () => {
    ctx.symbols.add('src/app.ts', 'Util', 'Function:src/app.ts:Util', 'Function');
    ctx.symbols.add('src/lib.ts', 'Util', 'Function:src/lib.ts:Util', 'Function');
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
    ctx.symbols.add(
      'src/services/logger.ts',
      'Logger',
      'Class:src/services/logger.ts:Logger',
      'Class',
    );
    ctx.symbols.add(
      'src/testing/logger.ts',
      'Logger',
      'Class:src/testing/logger.ts:Logger',
      'Class',
    );

    const result = resolveOne(ctx, 'Logger', 'src/app.ts');
    expect(result).toBeNull();
  });

  it('Java: same-named class in different packages, no import → returns null', () => {
    ctx.symbols.add(
      'com/example/models/User.java',
      'User',
      'Class:com/example/models/User.java:User',
      'Class',
    );
    ctx.symbols.add(
      'com/example/dto/User.java',
      'User',
      'Class:com/example/dto/User.java:User',
      'Class',
    );

    const result = resolveOne(ctx, 'User', 'com/example/services/UserService.java');
    expect(result).toBeNull();
  });

  it('C/C++: type defined in transitively-included header → returns null (not reachable via direct import)', () => {
    ctx.symbols.add('src/c.h', 'Widget', 'Struct:src/c.h:Widget', 'Struct');
    ctx.symbols.add('src/d.h', 'Widget', 'Struct:src/d.h:Widget', 'Struct');
    ctx.importMap.set('src/a.c', new Set(['src/b.h']));

    const result = resolveOne(ctx, 'Widget', 'src/a.c');
    expect(result).toBeNull();
  });

  it('C#: two IService interfaces in different namespaces, no import → returns null', () => {
    ctx.symbols.add(
      'src/Services/IService.cs',
      'IService',
      'Interface:src/Services/IService.cs:IService',
      'Interface',
    );
    ctx.symbols.add(
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
    ctx.symbols.add(
      'src/api/base.ts',
      'BaseController',
      'Class:src/api/base.ts:BaseController',
      'Class',
    );
    ctx.symbols.add(
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

  it('shares same object reference between fileIndex and globalIndex', () => {
    const symbolTable = createSymbolTable();
    symbolTable.add('src/x.ts', 'Bar', 'Class:src/x.ts:Bar', 'Class');

    const fromExact = symbolTable.lookupExactFull('src/x.ts', 'Bar');
    const fromFuzzy = symbolTable.lookupFuzzy('Bar')[0];

    expect(fromExact).toBe(fromFuzzy);
  });

  it('preserves optional callable metadata on stored definitions', () => {
    const symbolTable = createSymbolTable();
    symbolTable.add('src/math.ts', 'sum', 'Function:src/math.ts:sum', 'Function', {
      parameterCount: 2,
    });

    const fromExact = symbolTable.lookupExactFull('src/math.ts', 'sum');
    const fromFuzzy = symbolTable.lookupFuzzy('sum')[0];

    expect(fromExact?.parameterCount).toBe(2);
    expect(fromFuzzy.parameterCount).toBe(2);
    expect(fromExact).toBe(fromFuzzy);
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
    ctx.symbols.add(
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
    ctx.symbols.add(
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
    ctx.symbols.add(
      'internal/auth/handler.go',
      'Validate',
      'Function:internal/auth/handler.go:Validate',
      'Function',
    );
    ctx.symbols.add(
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
    ctx.symbols.add(
      'internal/auth/handler.go',
      'Run',
      'Function:internal/auth/handler.go:Run',
      'Function',
    );
    ctx.symbols.add(
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
    ctx.symbols.add(
      'internal/auth/handler.go',
      'X',
      'Function:internal/auth/handler.go:X',
      'Function',
    );
    ctx.symbols.add('internal/db/handler.go', 'X', 'Function:internal/db/handler.go:X', 'Function');

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
    ctx.symbols.add('src/a.ts', 'Foo', 'Class:src/a.ts:Foo', 'Class');

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
    ctx.symbols.add('src/a.ts', 'Foo', 'Class:src/a.ts:Foo', 'Class');

    const result = ctx.resolve('Foo', 'src/a.ts');

    expect(result).not.toBeNull();
    expect(result!.candidates[0].nodeId).toBe('Class:src/a.ts:Foo');
    expect(ctx.getStats().cacheHits).toBe(0);
  });

  it('cache does not leak across files', () => {
    ctx.symbols.add('src/a.ts', 'Foo', 'Class:src/a.ts:Foo', 'Class');

    ctx.enableCache('src/a.ts');
    ctx.resolve('Foo', 'src/a.ts'); // cached for a.ts

    // Resolve from different file — should NOT use cache
    const r = ctx.resolve('Foo', 'src/b.ts');
    ctx.clearCache();

    // Foo is not in src/b.ts, so same-file fails. Falls to global with 1 candidate.
    expect(r!.tier).toBe('global');
  });
});
