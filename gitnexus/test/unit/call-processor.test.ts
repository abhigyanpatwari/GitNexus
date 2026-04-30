import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Synthetic `.ts` graphs exercise the legacy call-resolution DAG. With
// TypeScript in `MIGRATED_LANGUAGES`, `processCalls*` skips `.ts` unless
// the per-language flag is forced off for this suite.
let prevRegistryTypeScript: string | undefined;
beforeEach(() => {
  prevRegistryTypeScript = process.env['REGISTRY_PRIMARY_TYPESCRIPT'];
  process.env['REGISTRY_PRIMARY_TYPESCRIPT'] = 'false';
});
afterEach(() => {
  if (prevRegistryTypeScript === undefined) delete process.env['REGISTRY_PRIMARY_TYPESCRIPT'];
  else process.env['REGISTRY_PRIMARY_TYPESCRIPT'] = prevRegistryTypeScript;
});
import {
  processCalls,
  processCallsFromExtracted,
  processAssignmentsFromExtracted,
  seedCrossFileReceiverTypes,
  extractConsumerAccessedKeys,
  processNextjsFetchRoutes,
} from '../../src/core/ingestion/call-processor.js';
import { buildHeritageMap } from '../../src/core/ingestion/model/heritage-map.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { extractReturnTypeName } from '../../src/core/ingestion/type-extractors/shared.js';
import {
  createResolutionContext,
  type ResolutionContext,
} from '../../src/core/ingestion/model/resolution-context.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { BindingAccumulator } from '../../src/core/ingestion/binding-accumulator.js';
import type {
  ExtractedAssignment,
  ExtractedCall,
  ExtractedFetchCall,
  FileConstructorBindings,
} from '../../src/core/ingestion/workers/parse-worker.js';
import type { ExtractedHeritage } from '../../src/core/ingestion/model/heritage-map.js';

describe('processCallsFromExtracted', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  it('creates CALLS relationship for same-file resolution', async () => {
    ctx.model.symbols.add('src/index.ts', 'helper', 'Function:src/index.ts:helper', 'Function');

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'helper',
        sourceId: 'Function:src/index.ts:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].sourceId).toBe('Function:src/index.ts:main');
    expect(rels[0].targetId).toBe('Function:src/index.ts:helper');
    expect(rels[0].confidence).toBe(0.95);
    expect(rels[0].reason).toBe('same-file');
  });

  it('creates CALLS relationship for import-resolved resolution', async () => {
    ctx.model.symbols.add('src/utils.ts', 'format', 'Function:src/utils.ts:format', 'Function');
    ctx.importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'format',
        sourceId: 'Function:src/index.ts:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].confidence).toBe(0.9);
    expect(rels[0].reason).toBe('import-resolved');
  });

  it('resolves unique global symbol with moderate confidence', async () => {
    ctx.model.symbols.add(
      'src/other.ts',
      'uniqueFunc',
      'Function:src/other.ts:uniqueFunc',
      'Function',
    );

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'uniqueFunc',
        sourceId: 'Function:src/index.ts:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].confidence).toBe(0.5);
    expect(rels[0].reason).toBe('global');
  });

  it('refuses ambiguous global symbols — no CALLS edge created', async () => {
    ctx.model.symbols.add('src/a.ts', 'render', 'Function:src/a.ts:render', 'Function');
    ctx.model.symbols.add('src/b.ts', 'render', 'Function:src/b.ts:render', 'Function');

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'render',
        sourceId: 'Function:src/index.ts:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('skips unresolvable calls', async () => {
    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'nonExistent',
        sourceId: 'Function:src/index.ts:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationshipCount).toBe(0);
  });

  it('refuses non-callable symbols even when the name resolves', async () => {
    ctx.model.symbols.add('src/index.ts', 'Widget', 'Class:src/index.ts:Widget', 'Class');

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'Widget',
        sourceId: 'Function:src/index.ts:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationshipCount).toBe(0);
  });

  it('refuses CALLS edges to Interface symbols', async () => {
    ctx.model.symbols.add(
      'src/types.ts',
      'Serializable',
      'Interface:src/types.ts:Serializable',
      'Interface',
    );
    ctx.importMap.set('src/index.ts', new Set(['src/types.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'Serializable',
        sourceId: 'Function:src/index.ts:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationships.filter((r) => r.type === 'CALLS')).toHaveLength(0);
  });

  it('refuses CALLS edges to Enum symbols', async () => {
    ctx.model.symbols.add('src/status.ts', 'Status', 'Enum:src/status.ts:Status', 'Enum');
    ctx.importMap.set('src/index.ts', new Set(['src/status.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'Status',
        sourceId: 'Function:src/index.ts:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationships.filter((r) => r.type === 'CALLS')).toHaveLength(0);
  });

  it('prefers same-file over import-resolved', async () => {
    ctx.model.symbols.add('src/index.ts', 'render', 'Function:src/index.ts:render', 'Function');
    ctx.model.symbols.add('src/utils.ts', 'render', 'Function:src/utils.ts:render', 'Function');
    ctx.importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'render',
        sourceId: 'Function:src/index.ts:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Function:src/index.ts:render');
    expect(rels[0].reason).toBe('same-file');
  });

  it('handles multiple calls from the same file', async () => {
    ctx.model.symbols.add('src/index.ts', 'foo', 'Function:src/index.ts:foo', 'Function');
    ctx.model.symbols.add('src/index.ts', 'bar', 'Function:src/index.ts:bar', 'Function');

    const calls: ExtractedCall[] = [
      { filePath: 'src/index.ts', calledName: 'foo', sourceId: 'Function:src/index.ts:main' },
      { filePath: 'src/index.ts', calledName: 'bar', sourceId: 'Function:src/index.ts:main' },
    ];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationships.filter((r) => r.type === 'CALLS')).toHaveLength(2);
  });

  it('uses arity to disambiguate import-scoped callable candidates', async () => {
    ctx.model.symbols.add('src/logger.ts', 'log', 'Function:src/logger.ts:log', 'Function', {
      parameterCount: 0,
    });
    ctx.model.symbols.add('src/formatter.ts', 'log', 'Function:src/formatter.ts:log', 'Function', {
      parameterCount: 1,
    });
    ctx.importMap.set('src/index.ts', new Set(['src/logger.ts', 'src/formatter.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'log',
        sourceId: 'Function:src/index.ts:main',
        argCount: 1,
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Function:src/formatter.ts:log');
    expect(rels[0].reason).toBe('import-resolved');
  });

  it('refuses ambiguous call targets when arity does not produce a unique match', async () => {
    ctx.model.symbols.add('src/logger.ts', 'log', 'Function:src/logger.ts:log', 'Function', {
      parameterCount: 1,
    });
    ctx.model.symbols.add('src/formatter.ts', 'log', 'Function:src/formatter.ts:log', 'Function', {
      parameterCount: 1,
    });
    ctx.importMap.set('src/index.ts', new Set(['src/logger.ts', 'src/formatter.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'log',
        sourceId: 'Function:src/index.ts:main',
        argCount: 1,
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationships.filter((r) => r.type === 'CALLS')).toHaveLength(0);
  });

  it('calls progress callback', async () => {
    ctx.model.symbols.add('src/index.ts', 'foo', 'Function:src/index.ts:foo', 'Function');

    const calls: ExtractedCall[] = [
      { filePath: 'src/index.ts', calledName: 'foo', sourceId: 'Function:src/index.ts:main' },
    ];

    const onProgress = vi.fn();
    await processCallsFromExtracted(graph, calls, ctx, onProgress);

    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });

  it('handles empty calls array', async () => {
    await processCallsFromExtracted(graph, [], ctx);
    expect(graph.relationshipCount).toBe(0);
  });

  // ---- Constructor-aware resolution (Phase 2) ----

  it('resolves constructor call to Class when no Constructor node exists', async () => {
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'User',
        sourceId: 'Function:src/index.ts:main',
        callForm: 'constructor',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Class:src/models.ts:User');
    expect(rels[0].reason).toBe('import-resolved');
  });

  it('resolves constructor call to Constructor node over Class node', async () => {
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add(
      'src/models.ts',
      'User',
      'Constructor:src/models.ts:User',
      'Constructor',
      {
        parameterCount: 1,
      },
    );
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'User',
        sourceId: 'Function:src/index.ts:main',
        argCount: 1,
        callForm: 'constructor',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Constructor:src/models.ts:User');
  });

  it('refuses Class target without callForm=constructor (existing behavior)', async () => {
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'User',
        sourceId: 'Function:src/index.ts:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('constructor call falls back to callable types when no Constructor/Class found', async () => {
    ctx.model.symbols.add('src/utils.ts', 'Widget', 'Function:src/utils.ts:Widget', 'Function');
    ctx.importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'Widget',
        sourceId: 'Function:src/index.ts:main',
        callForm: 'constructor',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Function:src/utils.ts:Widget');
  });

  it('constructor arity filtering narrows overloaded constructors', async () => {
    ctx.model.symbols.add(
      'src/models.ts',
      'User',
      'Constructor:src/models.ts:User(0)',
      'Constructor',
      {
        parameterCount: 0,
      },
    );
    ctx.model.symbols.add(
      'src/models.ts',
      'User',
      'Constructor:src/models.ts:User(2)',
      'Constructor',
      {
        parameterCount: 2,
      },
    );
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'User',
        sourceId: 'Function:src/index.ts:main',
        argCount: 2,
        callForm: 'constructor',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Constructor:src/models.ts:User(2)');
  });

  it('cannot discriminate same-arity overloads by parameter type (known limitation)', async () => {
    ctx.model.symbols.add('src/UserDao.ts', 'save', 'Function:src/UserDao.ts:save', 'Function', {
      parameterCount: 1,
    });
    ctx.model.symbols.add('src/RepoDao.ts', 'save', 'Function:src/RepoDao.ts:save', 'Function', {
      parameterCount: 1,
    });
    ctx.importMap.set('src/index.ts', new Set(['src/UserDao.ts', 'src/RepoDao.ts']));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'save',
        sourceId: 'Function:src/index.ts:main',
        argCount: 1,
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);
    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  // ---- Return type inference (Phase 4) ----

  it('return type inference: binds variable to return type of callee', async () => {
    // getUser() returns User, and User has a save() method
    ctx.model.symbols.add('src/utils.ts', 'getUser', 'Function:src/utils.ts:getUser', 'Function', {
      returnType: 'User',
    });
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    ctx.importMap.set('src/index.ts', new Set(['src/utils.ts', 'src/models.ts']));

    // Binding: user = getUser() — getUser is not a class, so constructor path fails,
    // but return type inference should kick in
    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/index.ts',
        bindings: [{ scope: 'main@0', varName: 'user', calleeName: 'getUser' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'save',
        sourceId: 'Function:src/index.ts:main',
        receiverName: 'user',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  it('return type inference: unwraps Promise<User> to User', async () => {
    ctx.model.symbols.add('src/api.ts', 'fetchUser', 'Function:src/api.ts:fetchUser', 'Function', {
      returnType: 'Promise<User>',
    });
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    ctx.importMap.set('src/index.ts', new Set(['src/api.ts', 'src/models.ts']));

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/index.ts',
        bindings: [{ scope: 'main@0', varName: 'user', calleeName: 'fetchUser' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'save',
        sourceId: 'Function:src/index.ts:main',
        receiverName: 'user',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  it('return type inference: skips when return type is primitive', async () => {
    ctx.model.symbols.add(
      'src/utils.ts',
      'getCount',
      'Function:src/utils.ts:getCount',
      'Function',
      {
        returnType: 'number',
      },
    );
    ctx.importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/index.ts',
        bindings: [{ scope: 'main@0', varName: 'count', calleeName: 'getCount' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'toString',
        sourceId: 'Function:src/index.ts:main',
        receiverName: 'count',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    // No binding should be created for primitive return types
    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('return type inference: skips ambiguous callees (multiple definitions)', async () => {
    ctx.model.symbols.add('src/a.ts', 'getData', 'Function:src/a.ts:getData', 'Function', {
      returnType: 'User',
    });
    ctx.model.symbols.add('src/b.ts', 'getData', 'Function:src/b.ts:getData', 'Function', {
      returnType: 'Repo',
    });

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/index.ts',
        bindings: [{ scope: 'main@0', varName: 'data', calleeName: 'getData' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'save',
        sourceId: 'Function:src/index.ts:main',
        receiverName: 'data',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    // Ambiguous callee — don't guess
    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('return type inference: prefers constructor binding over return type', async () => {
    // If the callee IS a class, constructor binding wins (existing behavior)
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/index.ts',
        bindings: [{ scope: 'main@0', varName: 'user', calleeName: 'User' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'save',
        sourceId: 'Function:src/index.ts:main',
        receiverName: 'user',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  // ---- Phase 9: BindingAccumulator fallback for cross-file return types ----

  it('Phase 9: BindingAccumulator fallback — binds variable to return type when SymbolTable has no returnType', async () => {
    // getUser is in the SymbolTable but WITHOUT a returnType (e.g., inferred return type
    // that the structure processor did not capture). The BindingAccumulator for
    // src/api.ts has getUser → User as a file-scope binding.
    ctx.model.symbols.add('src/api.ts', 'getUser', 'Function:src/api.ts:getUser', 'Function', {
      // No returnType provided — simulates a structure-processor gap
    });
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    ctx.importMap.set('src/consumer.ts', new Set(['src/api.ts', 'src/models.ts']));
    // namedImportMap: consumer.ts imports { getUser } from src/api.ts
    ctx.namedImportMap.set(
      'src/consumer.ts',
      new Map([['getUser', { sourcePath: 'src/api.ts', exportedName: 'getUser' }]]),
    );

    // BindingAccumulator carries the TypeEnv-resolved binding from src/api.ts
    const acc = new BindingAccumulator();
    acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'User' }]);

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/consumer.ts',
        bindings: [{ scope: 'main@0', varName: 'x', calleeName: 'getUser' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'save',
        sourceId: 'Function:src/consumer.ts:main',
        receiverName: 'x',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(
      graph,
      calls,
      ctx,
      undefined,
      constructorBindings,
      undefined,
      acc,
    );

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  it('Phase 9: BindingAccumulator fallback — SymbolTable return type takes precedence', async () => {
    // When the SymbolTable DOES have a returnType, the accumulator should not override it.
    ctx.model.symbols.add('src/api.ts', 'getUser', 'Function:src/api.ts:getUser', 'Function', {
      returnType: 'User',
    });
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    ctx.importMap.set('src/consumer.ts', new Set(['src/api.ts', 'src/models.ts']));
    ctx.namedImportMap.set(
      'src/consumer.ts',
      new Map([['getUser', { sourcePath: 'src/api.ts', exportedName: 'getUser' }]]),
    );

    // Accumulator has a conflicting (wrong) type — should be ignored
    const acc = new BindingAccumulator();
    acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'WrongType' }]);

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/consumer.ts',
        bindings: [{ scope: 'main@0', varName: 'x', calleeName: 'getUser' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'save',
        sourceId: 'Function:src/consumer.ts:main',
        receiverName: 'x',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(
      graph,
      calls,
      ctx,
      undefined,
      constructorBindings,
      undefined,
      acc,
    );

    // Should resolve via SymbolTable (User#save), not the wrong accumulator type
    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  it('Phase 9: BindingAccumulator fallback — skips when callee not in namedImportMap', async () => {
    // Callee is not tracked in namedImportMap (e.g. a local function), so accumulator
    // lookup is skipped. No CALLS edge expected since there is no binding source.
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    // No namedImportMap entry for getUser

    const acc = new BindingAccumulator();
    acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'User' }]);

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/consumer.ts',
        bindings: [{ scope: 'main@0', varName: 'x', calleeName: 'getUser' }],
      },
    ];

    // Use a method name that is owned by User (requires receiver type resolution)
    // but also exists on multiple types so fuzzy lookup is ambiguous without a
    // receiver type. Add a second owner so that unconstrained fuzzy lookup won't
    // match unambiguously.
    ctx.model.symbols.add('src/other.ts', 'OtherClass', 'Class:src/other.ts:OtherClass', 'Class');
    ctx.model.symbols.add('src/other.ts', 'save', 'Method:src/other.ts:save', 'Method', {
      ownerId: 'Class:src/other.ts:OtherClass',
    });

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'save',
        sourceId: 'Function:src/consumer.ts:main',
        receiverName: 'x',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(
      graph,
      calls,
      ctx,
      undefined,
      constructorBindings,
      undefined,
      acc,
    );

    // Without accumulator fallback (no namedImportMap entry), x is untyped.
    // Two methods named 'save' from unrelated types — fuzzy lookup is ambiguous → no edge.
    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('Phase 9: BindingAccumulator fallback — unwraps Promise<User> type from accumulator', async () => {
    // Accumulator stores raw type with Promise wrapper — extractReturnTypeName should unwrap it.
    ctx.model.symbols.add('src/api.ts', 'fetchUser', 'Function:src/api.ts:fetchUser', 'Function');
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    ctx.importMap.set('src/consumer.ts', new Set(['src/api.ts', 'src/models.ts']));
    ctx.namedImportMap.set(
      'src/consumer.ts',
      new Map([['fetchUser', { sourcePath: 'src/api.ts', exportedName: 'fetchUser' }]]),
    );

    const acc = new BindingAccumulator();
    // Accumulator stores raw Promise<User> as type — should be unwrapped
    acc.appendFile('src/api.ts', [{ scope: '', varName: 'fetchUser', typeName: 'Promise<User>' }]);

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/consumer.ts',
        bindings: [{ scope: 'main@0', varName: 'x', calleeName: 'fetchUser' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'save',
        sourceId: 'Function:src/consumer.ts:main',
        receiverName: 'x',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(
      graph,
      calls,
      ctx,
      undefined,
      constructorBindings,
      undefined,
      acc,
    );

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  it('Phase 9: BindingAccumulator fallback — skips primitive types from accumulator', async () => {
    // Accumulator stores a primitive type — should not create a CALLS edge.
    ctx.model.symbols.add('src/api.ts', 'getCount', 'Function:src/api.ts:getCount', 'Function');
    ctx.importMap.set('src/consumer.ts', new Set(['src/api.ts']));
    ctx.namedImportMap.set(
      'src/consumer.ts',
      new Map([['getCount', { sourcePath: 'src/api.ts', exportedName: 'getCount' }]]),
    );

    const acc = new BindingAccumulator();
    acc.appendFile('src/api.ts', [{ scope: '', varName: 'getCount', typeName: 'number' }]);

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/consumer.ts',
        bindings: [{ scope: 'main@0', varName: 'count', calleeName: 'getCount' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'toString',
        sourceId: 'Function:src/consumer.ts:main',
        receiverName: 'count',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(
      graph,
      calls,
      ctx,
      undefined,
      constructorBindings,
      undefined,
      acc,
    );

    // Primitive type — no CALLS edge
    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('Phase 9: BindingAccumulator fallback — handles aliased import (localName ≠ exportedName)', async () => {
    // import { getUser as fetchUser } from './api' — namedImportMap maps localName to exportedName
    ctx.model.symbols.add('src/api.ts', 'getUser', 'Function:src/api.ts:getUser', 'Function');
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    ctx.importMap.set('src/consumer.ts', new Set(['src/api.ts', 'src/models.ts']));
    // Local alias: fetchUser → api.ts:getUser
    ctx.namedImportMap.set(
      'src/consumer.ts',
      new Map([['fetchUser', { sourcePath: 'src/api.ts', exportedName: 'getUser' }]]),
    );

    const acc = new BindingAccumulator();
    acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'User' }]);

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/consumer.ts',
        // calleeName is the LOCAL alias used at the call site
        bindings: [{ scope: 'main@0', varName: 'x', calleeName: 'fetchUser' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'save',
        sourceId: 'Function:src/consumer.ts:main',
        receiverName: 'x',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(
      graph,
      calls,
      ctx,
      undefined,
      constructorBindings,
      undefined,
      acc,
    );

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  // ---- Phase 9: Tier gating — accumulator fallback respects resolution tiers ----

  it('Phase 9 tier gating: same-file callable shadows imported callee — fallback skipped', async () => {
    // consumer.ts defines a local getUser() AND imports getUser from api.ts.
    // The local definition has no returnType annotation. The accumulator has
    // getUser → User from api.ts. The fallback must NOT fire because the
    // same-file definition is authoritative (tier: 'same-file').
    ctx.model.symbols.add(
      'src/consumer.ts',
      'getUser',
      'Function:src/consumer.ts:getUser',
      'Function',
    );
    ctx.model.symbols.add('src/api.ts', 'getUser', 'Function:src/api.ts:getUser', 'Function');
    // Place User and save in non-imported files so import-scoped member-call resolution
    // can't resolve save without a receiver type.
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    ctx.model.symbols.add('src/other.ts', 'OtherClass', 'Class:src/other.ts:OtherClass', 'Class');
    ctx.model.symbols.add('src/other.ts', 'save', 'Method:src/other.ts:save', 'Method', {
      ownerId: 'Class:src/other.ts:OtherClass',
    });
    // Only import api.ts — NOT models.ts, so save can't be found via import scope.
    ctx.importMap.set('src/consumer.ts', new Set(['src/api.ts']));
    ctx.namedImportMap.set(
      'src/consumer.ts',
      new Map([['getUser', { sourcePath: 'src/api.ts', exportedName: 'getUser' }]]),
    );

    const acc = new BindingAccumulator();
    acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'User' }]);

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/consumer.ts',
        bindings: [{ scope: 'main@0', varName: 'x', calleeName: 'getUser' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'save',
        sourceId: 'Function:src/consumer.ts:main',
        receiverName: 'x',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(
      graph,
      calls,
      ctx,
      undefined,
      constructorBindings,
      undefined,
      acc,
    );

    // Fallback must NOT fire — local getUser shadows imported getUser (tier: same-file).
    // Without a receiver type, member-call 'save' is ambiguous globally → no edge.
    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('Phase 9 tier gating: multiple callable candidates — fallback skipped', async () => {
    // Two functions named getUser in different imported files — resolution is ambiguous
    // (multiple candidates at 'import-scoped' tier). The accumulator carries a WRONG type
    // (BadType). If the fallback fires, x gets typed as BadType and x.save() looks for
    // BadType.save — which doesn't exist → 0 edges. If the fallback is correctly blocked,
    // x has no receiver type at all, and save is ambiguous (two owners) → 0 edges.
    // Either way, no CALLS edge. But we verify the accumulator's wrong type did NOT leak
    // by checking that no ACCESSES edge to BadType is created.
    ctx.model.symbols.add('src/api-v1.ts', 'getUser', 'Function:src/api-v1.ts:getUser', 'Function');
    ctx.model.symbols.add('src/api-v2.ts', 'getUser', 'Function:src/api-v2.ts:getUser', 'Function');
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    ctx.model.symbols.add('src/other.ts', 'OtherClass', 'Class:src/other.ts:OtherClass', 'Class');
    ctx.model.symbols.add('src/other.ts', 'save', 'Method:src/other.ts:save', 'Method', {
      ownerId: 'Class:src/other.ts:OtherClass',
    });
    // BadType has no methods — if the accumulator wrongly types x as BadType,
    // the receiver type is set but save won't resolve at all.
    ctx.model.symbols.add('src/bad.ts', 'BadType', 'Class:src/bad.ts:BadType', 'Class');
    ctx.importMap.set(
      'src/consumer.ts',
      new Set(['src/api-v1.ts', 'src/api-v2.ts', 'src/models.ts']),
    );
    ctx.namedImportMap.set(
      'src/consumer.ts',
      new Map([['getUser', { sourcePath: 'src/api-v1.ts', exportedName: 'getUser' }]]),
    );

    // Accumulator carries WRONG type — proves gating blocks the fallback
    const acc = new BindingAccumulator();
    acc.appendFile('src/api-v1.ts', [{ scope: '', varName: 'getUser', typeName: 'BadType' }]);

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/consumer.ts',
        bindings: [{ scope: 'main@0', varName: 'x', calleeName: 'getUser' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'save',
        sourceId: 'Function:src/consumer.ts:main',
        receiverName: 'x',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(
      graph,
      calls,
      ctx,
      undefined,
      constructorBindings,
      undefined,
      acc,
    );

    // If gating works: x has no receiver type, save may or may not resolve via
    // import scope (separate mechanism). Key assertion: BadType never appears
    // as an ACCESSES target — proving the accumulator's wrong type did not leak.
    const accesses = graph.relationships.filter(
      (r) => r.type === 'ACCESSES' && r.targetId === 'Class:src/bad.ts:BadType',
    );
    expect(accesses).toHaveLength(0);
  });

  it('Phase 9 tier gating: no callable candidates but named import — fallback fires', async () => {
    // getUser is not in the SymbolTable at all (e.g. definition not parsed).
    // namedImportMap has the import, accumulator has the type. Fallback should fire.
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    ctx.importMap.set('src/consumer.ts', new Set(['src/api.ts', 'src/models.ts']));
    ctx.namedImportMap.set(
      'src/consumer.ts',
      new Map([['getUser', { sourcePath: 'src/api.ts', exportedName: 'getUser' }]]),
    );

    const acc = new BindingAccumulator();
    acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'User' }]);

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/consumer.ts',
        bindings: [{ scope: 'main@0', varName: 'x', calleeName: 'getUser' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'save',
        sourceId: 'Function:src/consumer.ts:main',
        receiverName: 'x',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(
      graph,
      calls,
      ctx,
      undefined,
      constructorBindings,
      undefined,
      acc,
    );

    // No SymbolTable entry at all → tiered is null, fallback fires via accumulator.
    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  it('Phase 9 tier gating: single same-file callable without returnType — fallback skipped', async () => {
    // consumer.ts has a local getUser() without returnType annotation.
    // No import of getUser exists. The accumulator has getUser → User from api.ts.
    // Tier is 'same-file' so fallback must NOT fire.
    ctx.model.symbols.add(
      'src/consumer.ts',
      'getUser',
      'Function:src/consumer.ts:getUser',
      'Function',
    );
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', {
      ownerId: 'Class:src/models.ts:User',
    });
    // Add a second 'save' so fuzzy lookup is ambiguous without receiver type
    ctx.model.symbols.add('src/other.ts', 'OtherClass', 'Class:src/other.ts:OtherClass', 'Class');
    ctx.model.symbols.add('src/other.ts', 'save', 'Method:src/other.ts:save', 'Method', {
      ownerId: 'Class:src/other.ts:OtherClass',
    });

    const acc = new BindingAccumulator();
    acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'User' }]);

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/consumer.ts',
        bindings: [{ scope: 'main@0', varName: 'x', calleeName: 'getUser' }],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'save',
        sourceId: 'Function:src/consumer.ts:main',
        receiverName: 'x',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(
      graph,
      calls,
      ctx,
      undefined,
      constructorBindings,
      undefined,
      acc,
    );

    // Same-file callable — local is authoritative even without annotation.
    // Fuzzy 'save' lookup is ambiguous → no edge.
    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  // ---- Scope-aware constructor bindings (Phase 3) ----

  it('receiverKey collision: same method name in different classes does not collide', async () => {
    // User.save@100 and Repo.save@200 are two methods named "save" in different classes.
    // Each has a local variable "db" pointing to a different type.
    // Without @startIndex in the key, the second binding would overwrite the first.
    ctx.model.symbols.add(
      'src/db/Database.ts',
      'Database',
      'Class:src/db/Database.ts:Database',
      'Class',
    );
    ctx.model.symbols.add('src/db/Cache.ts', 'Cache', 'Class:src/db/Cache.ts:Cache', 'Class');
    ctx.model.symbols.add(
      'src/db/Database.ts',
      'query',
      'Method:src/db/Database.ts:query',
      'Method',
      {
        ownerId: 'Class:src/db/Database.ts:Database',
      },
    );
    ctx.model.symbols.add('src/db/Cache.ts', 'query', 'Method:src/db/Cache.ts:query', 'Method', {
      ownerId: 'Class:src/db/Cache.ts:Cache',
    });
    ctx.importMap.set('src/models/User.ts', new Set(['src/db/Database.ts']));
    ctx.importMap.set('src/models/Repo.ts', new Set(['src/db/Cache.ts']));

    // Two bindings: both enclosing scope is named "save" but at different startIndexes
    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/models/User.ts',
        bindings: [
          // save@100: inside User.save(), db = new Database()
          { scope: 'save@100', varName: 'db', calleeName: 'Database' },
        ],
      },
      {
        filePath: 'src/models/Repo.ts',
        bindings: [
          // save@200: inside Repo.save(), db = new Cache()
          { scope: 'save@200', varName: 'db', calleeName: 'Cache' },
        ],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/models/User.ts',
        calledName: 'query',
        sourceId: 'Method:src/models/User.ts:save',
        receiverName: 'db',
        callForm: 'member',
      },
      {
        filePath: 'src/models/Repo.ts',
        calledName: 'query',
        sourceId: 'Method:src/models/Repo.ts:save',
        receiverName: 'db',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(2);
    const userQueryRel = rels.find((r) => r.sourceId === 'Method:src/models/User.ts:save');
    const repoQueryRel = rels.find((r) => r.sourceId === 'Method:src/models/Repo.ts:save');
    expect(userQueryRel?.targetId).toBe('Method:src/db/Database.ts:query');
    expect(repoQueryRel?.targetId).toBe('Method:src/db/Cache.ts:query');
  });

  it('receiverKey collision: same scope funcName + same varName + same type resolves (non-ambiguous)', async () => {
    // Two save@* scopes both bind "db" to the same type — not ambiguous, should resolve.
    ctx.model.symbols.add(
      'src/db/Database.ts',
      'Database',
      'Class:src/db/Database.ts:Database',
      'Class',
    );
    ctx.model.symbols.add(
      'src/db/Database.ts',
      'query',
      'Method:src/db/Database.ts:query',
      'Method',
      {
        ownerId: 'Class:src/db/Database.ts:Database',
      },
    );
    ctx.importMap.set('src/service.ts', new Set(['src/db/Database.ts']));

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/service.ts',
        bindings: [
          { scope: 'save@10', varName: 'db', calleeName: 'Database' },
          { scope: 'save@50', varName: 'db', calleeName: 'Database' },
        ],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/service.ts',
        calledName: 'query',
        sourceId: 'Method:src/service.ts:save',
        receiverName: 'db',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/db/Database.ts:query');
  });

  it('receiverKey collision: same scope funcName + same varName + different types → ambiguous, no CALLS edge', async () => {
    // Two save@* scopes in the same file bind "db" to different types — truly ambiguous.
    ctx.model.symbols.add(
      'src/db/Database.ts',
      'Database',
      'Class:src/db/Database.ts:Database',
      'Class',
    );
    ctx.model.symbols.add('src/db/Cache.ts', 'Cache', 'Class:src/db/Cache.ts:Cache', 'Class');
    ctx.model.symbols.add(
      'src/db/Database.ts',
      'query',
      'Method:src/db/Database.ts:query',
      'Method',
      {
        ownerId: 'Class:src/db/Database.ts:Database',
      },
    );
    ctx.model.symbols.add('src/db/Cache.ts', 'query', 'Method:src/db/Cache.ts:query', 'Method', {
      ownerId: 'Class:src/db/Cache.ts:Cache',
    });
    ctx.importMap.set('src/service.ts', new Set(['src/db/Database.ts', 'src/db/Cache.ts']));

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/service.ts',
        bindings: [
          { scope: 'save@10', varName: 'db', calleeName: 'Database' },
          { scope: 'save@50', varName: 'db', calleeName: 'Cache' },
        ],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/service.ts',
        calledName: 'query',
        sourceId: 'Method:src/service.ts:save',
        receiverName: 'db',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    // Ambiguous — different types for same funcName+varName, should not emit a CALLS edge
    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('scope-aware bindings: same varName in different functions resolves to correct type', async () => {
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add('src/models.ts', 'Repo', 'Class:src/models.ts:Repo', 'Class');
    ctx.model.symbols.add('src/models.ts', 'save', 'Function:src/models.ts:save', 'Function');
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/index.ts',
        bindings: [
          { scope: 'processUser@12', varName: 'obj', calleeName: 'User' },
          { scope: 'processRepo@89', varName: 'obj', calleeName: 'Repo' },
        ],
      },
    ];

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'save',
        sourceId: 'Function:src/index.ts:processUser',
        receiverName: 'obj',
        callForm: 'member',
      },
      {
        filePath: 'src/index.ts',
        calledName: 'save',
        sourceId: 'Function:src/index.ts:processRepo',
        receiverName: 'obj',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(2);
    // Both calls should resolve, each with the correct receiver type from their scope
    // (the important thing is they don't collide — without scope awareness,
    // last-write-wins would give both calls the same receiver type)
    expect(rels[0].sourceId).toBe('Function:src/index.ts:processUser');
    expect(rels[1].sourceId).toBe('Function:src/index.ts:processRepo');
  });
});

describe('processCalls — Phase P class lookup fallback', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  it('uses lookupClassByName to override interface receiver types for cross-file virtual dispatch', async () => {
    const appFile = 'services/App.java';
    const contractFile = 'models/Pet.java';
    const dogFile = 'models/Dog.java';
    const petId = 'Interface:models/Pet.java:Pet';
    const dogId = 'Class:models/Dog.java:Dog';
    const fetchBallId = 'Method:models/Dog.java:fetchBall';

    ctx.model.symbols.add(contractFile, 'Pet', petId, 'Interface');
    ctx.model.symbols.add(dogFile, 'Dog', dogId, 'Class');
    ctx.model.symbols.add(dogFile, 'fetchBall', fetchBallId, 'Method', { ownerId: dogId });
    ctx.importMap.set(appFile, new Set([contractFile, dogFile]));

    // SM-20 wire-up: resolveMemberCall's constructor-override branch queries
    // the model directly (ctx.model.types.lookupClassByName), not the
    // legacy SymbolTable wrapper. Spy on the model method to preserve the
    // test's intent: verify which class names are looked up during override.
    const classLookupSpy = vi.spyOn(ctx.model.types, 'lookupClassByName');

    await processCalls(
      graph,
      [
        {
          path: appFile,
          content: `
package services;

import models.Pet;
import models.Dog;

class App {
  void run() {
    Pet pet = new Dog();
    pet.fetchBall();
  }
}
`,
        },
      ],
      createASTCache(),
      ctx,
    );

    const fetchBallCalls = graph.relationships.filter(
      (r) => r.type === 'CALLS' && r.targetId === fetchBallId,
    );
    expect(fetchBallCalls).toHaveLength(1);
    expect(classLookupSpy).toHaveBeenCalledWith('Dog');
    expect(classLookupSpy).toHaveBeenCalledWith('Pet');
  });

  it('does not override when the constructor type is not indexed as class-like', async () => {
    const appFile = 'services/App.java';
    const contractFile = 'models/Pet.java';
    const dogFile = 'models/Dog.java';
    const otherDogFile = 'models/OtherDog.java';
    const petId = 'Interface:models/Pet.java:Pet';

    ctx.model.symbols.add(contractFile, 'Pet', petId, 'Interface');
    ctx.model.symbols.add(dogFile, 'fetchBall', 'Method:models/Dog.java:fetchBall', 'Method', {
      ownerId: 'Class:models/Dog.java:Dog',
    });
    ctx.model.symbols.add(
      otherDogFile,
      'fetchBall',
      'Method:models/OtherDog.java:fetchBall',
      'Method',
      {
        ownerId: 'Class:models/OtherDog.java:OtherDog',
      },
    );
    ctx.importMap.set(appFile, new Set([contractFile, dogFile, otherDogFile]));

    // SM-20 wire-up: resolveMemberCall's constructor-override branch queries
    // the model directly (ctx.model.types.lookupClassByName), not the
    // legacy SymbolTable wrapper. Spy on the model method to preserve the
    // test's intent: verify which class names are looked up during override.
    const classLookupSpy = vi.spyOn(ctx.model.types, 'lookupClassByName');

    await processCalls(
      graph,
      [
        {
          path: appFile,
          content: `
package services;

import models.Pet;
import models.Dog;

class App {
  void run() {
    Pet pet = new Dog();
    pet.fetchBall();
  }
}
`,
        },
      ],
      createASTCache(),
      ctx,
    );

    const fetchBallCalls = graph.relationships.filter(
      (r) => r.type === 'CALLS' && r.targetId === 'Method:models/Dog.java:fetchBall',
    );
    expect(fetchBallCalls).toHaveLength(0);
    expect(classLookupSpy).toHaveBeenCalledWith('Dog');
    expect(classLookupSpy).not.toHaveBeenCalledWith('Pet');
  });
});

describe('extractReturnTypeName', () => {
  it('extracts simple type name', () => {
    expect(extractReturnTypeName('User')).toBe('User');
  });

  it('unwraps Promise<User>', () => {
    expect(extractReturnTypeName('Promise<User>')).toBe('User');
  });

  it('unwraps Option<User>', () => {
    expect(extractReturnTypeName('Option<User>')).toBe('User');
  });

  it('unwraps Result<User, Error> to first type arg', () => {
    expect(extractReturnTypeName('Result<User, Error>')).toBe('User');
  });

  it('strips nullable union: User | null', () => {
    expect(extractReturnTypeName('User | null')).toBe('User');
  });

  it('strips nullable union: User | undefined', () => {
    expect(extractReturnTypeName('User | undefined')).toBe('User');
  });

  it('strips nullable suffix: User?', () => {
    expect(extractReturnTypeName('User?')).toBe('User');
  });

  it('strips Go pointer: *User', () => {
    expect(extractReturnTypeName('*User')).toBe('User');
  });

  it('strips Rust reference: &User', () => {
    expect(extractReturnTypeName('&User')).toBe('User');
  });

  it('strips Rust mutable reference: &mut User', () => {
    expect(extractReturnTypeName('&mut User')).toBe('User');
  });

  it('returns undefined for primitives', () => {
    expect(extractReturnTypeName('string')).toBeUndefined();
    expect(extractReturnTypeName('number')).toBeUndefined();
    expect(extractReturnTypeName('boolean')).toBeUndefined();
    expect(extractReturnTypeName('void')).toBeUndefined();
    expect(extractReturnTypeName('int')).toBeUndefined();
  });

  it('returns undefined for genuine union types', () => {
    expect(extractReturnTypeName('User | Repo')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractReturnTypeName('')).toBeUndefined();
  });

  it('extracts qualified type: models.User → User', () => {
    expect(extractReturnTypeName('models.User')).toBe('User');
  });

  it('handles non-wrapper generics: Map<K, V> → Map', () => {
    expect(extractReturnTypeName('Map<string, User>')).toBe('Map');
  });

  it('handles nested wrapper: Promise<Option<User>>', () => {
    // Promise<Option<User>> → unwrap Promise → Option<User> → unwrap Option → User
    expect(extractReturnTypeName('Promise<Option<User>>')).toBe('User');
  });

  it('returns base type for collection generics (not unwrapped)', () => {
    expect(extractReturnTypeName('Vec<User>')).toBe('Vec');
    expect(extractReturnTypeName('List<User>')).toBe('List');
    expect(extractReturnTypeName('Array<User>')).toBe('Array');
    expect(extractReturnTypeName('Set<User>')).toBe('Set');
    expect(extractReturnTypeName('ArrayList<User>')).toBe('ArrayList');
  });

  it('unwraps Optional<User>', () => {
    expect(extractReturnTypeName('Optional<User>')).toBe('User');
  });

  it('extracts Ruby :: qualified type: Models::User → User', () => {
    expect(extractReturnTypeName('Models::User')).toBe('User');
  });

  it('extracts C++ :: qualified type: ns::HttpClient → HttpClient', () => {
    expect(extractReturnTypeName('ns::HttpClient')).toBe('HttpClient');
  });

  it('extracts deep :: qualified type: crate::models::User → User', () => {
    expect(extractReturnTypeName('crate::models::User')).toBe('User');
  });

  it('extracts mixed qualifier: ns.module::User → User', () => {
    expect(extractReturnTypeName('ns.module::User')).toBe('User');
  });

  it('returns undefined for lowercase :: qualified: std::vector', () => {
    expect(extractReturnTypeName('std::vector')).toBeUndefined();
  });

  it('extracts deep dot-qualified: com.example.models.User → User', () => {
    expect(extractReturnTypeName('com.example.models.User')).toBe('User');
  });

  it('unwraps wrapper over non-wrapper generic: Promise<Map<string, User>> → Map', () => {
    // Promise is a wrapper — unwrap it to get Map<string, User>.
    // Map is not a wrapper, so return its base type: Map.
    expect(extractReturnTypeName('Promise<Map<string, User>>')).toBe('Map');
  });

  it('unwraps doubly-nested wrapper: Future<Result<User, Error>> → User', () => {
    // Future → unwrap → Result<User, Error>; Result → unwrap first arg → User
    expect(extractReturnTypeName('Future<Result<User, Error>>')).toBe('User');
  });

  it('unwraps CompletableFuture<Optional<User>> → User', () => {
    // CompletableFuture → unwrap → Optional<User>; Optional → unwrap → User
    expect(extractReturnTypeName('CompletableFuture<Optional<User>>')).toBe('User');
  });

  // Rust smart pointer unwrapping
  it('unwraps Rc<User> → User', () => {
    expect(extractReturnTypeName('Rc<User>')).toBe('User');
  });
  it('unwraps Arc<User> → User', () => {
    expect(extractReturnTypeName('Arc<User>')).toBe('User');
  });
  it('unwraps Weak<User> → User', () => {
    expect(extractReturnTypeName('Weak<User>')).toBe('User');
  });
  it('unwraps MutexGuard<User> → User', () => {
    expect(extractReturnTypeName('MutexGuard<User>')).toBe('User');
  });
  it('unwraps RwLockReadGuard<User> → User', () => {
    expect(extractReturnTypeName('RwLockReadGuard<User>')).toBe('User');
  });
  it('unwraps Cow<User> → User', () => {
    expect(extractReturnTypeName('Cow<User>')).toBe('User');
  });
  // Nested: Arc<Option<User>> → User (double unwrap)
  it('unwraps Arc<Option<User>> → User', () => {
    expect(extractReturnTypeName('Arc<Option<User>>')).toBe('User');
  });
  // NOT unwrapped (containers/wrappers not in set)
  it('does not unwrap Mutex<User> (not a Deref wrapper)', () => {
    expect(extractReturnTypeName('Mutex<User>')).toBe('Mutex');
  });

  // Rust lifetime parameters in wrapper generics
  it("skips lifetime in Ref<'_, User> → User", () => {
    expect(extractReturnTypeName("Ref<'_, User>")).toBe('User');
  });
  it("skips lifetime in RefMut<'a, User> → User", () => {
    expect(extractReturnTypeName("RefMut<'a, User>")).toBe('User');
  });
  it("skips lifetime in MutexGuard<'_, User> → User", () => {
    expect(extractReturnTypeName("MutexGuard<'_, User>")).toBe('User');
  });

  it('returns undefined for lowercase non-class types', () => {
    expect(extractReturnTypeName('error')).toBeUndefined();
  });

  it('extracts PHP backslash-namespaced type: \\App\\Models\\User → User', () => {
    expect(extractReturnTypeName('\\App\\Models\\User')).toBe('User');
  });

  it('extracts PHP single-segment namespace: \\User → User', () => {
    expect(extractReturnTypeName('\\User')).toBe('User');
  });

  it('extracts PHP deep namespace: \\Vendor\\Package\\Sub\\Client → Client', () => {
    expect(extractReturnTypeName('\\Vendor\\Package\\Sub\\Client')).toBe('Client');
  });

  it('returns undefined for bare wrapper type names without generic arguments', () => {
    expect(extractReturnTypeName('Task')).toBeUndefined();
    expect(extractReturnTypeName('Promise')).toBeUndefined();
    expect(extractReturnTypeName('Future')).toBeUndefined();
    expect(extractReturnTypeName('Option')).toBeUndefined();
    expect(extractReturnTypeName('Result')).toBeUndefined();
    expect(extractReturnTypeName('Observable')).toBeUndefined();
    expect(extractReturnTypeName('ValueTask')).toBeUndefined();
    expect(extractReturnTypeName('CompletableFuture')).toBeUndefined();
    expect(extractReturnTypeName('Optional')).toBeUndefined();
  });

  // ---- Length caps (Phase 6) ----

  it('pre-cap: returns undefined when raw input exceeds 2048 characters', () => {
    const longInput = 'A'.repeat(2049);
    expect(extractReturnTypeName(longInput)).toBeUndefined();
  });

  it('pre-cap: accepts raw input at exactly 2048 characters (boundary)', () => {
    // A 2048-char string of uppercase letters passes the pre-cap gate.
    // It won't match as a valid identifier (too long for post-cap), so the
    // result is undefined — but the pre-cap itself does NOT reject it.
    // We test this by verifying a 2048-char type that WOULD be valid in all
    // other respects is still returned as undefined (post-cap rejects it).
    const atLimit = 'U' + 'x'.repeat(2047); // 2048 chars, starts with uppercase
    // Post-cap (512) will reject this, but the pre-cap should not fire.
    // The important assertion: no throw and the result is undefined from post-cap.
    expect(extractReturnTypeName(atLimit)).toBeUndefined();
  });

  it('pre-cap: accepts inputs shorter than 2048 characters without rejection', () => {
    // 'User' is well under 2048 — should resolve normally.
    expect(extractReturnTypeName('User')).toBe('User');
  });

  it('post-cap: returns undefined when extracted type name exceeds 512 characters', () => {
    // Construct a raw string that is under the 2048-char pre-cap but produces
    // a final identifier longer than 512 characters after extraction.
    // A bare uppercase identifier of 513 chars satisfies all rules except post-cap.
    const longTypeName = 'U' + 'x'.repeat(512); // 513 chars, starts with uppercase
    expect(extractReturnTypeName(longTypeName)).toBeUndefined();
  });

  it('post-cap: accepts extracted type name at exactly 512 characters (boundary)', () => {
    // 512-char identifier should pass the post-cap check (> 512 rejects, not >=).
    const atLimit = 'U' + 'x'.repeat(511); // exactly 512 chars
    expect(extractReturnTypeName(atLimit)).toBe(atLimit);
  });

  it('post-cap: accepts normal short type names well under 512 characters', () => {
    expect(extractReturnTypeName('HttpClient')).toBe('HttpClient');
    expect(extractReturnTypeName('UserService')).toBe('UserService');
  });
});

describe('seedCrossFileReceiverTypes', () => {
  it('single-hop: imported receiver gets type from ExportedTypeMap', () => {
    const calls: ExtractedCall[] = [
      {
        filePath: 'src/service.ts',
        calledName: 'save',
        sourceId: 'Function:src/service.ts:run',
        receiverName: 'repo',
        callForm: 'member',
      },
    ];

    const namedImportMap = new Map([
      [
        'src/service.ts',
        new Map([['repo', { sourcePath: 'src/models/repo.ts', exportedName: 'repo' }]]),
      ],
    ]);

    const exportedTypeMap = new Map([['src/models/repo.ts', new Map([['repo', 'Repo']])]]);

    const { enrichedCount } = seedCrossFileReceiverTypes(calls, namedImportMap, exportedTypeMap);

    expect(enrichedCount).toBe(1);
    expect(calls[0].receiverTypeName).toBe('Repo');
  });

  it('no-op when receiverTypeName already exists', () => {
    const calls: ExtractedCall[] = [
      {
        filePath: 'src/service.ts',
        calledName: 'save',
        sourceId: 'Function:src/service.ts:run',
        receiverName: 'repo',
        receiverTypeName: 'AlreadyKnown',
        callForm: 'member',
      },
    ];

    const namedImportMap = new Map([
      [
        'src/service.ts',
        new Map([['repo', { sourcePath: 'src/models/repo.ts', exportedName: 'repo' }]]),
      ],
    ]);

    const exportedTypeMap = new Map([['src/models/repo.ts', new Map([['repo', 'Repo']])]]);

    const { enrichedCount } = seedCrossFileReceiverTypes(calls, namedImportMap, exportedTypeMap);

    expect(enrichedCount).toBe(0);
    expect(calls[0].receiverTypeName).toBe('AlreadyKnown');
  });

  it('no-op for free function calls (callForm !== member)', () => {
    const calls: ExtractedCall[] = [
      {
        filePath: 'src/service.ts',
        calledName: 'doSomething',
        sourceId: 'Function:src/service.ts:run',
        receiverName: 'repo',
        callForm: 'free',
      },
    ];

    const namedImportMap = new Map([
      [
        'src/service.ts',
        new Map([['repo', { sourcePath: 'src/models/repo.ts', exportedName: 'repo' }]]),
      ],
    ]);

    const exportedTypeMap = new Map([['src/models/repo.ts', new Map([['repo', 'Repo']])]]);

    const { enrichedCount } = seedCrossFileReceiverTypes(calls, namedImportMap, exportedTypeMap);

    expect(enrichedCount).toBe(0);
    expect(calls[0].receiverTypeName).toBeUndefined();
  });

  it('aliased imports: local name maps to exported name via binding', () => {
    const calls: ExtractedCall[] = [
      {
        filePath: 'src/controller.ts',
        calledName: 'find',
        sourceId: 'Function:src/controller.ts:handle',
        receiverName: 'myRepo',
        callForm: 'member',
      },
    ];

    // import { repoInstance as myRepo } from 'src/models/repo.ts'
    const namedImportMap = new Map([
      [
        'src/controller.ts',
        new Map([['myRepo', { sourcePath: 'src/models/repo.ts', exportedName: 'repoInstance' }]]),
      ],
    ]);

    const exportedTypeMap = new Map([['src/models/repo.ts', new Map([['repoInstance', 'Repo']])]]);

    const { enrichedCount } = seedCrossFileReceiverTypes(calls, namedImportMap, exportedTypeMap);

    expect(enrichedCount).toBe(1);
    expect(calls[0].receiverTypeName).toBe('Repo');
  });

  it('early exit when maps are empty', () => {
    const calls: ExtractedCall[] = [
      {
        filePath: 'src/service.ts',
        calledName: 'save',
        sourceId: 'Function:src/service.ts:run',
        receiverName: 'repo',
        callForm: 'member',
      },
    ];

    const { enrichedCount: countA } = seedCrossFileReceiverTypes(
      calls,
      new Map(),
      new Map([['src/models/repo.ts', new Map([['repo', 'Repo']])]]),
    );
    expect(countA).toBe(0);

    const { enrichedCount: countB } = seedCrossFileReceiverTypes(
      calls,
      new Map([
        [
          'src/service.ts',
          new Map([['repo', { sourcePath: 'src/models/repo.ts', exportedName: 'repo' }]]),
        ],
      ]),
      new Map(),
    );
    expect(countB).toBe(0);

    expect(calls[0].receiverTypeName).toBeUndefined();
  });

  it('no mutation when no matching exports found', () => {
    const calls: ExtractedCall[] = [
      {
        filePath: 'src/service.ts',
        calledName: 'save',
        sourceId: 'Function:src/service.ts:run',
        receiverName: 'repo',
        callForm: 'member',
      },
    ];

    // namedImportMap has the file, but exportedTypeMap has no entry for the source path
    const namedImportMap = new Map([
      [
        'src/service.ts',
        new Map([['repo', { sourcePath: 'src/models/repo.ts', exportedName: 'repo' }]]),
      ],
    ]);

    const exportedTypeMap = new Map([['src/other-file.ts', new Map([['something', 'OtherType']])]]);

    const { enrichedCount } = seedCrossFileReceiverTypes(calls, namedImportMap, exportedTypeMap);

    expect(enrichedCount).toBe(0);
    expect(calls[0].receiverTypeName).toBeUndefined();
  });
});

describe('extractConsumerAccessedKeys', () => {
  it('extracts keys from destructuring after .json()', () => {
    const content = `
      const response = await fetch('/api/grants');
      const { data, pagination, error } = await response.json();
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).toContain('data');
    expect(keys).toContain('pagination');
    expect(keys).toContain('error');
  });

  it('extracts keys from destructuring of data variable', () => {
    const content = `
      const data = await response.json();
      const { items, total } = data;
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).toContain('items');
    expect(keys).toContain('total');
  });

  it('extracts keys from property access on data variable', () => {
    const content = `
      const data = await response.json();
      console.log(data.items);
      renderPagination(data.totalPages);
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).toContain('items');
    expect(keys).toContain('totalPages');
  });

  it('extracts keys from optional chaining', () => {
    const content = `
      const result = await fetchData();
      const items = result?.items;
      const count = result?.count;
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).toContain('items');
    expect(keys).toContain('count');
  });

  it('skips common method names like .json(), .map(), .filter()', () => {
    const content = `
      const data = await response.json();
      data.items.map(x => x.name);
      data.items.filter(x => x.active);
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).toContain('items');
    expect(keys).not.toContain('json');
    expect(keys).not.toContain('map');
    expect(keys).not.toContain('filter');
  });

  it('returns empty array when no property accesses found', () => {
    const content = `
      function unrelated() {
        console.log('hello');
      }
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).toHaveLength(0);
  });

  it('handles renamed destructuring bindings', () => {
    const content = `
      const { data: myData, error: err } = await res.json();
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).toContain('data');
    expect(keys).toContain('error');
    // Should extract the original key names, not the aliases
    expect(keys).not.toContain('myData');
    expect(keys).not.toContain('err');
  });

  it('deduplicates keys accessed multiple times', () => {
    const content = `
      const { data } = await res.json();
      console.log(data.items);
      render(data.items);
    `;
    const keys = extractConsumerAccessedKeys(content);
    const dataCount = keys.filter((k) => k === 'data').length;
    expect(dataCount).toBe(1);
  });
});

describe('processNextjsFetchRoutes', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;

  beforeEach(() => {
    graph = createKnowledgeGraph();
  });

  it('creates FETCHES edge with basic reason when no consumer contents', () => {
    // Add a File node for the consumer
    graph.addNode({
      id: 'File:src/page.tsx',
      label: 'File',
      properties: { name: 'src/page.tsx', filePath: 'src/page.tsx' },
    });

    const fetchCalls: ExtractedFetchCall[] = [
      { filePath: 'src/page.tsx', fetchURL: '/api/grants', lineNumber: 10 },
    ];
    const routeRegistry = new Map([['/api/grants', 'src/app/api/grants/route.ts']]);

    processNextjsFetchRoutes(graph, fetchCalls, routeRegistry);

    const rels = graph.relationships.filter((r) => r.type === 'FETCHES');
    expect(rels).toHaveLength(1);
    expect(rels[0].reason).toBe('fetch-url-match');
  });

  it('creates FETCHES edge with accessed keys in reason when consumer contents provided', () => {
    graph.addNode({
      id: 'File:src/page.tsx',
      label: 'File',
      properties: { name: 'src/page.tsx', filePath: 'src/page.tsx' },
    });

    const fetchCalls: ExtractedFetchCall[] = [
      { filePath: 'src/page.tsx', fetchURL: '/api/grants', lineNumber: 10 },
    ];
    const routeRegistry = new Map([['/api/grants', 'src/app/api/grants/route.ts']]);

    const consumerContents = new Map([
      [
        'src/page.tsx',
        `
        const res = await fetch('/api/grants');
        const { data, pagination } = await res.json();
        console.log(data.items);
      `,
      ],
    ]);

    processNextjsFetchRoutes(graph, fetchCalls, routeRegistry, consumerContents);

    const rels = graph.relationships.filter((r) => r.type === 'FETCHES');
    expect(rels).toHaveLength(1);
    expect(rels[0].reason).toMatch(/^fetch-url-match\|keys:/);
    // Should contain the destructured keys
    expect(rels[0].reason).toContain('data');
    expect(rels[0].reason).toContain('pagination');
  });

  it('falls back to basic reason when consumer file has no property accesses', () => {
    graph.addNode({
      id: 'File:src/page.tsx',
      label: 'File',
      properties: { name: 'src/page.tsx', filePath: 'src/page.tsx' },
    });

    const fetchCalls: ExtractedFetchCall[] = [
      { filePath: 'src/page.tsx', fetchURL: '/api/grants', lineNumber: 10 },
    ];
    const routeRegistry = new Map([['/api/grants', 'src/app/api/grants/route.ts']]);

    const consumerContents = new Map([
      [
        'src/page.tsx',
        `
        // This file just fetches without accessing properties
        await fetch('/api/grants');
      `,
      ],
    ]);

    processNextjsFetchRoutes(graph, fetchCalls, routeRegistry, consumerContents);

    const rels = graph.relationships.filter((r) => r.type === 'FETCHES');
    expect(rels).toHaveLength(1);
    expect(rels[0].reason).toBe('fetch-url-match');
  });

  it('encodes fetch count in reason when consumer fetches multiple routes', () => {
    graph.addNode({
      id: 'File:src/dashboard.tsx',
      label: 'File',
      properties: { name: 'src/dashboard.tsx', filePath: 'src/dashboard.tsx' },
    });

    const fetchCalls: ExtractedFetchCall[] = [
      { filePath: 'src/dashboard.tsx', fetchURL: '/api/grants', lineNumber: 10 },
      { filePath: 'src/dashboard.tsx', fetchURL: '/api/users', lineNumber: 20 },
    ];
    const routeRegistry = new Map([
      ['/api/grants', 'src/app/api/grants/route.ts'],
      ['/api/users', 'src/app/api/users/route.ts'],
    ]);

    const consumerContents = new Map([
      [
        'src/dashboard.tsx',
        `
        const { data, pagination } = await grantsRes.json();
        const { users } = await usersRes.json();
      `,
      ],
    ]);

    processNextjsFetchRoutes(graph, fetchCalls, routeRegistry, consumerContents);

    const rels = graph.relationships.filter((r) => r.type === 'FETCHES');
    expect(rels).toHaveLength(2);
    // Both edges should have |fetches:2 suffix
    for (const rel of rels) {
      expect(rel.reason).toContain('|fetches:2');
      expect(rel.reason).toMatch(/^fetch-url-match\|keys:[^|]+\|fetches:2$/);
    }
  });

  it('does not encode fetch count when consumer fetches only one route', () => {
    graph.addNode({
      id: 'File:src/page.tsx',
      label: 'File',
      properties: { name: 'src/page.tsx', filePath: 'src/page.tsx' },
    });

    const fetchCalls: ExtractedFetchCall[] = [
      { filePath: 'src/page.tsx', fetchURL: '/api/grants', lineNumber: 10 },
    ];
    const routeRegistry = new Map([
      ['/api/grants', 'src/app/api/grants/route.ts'],
      ['/api/users', 'src/app/api/users/route.ts'],
    ]);

    const consumerContents = new Map([['src/page.tsx', `const { data } = await res.json();`]]);

    processNextjsFetchRoutes(graph, fetchCalls, routeRegistry, consumerContents);

    const rels = graph.relationships.filter((r) => r.type === 'FETCHES');
    expect(rels).toHaveLength(1);
    expect(rels[0].reason).not.toContain('|fetches:');
  });
});

describe('processCallsFromExtracted — interface dispatch', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
    const ifaceFile = 'contracts/Action.java';
    const runnerFile = 'runner.java';
    const implA = 'impl/A.java';
    const implB = 'impl/B.java';
    const actionIfaceId = 'Interface:contracts/Action.java:Action';
    const ifaceExecuteId = 'Method:contracts/Action.java:execute';
    const implAExecuteId = 'Method:impl/A.java:execute';
    const implBExecuteId = 'Method:impl/B.java:execute';

    ctx.model.symbols.add(ifaceFile, 'Action', actionIfaceId, 'Interface');
    ctx.model.symbols.add(ifaceFile, 'execute', ifaceExecuteId, 'Method', {
      ownerId: actionIfaceId,
    });
    ctx.model.symbols.add(implA, 'execute', implAExecuteId, 'Method');
    ctx.model.symbols.add(implB, 'execute', implBExecuteId, 'Method');
    ctx.importMap.set(runnerFile, new Set([ifaceFile]));

    graph.addNode({
      id: 'Function:runner.java:run',
      label: 'Function',
      properties: { name: 'run', filePath: runnerFile },
    });
    graph.addNode({
      id: actionIfaceId,
      label: 'Interface',
      properties: { name: 'Action', filePath: ifaceFile },
    });
    graph.addNode({
      id: ifaceExecuteId,
      label: 'Method',
      properties: { name: 'execute', filePath: ifaceFile },
    });
    graph.addNode({
      id: implAExecuteId,
      label: 'Method',
      properties: { name: 'execute', filePath: implA },
    });
    graph.addNode({
      id: implBExecuteId,
      label: 'Method',
      properties: { name: 'execute', filePath: implB },
    });
  });

  it('adds CALLS to interface method plus lower-confidence edges to implementing methods', async () => {
    const heritage: ExtractedHeritage[] = [
      { filePath: 'impl/A.java', className: 'A', parentName: 'Action', kind: 'implements' },
      { filePath: 'impl/B.java', className: 'B', parentName: 'Action', kind: 'implements' },
    ];
    // Need class symbols for heritage map to resolve implementors
    ctx.model.symbols.add('impl/A.java', 'A', 'Class:impl/A.java:A', 'Class');
    ctx.model.symbols.add('impl/B.java', 'B', 'Class:impl/B.java:B', 'Class');
    const heritageMap = buildHeritageMap(heritage, ctx);

    const calls: ExtractedCall[] = [
      {
        filePath: 'runner.java',
        calledName: 'execute',
        sourceId: 'Function:runner.java:run',
        callForm: 'member',
        receiverName: 'action',
        receiverTypeName: 'Action',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, undefined, heritageMap);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(3);

    const primary = rels.find((r) => r.targetId === 'Method:contracts/Action.java:execute');
    const toA = rels.find((r) => r.targetId === 'Method:impl/A.java:execute');
    const toB = rels.find((r) => r.targetId === 'Method:impl/B.java:execute');
    expect(primary).toBeDefined();
    expect(primary!.confidence).toBeGreaterThan(0.7);
    expect(toA?.confidence).toBe(0.7);
    expect(toA?.reason).toBe('interface-dispatch');
    expect(toB?.confidence).toBe(0.7);
    expect(toB?.reason).toBe('interface-dispatch');
  });
});

// ---------------------------------------------------------------------------
// SM-10: D0 MRO fast path in resolveCallTarget
// ---------------------------------------------------------------------------

describe('processCalls — D0 MRO fast path (SM-10)', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;
  let prevRegistryPython: string | undefined;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
    // These tests exercise the LEGACY call-resolution DAG directly
    // using .py fixtures. Python defaults to registry-primary now
    // (MIGRATED_LANGUAGES), which gates call-processor out for
    // Python files. Force the flag off so the legacy DAG runs.
    prevRegistryPython = process.env['REGISTRY_PRIMARY_PYTHON'];
    process.env['REGISTRY_PRIMARY_PYTHON'] = 'false';
  });

  afterEach(() => {
    if (prevRegistryPython === undefined) delete process.env['REGISTRY_PRIMARY_PYTHON'];
    else process.env['REGISTRY_PRIMARY_PYTHON'] = prevRegistryPython;
  });

  const setupChildParent = () => {
    const parentFile = 'src/models/Parent.java';
    const childFile = 'src/models/Child.java';
    const appFile = 'src/services/App.java';
    const parentId = 'class:models/Parent.java:Parent';
    const childId = 'class:models/Child.java:Child';
    const parentMethodId = 'method:models/Parent.java:parentMethod';

    ctx.model.symbols.add(parentFile, 'Parent', parentId, 'Class');
    ctx.model.symbols.add(childFile, 'Child', childId, 'Class');
    ctx.model.symbols.add(parentFile, 'parentMethod', parentMethodId, 'Method', {
      ownerId: parentId,
      returnType: 'String',
    });
    ctx.importMap.set(appFile, new Set([childFile, parentFile]));
    return { parentFile, childFile, appFile, parentId, childId, parentMethodId };
  };

  it('D0 hit: child.parentMethod() resolves via MRO walk when heritageMap is provided', async () => {
    const { parentMethodId, appFile, parentFile, childFile } = setupChildParent();

    const heritage: ExtractedHeritage[] = [
      {
        filePath: childFile,
        className: 'Child',
        parentName: 'Parent',
        kind: 'extends',
      },
    ];
    const heritageMap = buildHeritageMap(heritage, ctx);

    await processCalls(
      graph,
      [
        {
          path: parentFile,
          content:
            'package models;\npublic class Parent {\n  public String parentMethod() { return ""; }\n}\n',
        },
        {
          path: childFile,
          content: 'package models;\npublic class Child extends Parent {}\n',
        },
        {
          path: appFile,
          content:
            'package services;\nimport models.Child;\npublic class App {\n  public void run() {\n    Child c = new Child();\n    c.parentMethod();\n  }\n}\n',
        },
      ],
      createASTCache(),
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      heritageMap,
    );

    const parentMethodCalls = graph.relationships.filter(
      (r) => r.type === 'CALLS' && r.targetId === parentMethodId,
    );
    expect(parentMethodCalls).toHaveLength(1);
  });

  it('D0 miss: heritageMap provided but method not in MRO chain falls through to D1-D4', async () => {
    // Setup: Class Obj exists in the same file as a `doWork` Method. The
    // Method is registered under a DIFFERENT ownerId (`class:OtherOwner`)
    // so lookupMethodByOwner('class:Obj', 'doWork') misses on the direct
    // lookup. heritageMap is empty for class:Obj, so MRO walk yields no
    // parents. Expected flow:
    //   D0: lookupMethodByOwner + MRO walk both miss → D0 fallthrough
    //   D1-D4: receiver type resolves to Obj; D3 file-filter picks the
    //          `doWork` candidate via its co-located file path.
    // Guarantees D0 miss does not swallow the call — D1-D4 still runs.
    const classFile = 'src/models/Obj.java';
    const appFile = 'src/services/App.java';
    const classId = 'class:models/Obj.java:Obj';
    const doWorkId = 'method:models/Obj.java:doWork';

    ctx.model.symbols.add(classFile, 'Obj', classId, 'Class');
    // Post-A4: Method+ownerId routes through methodsByName. Using a
    // different ownerId than the receiver type forces the direct
    // lookupMethodByOwner miss that the test exercises.
    ctx.model.symbols.add(classFile, 'doWork', doWorkId, 'Method', {
      returnType: 'void',
      parameterCount: 0,
      ownerId: 'class:models/Obj.java:OtherOwner',
    });
    ctx.importMap.set(appFile, new Set([classFile]));

    // Empty heritage — no ancestry for Obj, so the MRO walk yields no parents.
    const heritageMap = buildHeritageMap([], ctx);

    const calls: ExtractedCall[] = [
      {
        filePath: appFile,
        calledName: 'doWork',
        sourceId: 'method:services/App.java:run',
        argCount: 0,
        callForm: 'member',
        receiverTypeName: 'Obj',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, undefined, heritageMap);

    const doWorkCalls = graph.relationships.filter(
      (r) => r.type === 'CALLS' && r.targetId === doWorkId,
    );
    expect(doWorkCalls).toHaveLength(1);
  });

  it('no heritageMap: inherited methods are unresolvable (null-routed, not false-positive)', async () => {
    // Without a HeritageMap, the resolver cannot know that Parent.parentMethod
    // belongs to Child's ancestry. The old D1-D4 tail-return would silently
    // pick the lone fuzzy candidate and emit a CALLS edge — but that was an
    // accidental match that happened to line up because `parentMethod`
    // was unique in the global index.
    //
    // After the R3 tail-return tightening (PR #744 Codex review), member
    // calls whose D1-D4 narrowing produces zero file-matched and zero
    // owner-matched candidates null-route instead of falling through.
    // The test now asserts the honest answer: without heritage information,
    // we cannot attribute `c.parentMethod()` to `Parent` and therefore
    // emit no edge.
    //
    // In the real ingestion pipeline, heritageMap is always threaded
    // through, so this scenario is only reachable in tests that explicitly
    // omit it. Keeping the test confirms the null-route behavior and
    // documents the invariant "no heritage → no inherited-method edges".
    const { parentMethodId, appFile, parentFile, childFile } = setupChildParent();

    await processCalls(
      graph,
      [
        {
          path: parentFile,
          content:
            'package models;\npublic class Parent {\n  public String parentMethod() { return ""; }\n}\n',
        },
        {
          path: childFile,
          content: 'package models;\npublic class Child extends Parent {}\n',
        },
        {
          path: appFile,
          content:
            'package services;\nimport models.Child;\npublic class App {\n  public void run() {\n    Child c = new Child();\n    c.parentMethod();\n  }\n}\n',
        },
      ],
      createASTCache(),
      ctx,
      // no heritageMap — D0 MRO walk is unavailable, D1-D4 receiver filtering
      // also cannot link c.parentMethod() to Parent, so no edge is emitted.
    );

    const parentMethodCalls = graph.relationships.filter(
      (r) => r.type === 'CALLS' && r.targetId === parentMethodId,
    );
    expect(parentMethodCalls).toHaveLength(0);
  });

  it('overloadHints guard: D0 skipped so literal-inferred overload disambiguation picks the right overload', async () => {
    // Java sequential path: processCalls auto-generates `overloadHints` for
    // languages whose provider exposes `inferLiteralType` (Java/Kotlin/C#/C++).
    // When two overloads share the same return type, lookupMethodByOwner
    // returns defs[0] (the first-added overload) regardless of argument
    // types. Without the D0 guard this would mis-resolve `o.method("hello")`
    // to method(int). With the guard, D0 is skipped because overloadHints
    // is present, and the literal-inferred overload path in D2-D4+E picks
    // method(String) correctly.
    const classFile = 'src/models/Obj.java';
    const appFile = 'src/services/App.java';
    const classId = 'class:models/Obj.java:Obj';
    const methodIntId = 'method:models/Obj.java:method(int)';
    const methodStringId = 'method:models/Obj.java:method(String)';

    ctx.model.symbols.add(classFile, 'Obj', classId, 'Class');
    // int overload added FIRST so lookupMethodByOwner would return it.
    ctx.model.symbols.add(classFile, 'method', methodIntId, 'Method', {
      ownerId: classId,
      returnType: 'String',
      parameterCount: 1,
      parameterTypes: ['int'],
    });
    ctx.model.symbols.add(classFile, 'method', methodStringId, 'Method', {
      ownerId: classId,
      returnType: 'String',
      parameterCount: 1,
      parameterTypes: ['String'],
    });
    ctx.importMap.set(appFile, new Set([classFile]));

    const heritageMap = buildHeritageMap([], ctx);

    await processCalls(
      graph,
      [
        {
          path: classFile,
          content:
            'package models;\npublic class Obj {\n  public String method(int x) { return ""; }\n  public String method(String s) { return ""; }\n}\n',
        },
        {
          path: appFile,
          content:
            'package services;\nimport models.Obj;\npublic class App {\n  public void run() {\n    Obj o = new Obj();\n    o.method("hello");\n  }\n}\n',
        },
      ],
      createASTCache(),
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      heritageMap,
    );

    // Exactly one resolved call, and it must target the String overload.
    const methodCalls = graph.relationships.filter(
      (r) => r.type === 'CALLS' && (r.targetId === methodIntId || r.targetId === methodStringId),
    );
    expect(methodCalls).toHaveLength(1);
    expect(methodCalls[0].targetId).toBe(methodStringId);
  });

  it('preComputedArgTypes guard: D0 skipped so arg-type disambiguation picks the right overload', async () => {
    // Two overloads of the same method with identical return types live on
    // the same owner class. Without the D0 guard, lookupMethodByOwner would
    // return defs[0] (the first overload added) regardless of argument types,
    // silently mis-resolving an `obj.method("hello")` call to method(int).
    // With the guard, preComputedArgTypes forces D0 to be skipped and D2-D4+E
    // disambiguates by parameter type.
    const classFile = 'src/models/Obj.java';
    const appFile = 'src/services/App.java';
    const classId = 'class:models/Obj.java:Obj';
    const methodIntId = 'method:models/Obj.java:method(int)';
    const methodStringId = 'method:models/Obj.java:method(String)';

    ctx.model.symbols.add(classFile, 'Obj', classId, 'Class');
    // int overload added FIRST — without the guard this would be returned by
    // lookupMethodByOwner's same-return-type fast path.
    ctx.model.symbols.add(classFile, 'method', methodIntId, 'Method', {
      ownerId: classId,
      returnType: 'String',
      parameterCount: 1,
      parameterTypes: ['int'],
    });
    ctx.model.symbols.add(classFile, 'method', methodStringId, 'Method', {
      ownerId: classId,
      returnType: 'String',
      parameterCount: 1,
      parameterTypes: ['String'],
    });
    ctx.importMap.set(appFile, new Set([classFile]));

    const heritageMap = buildHeritageMap([], ctx);

    const calls: ExtractedCall[] = [
      {
        filePath: appFile,
        calledName: 'method',
        sourceId: 'method:services/App.java:run',
        argCount: 1,
        callForm: 'member',
        receiverTypeName: 'Obj',
        argTypes: ['String'],
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx, undefined, undefined, heritageMap);

    const methodCalls = graph.relationships.filter((r) => r.type === 'CALLS');
    // Exactly one resolved call, and it must target the String overload —
    // NOT the int overload that lookupMethodByOwner would have returned.
    expect(methodCalls).toHaveLength(1);
    expect(methodCalls[0].targetId).toBe(methodStringId);
  });

  it('module-alias guard: D0 skipped when receiverName matches an active module alias', async () => {
    // Setup: two files each define a class named User with a method save().
    // The caller has a Python-style module alias `import auth_mod as auth`,
    // so auth.User().save() must resolve to auth_mod.py, NOT user_mod.py.
    // D0 would call ctx.resolve('User') and could pick the wrong file; the
    // alias guard must short-circuit D0 so the alias-filtered D1-D4 path
    // runs and picks the correct file.
    const authModFile = 'auth_mod.py';
    const userModFile = 'user_mod.py';
    const appFile = 'app.py';
    const authUserId = 'class:auth_mod.py:User';
    const userUserId = 'class:user_mod.py:User';
    const authSaveId = 'method:auth_mod.py:save';
    const userSaveId = 'method:user_mod.py:save';

    ctx.model.symbols.add(authModFile, 'User', authUserId, 'Class');
    ctx.model.symbols.add(userModFile, 'User', userUserId, 'Class');
    ctx.model.symbols.add(authModFile, 'save', authSaveId, 'Method', {
      ownerId: authUserId,
      returnType: 'bool',
    });
    ctx.model.symbols.add(userModFile, 'save', userSaveId, 'Method', {
      ownerId: userUserId,
      returnType: 'bool',
    });
    // Register the module alias: in app.py, `auth` points to auth_mod.py.
    const aliasMap = new Map<string, string>([['auth', authModFile]]);
    ctx.moduleAliasMap.set(appFile, aliasMap);
    ctx.importMap.set(appFile, new Set([authModFile]));

    const heritageMap = buildHeritageMap([], ctx);

    await processCalls(
      graph,
      [
        {
          path: authModFile,
          content: 'class User:\n    def save(self):\n        return True\n',
        },
        {
          path: userModFile,
          content: 'class User:\n    def save(self):\n        return True\n',
        },
        {
          path: appFile,
          content:
            'import auth_mod as auth\n\ndef run():\n    user = auth.User()\n    user.save()\n',
        },
      ],
      createASTCache(),
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      heritageMap,
    );

    // save() must resolve to auth_mod.py, NOT user_mod.py.
    const authSave = graph.relationships.find(
      (r) => r.type === 'CALLS' && r.targetId === authSaveId,
    );
    const userSave = graph.relationships.find(
      (r) => r.type === 'CALLS' && r.targetId === userSaveId,
    );
    expect(authSave).toBeDefined();
    expect(userSave).toBeUndefined();
  });

  it('module-alias guard (real homonym): both files imported, alias narrows typed member call to aliased file', async () => {
    // When both homonym files are imported by the caller, import-scoped
    // tiering no longer narrows the tiered pool — the dispatcher sees two
    // `save` candidates. Module-alias narrowing is the only remaining
    // disambiguation signal. The typed-member branch must consult the alias
    // map (as a guarded fallback after owner/file-scoped resolvers fail) or
    // null-route silently.
    const authModFile = 'src/auth_mod.py';
    const userModFile = 'src/user_mod.py';
    const appFile = 'src/app.py';
    const authUserId = 'class:src/auth_mod.py:User';
    const userUserId = 'class:src/user_mod.py:User';
    const authSaveId = 'method:src/auth_mod.py:save';
    const userSaveId = 'method:src/user_mod.py:save';

    ctx.model.symbols.add(authModFile, 'User', authUserId, 'Class');
    ctx.model.symbols.add(userModFile, 'User', userUserId, 'Class');
    ctx.model.symbols.add(authModFile, 'save', authSaveId, 'Method', {
      ownerId: authUserId,
      returnType: 'bool',
    });
    ctx.model.symbols.add(userModFile, 'save', userSaveId, 'Method', {
      ownerId: userUserId,
      returnType: 'bool',
    });
    // BOTH files imported by app.py — creates real ambiguity in tiered pool.
    ctx.importMap.set(appFile, new Set([authModFile, userModFile]));
    // Alias: `auth` points to auth_mod.py.
    ctx.moduleAliasMap.set(appFile, new Map([['auth', authModFile]]));

    // Call `auth.User.save(user)` — receiverName is `auth` (matches alias),
    // receiverTypeName is `User` (the class). This is the class-as-receiver
    // static-style pattern parse-worker emits when it sees `auth.User.save(x)`.
    const calls: ExtractedCall[] = [
      {
        filePath: appFile,
        calledName: 'save',
        sourceId: 'Function:src/app.py:run',
        argCount: 1,
        callForm: 'member',
        receiverName: 'auth',
        receiverTypeName: 'User',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    // Module alias narrows to auth_mod.py. Without it the dispatcher would
    // null-route because both User classes own a `save` method and there's
    // no heritage or overload signal to pick between them.
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe(authSaveId);
  });

  it('owner-scoped wins over alias narrowing: unique owner-scoped answer beats coincidental alias on unrelated file', async () => {
    // Receiver type `User` has exactly one definition, in models.py. Module
    // alias `auth → auth.py` exists (because the caller also imports auth.py
    // for its own reasons), and auth.py contains an unrelated `Widget` class
    // with a homonym `save` method. The caller has `receiverName='auth'`
    // (e.g., a local variable coincidentally named `auth`),
    // `receiverTypeName='User'`. Owner-scoped resolution must win — alias
    // narrowing must not short-circuit a unique correct answer with an
    // unrelated homonym from the aliased file.
    const modelsFile = 'src/models.py';
    const authFile = 'src/auth.py';
    const appFile = 'src/app.py';
    const modelsUserId = 'class:src/models.py:User';
    const authWidgetId = 'class:src/auth.py:Widget';
    const modelsSaveId = 'method:src/models.py:User:save';
    const authSaveId = 'method:src/auth.py:Widget:save';

    ctx.model.symbols.add(modelsFile, 'User', modelsUserId, 'Class');
    ctx.model.symbols.add(authFile, 'Widget', authWidgetId, 'Class');
    ctx.model.symbols.add(modelsFile, 'save', modelsSaveId, 'Method', {
      ownerId: modelsUserId,
      returnType: 'None',
    });
    ctx.model.symbols.add(authFile, 'save', authSaveId, 'Method', {
      ownerId: authWidgetId,
      returnType: 'None',
    });
    ctx.importMap.set(appFile, new Set([modelsFile, authFile]));
    ctx.moduleAliasMap.set(appFile, new Map([['auth', authFile]]));

    const calls: ExtractedCall[] = [
      {
        filePath: appFile,
        calledName: 'save',
        sourceId: 'Function:src/app.py:run',
        argCount: 1,
        callForm: 'member',
        receiverName: 'auth',
        receiverTypeName: 'User',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    // Owner-scoped runs first and uniquely resolves User.save to models.py.
    // Alias narrowing never fires because the scoped resolver already won.
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe(modelsSaveId);
  });

  it('alias narrowing rejects unrelated target type: null-route when alias file does not hold receiver type', async () => {
    // Receiver type `User` lives only in models.py, but has no `save` method
    // defined. Alias `auth → auth.py`, and auth.py contains an unrelated
    // `Widget.save`. Owner-scoped and file-scoped resolvers return null (no
    // save on User). Without the type-file verification guard, alias
    // narrowing would pick auth.py's `Widget.save` — a cross-type false
    // positive. With the guard, auth.py is not in the receiver type's
    // defining-files set (which is {models.py}), so alias narrowing bails
    // and SM-10 R3 null-routes.
    const modelsFile = 'src/models.py';
    const authFile = 'src/auth.py';
    const appFile = 'src/app.py';
    const modelsUserId = 'class:src/models.py:User';
    const authWidgetId = 'class:src/auth.py:Widget';
    const authSaveId = 'method:src/auth.py:Widget:save';

    ctx.model.symbols.add(modelsFile, 'User', modelsUserId, 'Class');
    ctx.model.symbols.add(authFile, 'Widget', authWidgetId, 'Class');
    // NO save on User — deliberately absent to force null-route.
    ctx.model.symbols.add(authFile, 'save', authSaveId, 'Method', {
      ownerId: authWidgetId,
      returnType: 'None',
    });
    ctx.importMap.set(appFile, new Set([modelsFile, authFile]));
    ctx.moduleAliasMap.set(appFile, new Map([['auth', authFile]]));

    const calls: ExtractedCall[] = [
      {
        filePath: appFile,
        calledName: 'save',
        sourceId: 'Function:src/app.py:run',
        argCount: 1,
        callForm: 'member',
        receiverName: 'auth',
        receiverTypeName: 'User',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    // Null-route: no CALLS edge. The type-file guard prevented the alias
    // from leaking auth.py's Widget.save onto a User-typed receiver.
    expect(rels).toHaveLength(0);
  });

  it('alias fallthrough: receiverName not in alias map falls through to owner-scoped resolver', async () => {
    // Receiver variable `user` does NOT match any alias entry (alias only
    // covers `auth`). Owner-scoped resolution must run to completion and
    // pick models.py's User.save — the alias helper's early-bail must not
    // interfere with unrelated typed member calls. This exercises the 99%
    // hot path where alias narrowing is irrelevant.
    const modelsFile = 'src/models.py';
    const authFile = 'src/auth.py';
    const appFile = 'src/app.py';
    const modelsUserId = 'class:src/models.py:User';
    const modelsSaveId = 'method:src/models.py:User:save';

    ctx.model.symbols.add(modelsFile, 'User', modelsUserId, 'Class');
    ctx.model.symbols.add(modelsFile, 'save', modelsSaveId, 'Method', {
      ownerId: modelsUserId,
      returnType: 'None',
    });
    ctx.importMap.set(appFile, new Set([modelsFile, authFile]));
    ctx.moduleAliasMap.set(appFile, new Map([['auth', authFile]]));

    const calls: ExtractedCall[] = [
      {
        filePath: appFile,
        calledName: 'save',
        sourceId: 'Function:src/app.py:run',
        argCount: 0,
        callForm: 'member',
        receiverName: 'user', // NOT 'auth' — no alias match
        receiverTypeName: 'User',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe(modelsSaveId);
  });

  it('alias fallthrough: alias target file has no matching method falls through to owner-scoped', async () => {
    // Alias `auth → empty.py` where empty.py exists in the import map but
    // has no `save` method at all. Owner-scoped finds models.py's User.save
    // uniquely. Even if the type-file guard let alias narrowing fire (it
    // won't, because empty.py isn't in the receiver type's files), the
    // helper would return null and resolution must still succeed.
    const modelsFile = 'src/models.py';
    const emptyFile = 'src/empty.py';
    const appFile = 'src/app.py';
    const modelsUserId = 'class:src/models.py:User';
    const modelsSaveId = 'method:src/models.py:User:save';

    ctx.model.symbols.add(modelsFile, 'User', modelsUserId, 'Class');
    ctx.model.symbols.add(modelsFile, 'save', modelsSaveId, 'Method', {
      ownerId: modelsUserId,
      returnType: 'None',
    });
    // empty.py: no symbols at all.
    ctx.importMap.set(appFile, new Set([modelsFile, emptyFile]));
    ctx.moduleAliasMap.set(appFile, new Map([['auth', emptyFile]]));

    const calls: ExtractedCall[] = [
      {
        filePath: appFile,
        calledName: 'save',
        sourceId: 'Function:src/app.py:run',
        argCount: 0,
        callForm: 'member',
        receiverName: 'auth',
        receiverTypeName: 'User',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe(modelsSaveId);
  });

  it('constructor overload disambiguation: same-arity ownerless constructors picked via preComputedArgTypes', async () => {
    // When two homonym constructors across different files have the same
    // arity but different parameter types, `resolveStaticCall` correctly
    // bails (step 3 ambiguity → step 4 bail because the tiered pool contains
    // Constructor nodes). Step 4.5 then runs overload/arg-type disambiguation
    // on the constructor-filtered pool, picking the string overload when the
    // caller supplies matching `argTypes` / `preComputedArgTypes`.
    const userFile = 'src/models/User.ts';
    const repoFile = 'src/models/Repo.ts';
    const appFile = 'src/app.ts';
    const userClassId = 'Class:src/models/User.ts:User';
    const repoClassId = 'Class:src/models/Repo.ts:User';
    const userCtorId = 'Constructor:src/models/User.ts:User(string)';
    const repoCtorId = 'Constructor:src/models/Repo.ts:User(number)';

    ctx.model.symbols.add(userFile, 'User', userClassId, 'Class');
    ctx.model.symbols.add(repoFile, 'User', repoClassId, 'Class');
    ctx.model.symbols.add(userFile, 'User', userCtorId, 'Constructor', {
      ownerId: userClassId,
      parameterCount: 1,
      parameterTypes: ['string'],
    });
    ctx.model.symbols.add(repoFile, 'User', repoCtorId, 'Constructor', {
      ownerId: repoClassId,
      parameterCount: 1,
      parameterTypes: ['number'],
    });
    ctx.importMap.set(appFile, new Set([userFile, repoFile]));

    const calls: ExtractedCall[] = [
      {
        filePath: appFile,
        calledName: 'User',
        sourceId: 'Function:src/app.ts:main',
        argCount: 1,
        callForm: 'constructor',
        argTypes: ['string'],
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe(userCtorId);
  });

  it('constructor overload disambiguation: null-routes when disambiguation cannot pick unique survivor', async () => {
    // Control test for Finding 2 fix: when `preComputedArgTypes` does not
    // match any candidate uniquely, the dispatcher must null-route rather
    // than pick arbitrarily. Preserves SM-10 R3.
    const userFile = 'src/models/User.ts';
    const repoFile = 'src/models/Repo.ts';
    const appFile = 'src/app.ts';
    const userClassId = 'Class:src/models/User.ts:User';
    const repoClassId = 'Class:src/models/Repo.ts:User';
    const userCtorId = 'Constructor:src/models/User.ts:User(string)';
    const repoCtorId = 'Constructor:src/models/Repo.ts:User(string)';

    ctx.model.symbols.add(userFile, 'User', userClassId, 'Class');
    ctx.model.symbols.add(repoFile, 'User', repoClassId, 'Class');
    // Both constructors take `string` — genuinely ambiguous.
    ctx.model.symbols.add(userFile, 'User', userCtorId, 'Constructor', {
      ownerId: userClassId,
      parameterCount: 1,
      parameterTypes: ['string'],
    });
    ctx.model.symbols.add(repoFile, 'User', repoCtorId, 'Constructor', {
      ownerId: repoClassId,
      parameterCount: 1,
      parameterTypes: ['string'],
    });
    ctx.importMap.set(appFile, new Set([userFile, repoFile]));

    const calls: ExtractedCall[] = [
      {
        filePath: appFile,
        calledName: 'User',
        sourceId: 'Function:src/app.ts:main',
        argCount: 1,
        callForm: 'constructor',
        argTypes: ['string'],
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });
});

// ---- processAssignmentsFromExtracted: Phase 9 accumulator fallback ----

describe('processAssignmentsFromExtracted', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  it('Phase 9: accumulator fallback resolves receiver type for ACCESSES write edge', () => {
    // getUser is in the SymbolTable WITHOUT a returnType. The accumulator
    // carries getUser → User from the source file. The constructor binding
    // binds x = getUser(). The assignment x.address = value should produce
    // an ACCESSES write edge to User.address via the accumulator fallback.
    ctx.model.symbols.add('src/api.ts', 'getUser', 'Function:src/api.ts:getUser', 'Function');
    ctx.model.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.model.symbols.add(
      'src/models.ts',
      'address',
      'Property:src/models.ts:address',
      'Property',
      {
        ownerId: 'Class:src/models.ts:User',
      },
    );
    ctx.importMap.set('src/consumer.ts', new Set(['src/api.ts', 'src/models.ts']));
    ctx.namedImportMap.set(
      'src/consumer.ts',
      new Map([['getUser', { sourcePath: 'src/api.ts', exportedName: 'getUser' }]]),
    );

    const acc = new BindingAccumulator();
    acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'User' }]);

    const constructorBindings: FileConstructorBindings[] = [
      {
        filePath: 'src/consumer.ts',
        bindings: [{ scope: 'main@0', varName: 'x', calleeName: 'getUser' }],
      },
    ];

    const assignments: ExtractedAssignment[] = [
      {
        filePath: 'src/consumer.ts',
        sourceId: 'Function:src/consumer.ts:main',
        receiverText: 'x',
        propertyName: 'address',
      },
    ];

    processAssignmentsFromExtracted(graph, assignments, ctx, constructorBindings, acc);

    const accesses = graph.relationships.filter(
      (r) => r.type === 'ACCESSES' && r.reason === 'write',
    );
    expect(accesses).toHaveLength(1);
    expect(accesses[0].targetId).toBe('Property:src/models.ts:address');
  });
});

// ---- D2 widen: module-alias + lookupCallableByName resolves method in aliased file ----

describe('D2 widen path: lookupCallableByName via module alias', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;
  let prevRegistryPython: string | undefined;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
    // Force legacy DAG for .py fixtures — Python is registry-primary
    // by default (MIGRATED_LANGUAGES) which would gate processCalls out.
    prevRegistryPython = process.env['REGISTRY_PRIMARY_PYTHON'];
    process.env['REGISTRY_PRIMARY_PYTHON'] = 'false';
  });

  afterEach(() => {
    if (prevRegistryPython === undefined) delete process.env['REGISTRY_PRIMARY_PYTHON'];
    else process.env['REGISTRY_PRIMARY_PYTHON'] = prevRegistryPython;
  });

  it('resolves method via module alias widen using lookupCallableByName', async () => {
    // Python pattern: `import auth; auth.login()` — auth is a module alias
    // pointing to auth.py. login() is defined only in auth.py (not imported
    // by consumer.py). The D2 widen path should find login via the global
    // callable index filtered to the aliased module file.
    ctx.model.symbols.add('src/auth.py', 'login', 'Function:src/auth.py:login', 'Function');
    // Consumer has a same-file function that shadows 'login' at Tier 1
    ctx.model.symbols.add('src/consumer.py', 'login', 'Function:src/consumer.py:login', 'Function');
    // Module alias: consumer.py → auth → src/auth.py
    ctx.moduleAliasMap.set('src/consumer.py', new Map([['auth', 'src/auth.py']]));

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.py',
        calledName: 'login',
        sourceId: 'Function:src/consumer.py:main',
        receiverName: 'auth',
        callForm: 'member',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter((r) => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    // Should resolve to auth.py's login, NOT consumer.py's same-file shadow
    expect(rels[0].targetId).toBe('Function:src/auth.py:login');
  });
});
