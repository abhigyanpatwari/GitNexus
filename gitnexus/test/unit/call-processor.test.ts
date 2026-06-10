import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processCalls,
  processCallsFromExtracted,
  seedCrossFileReceiverTypes,
  extractConsumerAccessedKeys,
  processNextjsFetchRoutes,
  type CorrectionFeedItem,
  type RecallFeedItem,
} from '../../src/core/ingestion/call-processor.js';
import { extractReturnTypeName } from '../../src/core/ingestion/type-extractors/shared.js';
import { createResolutionContext, type ResolutionContext } from '../../src/core/ingestion/resolution-context.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import type { ExtractedCall, ExtractedFetchCall, FileConstructorBindings } from '../../src/core/ingestion/workers/parse-worker.js';

describe('processCallsFromExtracted', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  it('creates CALLS relationship for same-file resolution', async () => {
    ctx.symbols.add('src/index.ts', 'helper', 'Function:src/index.ts:helper', 'Function');

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'helper',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].sourceId).toBe('Function:src/index.ts:main');
    expect(rels[0].targetId).toBe('Function:src/index.ts:helper');
    expect(rels[0].confidence).toBe(0.95);
    expect(rels[0].reason).toBe('same-file');
  });

  it('creates CALLS relationship for import-resolved resolution', async () => {
    ctx.symbols.add('src/utils.ts', 'format', 'Function:src/utils.ts:format', 'Function');
    ctx.importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'format',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].confidence).toBe(0.9);
    expect(rels[0].reason).toBe('import-resolved');
  });

  it('resolves unique global symbol with moderate confidence', async () => {
    ctx.symbols.add('src/other.ts', 'uniqueFunc', 'Function:src/other.ts:uniqueFunc', 'Function');

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'uniqueFunc',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].confidence).toBe(0.5);
    expect(rels[0].reason).toBe('global');
  });

  it('refuses ambiguous global symbols — no CALLS edge created', async () => {
    ctx.symbols.add('src/a.ts', 'render', 'Function:src/a.ts:render', 'Function');
    ctx.symbols.add('src/b.ts', 'render', 'Function:src/b.ts:render', 'Function');

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'render',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('skips unresolvable calls', async () => {
    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'nonExistent',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationshipCount).toBe(0);
  });

  it('refuses non-callable symbols even when the name resolves', async () => {
    ctx.symbols.add('src/index.ts', 'Widget', 'Class:src/index.ts:Widget', 'Class');

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'Widget',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationshipCount).toBe(0);
  });

  it('refuses CALLS edges to Interface symbols', async () => {
    ctx.symbols.add('src/types.ts', 'Serializable', 'Interface:src/types.ts:Serializable', 'Interface');
    ctx.importMap.set('src/index.ts', new Set(['src/types.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'Serializable',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(0);
  });

  it('refuses CALLS edges to Enum symbols', async () => {
    ctx.symbols.add('src/status.ts', 'Status', 'Enum:src/status.ts:Status', 'Enum');
    ctx.importMap.set('src/index.ts', new Set(['src/status.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'Status',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(0);
  });

  it('prefers same-file over import-resolved', async () => {
    ctx.symbols.add('src/index.ts', 'render', 'Function:src/index.ts:render', 'Function');
    ctx.symbols.add('src/utils.ts', 'render', 'Function:src/utils.ts:render', 'Function');
    ctx.importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'render',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Function:src/index.ts:render');
    expect(rels[0].reason).toBe('same-file');
  });

  it('handles multiple calls from the same file', async () => {
    ctx.symbols.add('src/index.ts', 'foo', 'Function:src/index.ts:foo', 'Function');
    ctx.symbols.add('src/index.ts', 'bar', 'Function:src/index.ts:bar', 'Function');

    const calls: ExtractedCall[] = [
      { filePath: 'src/index.ts', calledName: 'foo', sourceId: 'Function:src/index.ts:main' },
      { filePath: 'src/index.ts', calledName: 'bar', sourceId: 'Function:src/index.ts:main' },
    ];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(2);
  });

  it('uses arity to disambiguate import-scoped callable candidates', async () => {
    ctx.symbols.add('src/logger.ts', 'log', 'Function:src/logger.ts:log', 'Function', { parameterCount: 0 });
    ctx.symbols.add('src/formatter.ts', 'log', 'Function:src/formatter.ts:log', 'Function', { parameterCount: 1 });
    ctx.importMap.set('src/index.ts', new Set(['src/logger.ts', 'src/formatter.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'log',
      sourceId: 'Function:src/index.ts:main',
      argCount: 1,
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Function:src/formatter.ts:log');
    expect(rels[0].reason).toBe('import-resolved');
  });

  it('refuses ambiguous call targets when arity does not produce a unique match', async () => {
    ctx.symbols.add('src/logger.ts', 'log', 'Function:src/logger.ts:log', 'Function', { parameterCount: 1 });
    ctx.symbols.add('src/formatter.ts', 'log', 'Function:src/formatter.ts:log', 'Function', { parameterCount: 1 });
    ctx.importMap.set('src/index.ts', new Set(['src/logger.ts', 'src/formatter.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'log',
      sourceId: 'Function:src/index.ts:main',
      argCount: 1,
    }];

    await processCallsFromExtracted(graph, calls, ctx);
    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(0);
  });

  it('calls progress callback', async () => {
    ctx.symbols.add('src/index.ts', 'foo', 'Function:src/index.ts:foo', 'Function');

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
    ctx.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'User',
      sourceId: 'Function:src/index.ts:main',
      callForm: 'constructor',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Class:src/models.ts:User');
    expect(rels[0].reason).toBe('import-resolved');
  });

  it('resolves constructor call to Constructor node over Class node', async () => {
    ctx.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.symbols.add('src/models.ts', 'User', 'Constructor:src/models.ts:User', 'Constructor', { parameterCount: 1 });
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'User',
      sourceId: 'Function:src/index.ts:main',
      argCount: 1,
      callForm: 'constructor',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Constructor:src/models.ts:User');
  });

  it('refuses Class target without callForm=constructor (existing behavior)', async () => {
    ctx.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'User',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('constructor call falls back to callable types when no Constructor/Class found', async () => {
    ctx.symbols.add('src/utils.ts', 'Widget', 'Function:src/utils.ts:Widget', 'Function');
    ctx.importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'Widget',
      sourceId: 'Function:src/index.ts:main',
      callForm: 'constructor',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Function:src/utils.ts:Widget');
  });

  it('constructor arity filtering narrows overloaded constructors', async () => {
    ctx.symbols.add('src/models.ts', 'User', 'Constructor:src/models.ts:User(0)', 'Constructor', { parameterCount: 0 });
    ctx.symbols.add('src/models.ts', 'User', 'Constructor:src/models.ts:User(2)', 'Constructor', { parameterCount: 2 });
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'User',
      sourceId: 'Function:src/index.ts:main',
      argCount: 2,
      callForm: 'constructor',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Constructor:src/models.ts:User(2)');
  });

  it('cannot discriminate same-arity overloads by parameter type (known limitation)', async () => {
    ctx.symbols.add('src/UserDao.ts', 'save', 'Function:src/UserDao.ts:save', 'Function', { parameterCount: 1 });
    ctx.symbols.add('src/RepoDao.ts', 'save', 'Function:src/RepoDao.ts:save', 'Function', { parameterCount: 1 });
    ctx.importMap.set('src/index.ts', new Set(['src/UserDao.ts', 'src/RepoDao.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'save',
      sourceId: 'Function:src/index.ts:main',
      argCount: 1,
    }];

    await processCallsFromExtracted(graph, calls, ctx);
    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  // ---- Return type inference (Phase 4) ----

  it('return type inference: binds variable to return type of callee', async () => {
    // getUser() returns User, and User has a save() method
    ctx.symbols.add('src/utils.ts', 'getUser', 'Function:src/utils.ts:getUser', 'Function', { returnType: 'User' });
    ctx.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', { ownerId: 'Class:src/models.ts:User' });
    ctx.importMap.set('src/index.ts', new Set(['src/utils.ts', 'src/models.ts']));

    // Binding: user = getUser() — getUser is not a class, so constructor path fails,
    // but return type inference should kick in
    const constructorBindings: FileConstructorBindings[] = [{
      filePath: 'src/index.ts',
      bindings: [
        { scope: 'main@0', varName: 'user', calleeName: 'getUser' },
      ],
    }];

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'save',
      sourceId: 'Function:src/index.ts:main',
      receiverName: 'user',
      callForm: 'member',
    }];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  it('return type inference: unwraps Promise<User> to User', async () => {
    ctx.symbols.add('src/api.ts', 'fetchUser', 'Function:src/api.ts:fetchUser', 'Function', { returnType: 'Promise<User>' });
    ctx.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', { ownerId: 'Class:src/models.ts:User' });
    ctx.importMap.set('src/index.ts', new Set(['src/api.ts', 'src/models.ts']));

    const constructorBindings: FileConstructorBindings[] = [{
      filePath: 'src/index.ts',
      bindings: [
        { scope: 'main@0', varName: 'user', calleeName: 'fetchUser' },
      ],
    }];

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'save',
      sourceId: 'Function:src/index.ts:main',
      receiverName: 'user',
      callForm: 'member',
    }];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  it('return type inference: skips when return type is primitive', async () => {
    ctx.symbols.add('src/utils.ts', 'getCount', 'Function:src/utils.ts:getCount', 'Function', { returnType: 'number' });
    ctx.importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const constructorBindings: FileConstructorBindings[] = [{
      filePath: 'src/index.ts',
      bindings: [
        { scope: 'main@0', varName: 'count', calleeName: 'getCount' },
      ],
    }];

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'toString',
      sourceId: 'Function:src/index.ts:main',
      receiverName: 'count',
      callForm: 'member',
    }];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    // No binding should be created for primitive return types
    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('return type inference: skips ambiguous callees (multiple definitions)', async () => {
    ctx.symbols.add('src/a.ts', 'getData', 'Function:src/a.ts:getData', 'Function', { returnType: 'User' });
    ctx.symbols.add('src/b.ts', 'getData', 'Function:src/b.ts:getData', 'Function', { returnType: 'Repo' });

    const constructorBindings: FileConstructorBindings[] = [{
      filePath: 'src/index.ts',
      bindings: [
        { scope: 'main@0', varName: 'data', calleeName: 'getData' },
      ],
    }];

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'save',
      sourceId: 'Function:src/index.ts:main',
      receiverName: 'data',
      callForm: 'member',
    }];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    // Ambiguous callee — don't guess
    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('return type inference: prefers constructor binding over return type', async () => {
    // If the callee IS a class, constructor binding wins (existing behavior)
    ctx.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', { ownerId: 'Class:src/models.ts:User' });
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const constructorBindings: FileConstructorBindings[] = [{
      filePath: 'src/index.ts',
      bindings: [
        { scope: 'main@0', varName: 'user', calleeName: 'User' },
      ],
    }];

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'save',
      sourceId: 'Function:src/index.ts:main',
      receiverName: 'user',
      callForm: 'member',
    }];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  // ---- Scope-aware constructor bindings (Phase 3) ----

  it('receiverKey collision: same method name in different classes does not collide', async () => {
    // User.save@100 and Repo.save@200 are two methods named "save" in different classes.
    // Each has a local variable "db" pointing to a different type.
    // Without @startIndex in the key, the second binding would overwrite the first.
    ctx.symbols.add('src/db/Database.ts', 'Database', 'Class:src/db/Database.ts:Database', 'Class');
    ctx.symbols.add('src/db/Cache.ts', 'Cache', 'Class:src/db/Cache.ts:Cache', 'Class');
    ctx.symbols.add('src/db/Database.ts', 'query', 'Method:src/db/Database.ts:query', 'Method', { ownerId: 'Class:src/db/Database.ts:Database' });
    ctx.symbols.add('src/db/Cache.ts', 'query', 'Method:src/db/Cache.ts:query', 'Method', { ownerId: 'Class:src/db/Cache.ts:Cache' });
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

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(2);
    const userQueryRel = rels.find(r => r.sourceId === 'Method:src/models/User.ts:save');
    const repoQueryRel = rels.find(r => r.sourceId === 'Method:src/models/Repo.ts:save');
    expect(userQueryRel?.targetId).toBe('Method:src/db/Database.ts:query');
    expect(repoQueryRel?.targetId).toBe('Method:src/db/Cache.ts:query');
  });

  it('receiverKey collision: same scope funcName + same varName + same type resolves (non-ambiguous)', async () => {
    // Two save@* scopes both bind "db" to the same type — not ambiguous, should resolve.
    ctx.symbols.add('src/db/Database.ts', 'Database', 'Class:src/db/Database.ts:Database', 'Class');
    ctx.symbols.add('src/db/Database.ts', 'query', 'Method:src/db/Database.ts:query', 'Method', { ownerId: 'Class:src/db/Database.ts:Database' });
    ctx.importMap.set('src/service.ts', new Set(['src/db/Database.ts']));

    const constructorBindings: FileConstructorBindings[] = [{
      filePath: 'src/service.ts',
      bindings: [
        { scope: 'save@10', varName: 'db', calleeName: 'Database' },
        { scope: 'save@50', varName: 'db', calleeName: 'Database' },
      ],
    }];

    const calls: ExtractedCall[] = [{
      filePath: 'src/service.ts',
      calledName: 'query',
      sourceId: 'Method:src/service.ts:save',
      receiverName: 'db',
      callForm: 'member',
    }];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/db/Database.ts:query');
  });

  it('receiverKey collision: same scope funcName + same varName + different types → ambiguous, no CALLS edge', async () => {
    // Two save@* scopes in the same file bind "db" to different types — truly ambiguous.
    ctx.symbols.add('src/db/Database.ts', 'Database', 'Class:src/db/Database.ts:Database', 'Class');
    ctx.symbols.add('src/db/Cache.ts', 'Cache', 'Class:src/db/Cache.ts:Cache', 'Class');
    ctx.symbols.add('src/db/Database.ts', 'query', 'Method:src/db/Database.ts:query', 'Method', { ownerId: 'Class:src/db/Database.ts:Database' });
    ctx.symbols.add('src/db/Cache.ts', 'query', 'Method:src/db/Cache.ts:query', 'Method', { ownerId: 'Class:src/db/Cache.ts:Cache' });
    ctx.importMap.set('src/service.ts', new Set(['src/db/Database.ts', 'src/db/Cache.ts']));

    const constructorBindings: FileConstructorBindings[] = [{
      filePath: 'src/service.ts',
      bindings: [
        { scope: 'save@10', varName: 'db', calleeName: 'Database' },
        { scope: 'save@50', varName: 'db', calleeName: 'Cache' },
      ],
    }];

    const calls: ExtractedCall[] = [{
      filePath: 'src/service.ts',
      calledName: 'query',
      sourceId: 'Method:src/service.ts:save',
      receiverName: 'db',
      callForm: 'member',
    }];

    await processCallsFromExtracted(graph, calls, ctx, undefined, constructorBindings);

    // Ambiguous — different types for same funcName+varName, should not emit a CALLS edge
    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('scope-aware bindings: same varName in different functions resolves to correct type', async () => {
    ctx.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.symbols.add('src/models.ts', 'Repo', 'Class:src/models.ts:Repo', 'Class');
    ctx.symbols.add('src/models.ts', 'save', 'Function:src/models.ts:save', 'Function');
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const constructorBindings: FileConstructorBindings[] = [{
      filePath: 'src/index.ts',
      bindings: [
        { scope: 'processUser@12', varName: 'obj', calleeName: 'User' },
        { scope: 'processRepo@89', varName: 'obj', calleeName: 'Repo' },
      ],
    }];

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

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(2);
    // Both calls should resolve, each with the correct receiver type from their scope
    // (the important thing is they don't collide — without scope awareness,
    // last-write-wins would give both calls the same receiver type)
    expect(rels[0].sourceId).toBe('Function:src/index.ts:processUser');
    expect(rels[1].sourceId).toBe('Function:src/index.ts:processRepo');
  });

  // ---- D5: Interface implementation lookup ----

  function makeMockGraph(relationships: Array<{ sourceId: string; targetId: string; type: string }>) {
    const rels = [...relationships];
    return {
      addRelationship: (rel: { id: string; sourceId: string; targetId: string; type: string; confidence: number; reason: string }) => {
        rels.push(rel);
        return rel.id;
      },
      forEachRelationship: (fn: (rel: { id?: string; sourceId: string; targetId: string; type: string; confidence?: number; reason?: string }) => void) => {
        rels.forEach(fn);
      },
      relationships: rels,
    } as unknown as import('../../src/core/graph/graph.js').KnowledgeGraph;
  }

  it('D5: resolves method call to implementing class when receiver type is an Interface', async () => {
    // Receiver type 'Repository' is an Interface with one implementer 'UserRepo'
    // D4 ownerId fallback fails (no match), D5 finds 'UserRepo' as the implementer
    // and filters the method pool to methods owned by UserRepo
    ctx.symbols.add('src/types.ts', 'Repository', 'Interface:src/types.ts:Repository', 'Interface');
    ctx.symbols.add('src/models.ts', 'UserRepo', 'Class:src/models.ts:UserRepo', 'Class');
    ctx.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', { ownerId: 'Class:src/models.ts:UserRepo' });
    ctx.importMap.set('src/index.ts', new Set(['src/types.ts', 'src/models.ts']));

    const graph = makeMockGraph([
      { sourceId: 'Class:src/models.ts:UserRepo', targetId: 'Interface:src/types.ts:Repository', type: 'IMPLEMENTS' },
    ]);
    ctx.graph = graph;

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'save',
      sourceId: 'Function:src/index.ts:main',
      receiverTypeName: 'Repository',
      callForm: 'member',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
    expect(rels[0].reason).toBe('import-resolved'); // D5 tier (Interface found via import resolution)
  });

  it('D5: returns null when D4 fails and interface has no implementers', async () => {
    // D4 ownerId fallback fails; D5 finds no implementing classes -> returns null
    // Must have multiple candidates to reach D5 (single candidate returns early)
    ctx.symbols.add('src/types.ts', 'Repository', 'Interface:src/types.ts:Repository', 'Interface');
    ctx.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', { ownerId: 'Class:src/models.ts:UserRepo' });
    // Add another save candidate to force D1-D5 resolution path
    ctx.symbols.add('src/other.ts', 'save', 'Method:src/other.ts:save', 'Method', { ownerId: 'Class:src/other.ts:OtherRepo' });
    ctx.importMap.set('src/index.ts', new Set(['src/types.ts']));

    const graph = makeMockGraph([]); // No IMPLEMENTS edges
    ctx.graph = graph;

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'save',
      sourceId: 'Function:src/index.ts:main',
      receiverTypeName: 'Repository',
      callForm: 'member',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('D5: no D5 activation for class types (D4 behavior preserved)', async () => {
    // When receiver type is a Class (not Interface), D5 should not activate.
    // D4 ownerId matching handles it.
    ctx.symbols.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    ctx.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', { ownerId: 'Class:src/models.ts:User' });
    ctx.importMap.set('src/index.ts', new Set(['src/models.ts']));

    const graph = makeMockGraph([
      // Even if there is an IMPLEMENTS edge, D5 should not fire for Class types
      { sourceId: 'Class:src/models.ts:User', targetId: 'Interface:src/types.ts:Repository', type: 'IMPLEMENTS' },
    ]);
    ctx.graph = graph;

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'save',
      sourceId: 'Function:src/index.ts:main',
      receiverTypeName: 'User',
      callForm: 'member',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Method:src/models.ts:save');
  });

  it('D5: multiple implementers — ambiguous, returns null without overload hints', async () => {
    // Two classes implement 'Repository': UserRepo and AdminRepo.
    // Both have 'save' methods. Without overload disambiguation, this is ambiguous.
    ctx.symbols.add('src/types.ts', 'Repository', 'Interface:src/types.ts:Repository', 'Interface');
    ctx.symbols.add('src/models.ts', 'UserRepo', 'Class:src/models.ts:UserRepo', 'Class');
    ctx.symbols.add('src/models.ts', 'AdminRepo', 'Class:src/models.ts:AdminRepo', 'Class');
    ctx.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', { ownerId: 'Class:src/models.ts:UserRepo' });
    ctx.symbols.add('src/models.ts', 'save', 'Method:src/models.ts:save', 'Method', { ownerId: 'Class:src/models.ts:AdminRepo' });
    ctx.importMap.set('src/index.ts', new Set(['src/types.ts', 'src/models.ts']));

    const graph = makeMockGraph([
      { sourceId: 'Class:src/models.ts:UserRepo', targetId: 'Interface:src/types.ts:Repository', type: 'IMPLEMENTS' },
      { sourceId: 'Class:src/models.ts:AdminRepo', targetId: 'Interface:src/types.ts:Repository', type: 'IMPLEMENTS' },
    ]);
    ctx.graph = graph;

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'save',
      sourceId: 'Function:src/index.ts:main',
      receiverTypeName: 'Repository',
      callForm: 'member',
    }];

    await processCallsFromExtracted(graph, calls, ctx);

    // Multiple implementers, no overload hints -> ambiguous
    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  // ---- WI-2 — Mode A candidate feed (correction + recall) ----

  it('default path: feeds stay empty and CALLS counts are identical', async () => {
    ctx.symbols.add('src/other.ts', 'uniqueFunc', 'Function:src/other.ts:uniqueFunc', 'Function');

    // Mix of resolvable (global), unresolvable (no candidate), and same-file so
    // the assertion isn't a single-edge happy path.
    const calls: ExtractedCall[] = [
      { filePath: 'src/index.ts', calledName: 'uniqueFunc', sourceId: 'Function:src/index.ts:main', line: 10, character: 4 },
      { filePath: 'src/index.ts', calledName: 'doesNotExist', sourceId: 'Function:src/index.ts:main', line: 20, character: 4 },
    ];

    const correctionFeed: import('../../src/core/ingestion/call-processor.js').CorrectionFeedItem[] = [];
    const recallFeed: import('../../src/core/ingestion/call-processor.js').RecallFeedItem[] = [];
    const opts = { lsp: false, correctionFeed, recallFeed };

    await processCallsFromExtracted(graph, calls, ctx, undefined, undefined, undefined, opts);

    const callsCount = graph.relationships.filter(r => r.type === 'CALLS').length;
    expect(callsCount).toBe(1);
    // Feeds must not be touched when opts.lsp is false.
    expect(correctionFeed).toEqual([]);
    expect(recallFeed).toEqual([]);
  });

  it('lsp:true — global-0.50 edges populate the correction feed', async () => {
    ctx.symbols.add('src/other.ts', 'uniqueFunc', 'Function:src/other.ts:uniqueFunc', 'Function');

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'uniqueFunc',
      sourceId: 'Function:src/index.ts:main',
      line: 42,
      character: 7,
    }];

    const correctionFeed: import('../../src/core/ingestion/call-processor.js').CorrectionFeedItem[] = [];
    const recallFeed: import('../../src/core/ingestion/call-processor.js').RecallFeedItem[] = [];

    await processCallsFromExtracted(
      graph, calls, ctx, undefined, undefined, undefined,
      { lsp: true, correctionFeed, recallFeed },
    );

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].reason).toBe('global');
    expect(rels[0].confidence).toBe(0.5);

    expect(correctionFeed).toEqual([{
      sourceId: 'Function:src/index.ts:main',
      calledName: 'uniqueFunc',
      oldTargetId: 'Function:src/other.ts:uniqueFunc',
      file: 'src/index.ts',
      line: 42,
      character: 7,
    }]);
    expect(recallFeed).toEqual([]);
  });

  it('lsp:true — unresolved/ambiguous sites populate the recall feed', async () => {
    // Two symbols named the same → ambiguous → recall feed.
    ctx.symbols.add('src/a.ts', 'render', 'Function:src/a.ts:render', 'Function');
    ctx.symbols.add('src/b.ts', 'render', 'Function:src/b.ts:render', 'Function');
    // No candidate at all → recall feed.
    const calls: ExtractedCall[] = [
      { filePath: 'src/index.ts', calledName: 'render', sourceId: 'Function:src/index.ts:main', line: 5, character: 3 },
      { filePath: 'src/index.ts', calledName: 'ghost', sourceId: 'Function:src/index.ts:main', line: 8, character: 3 },
    ];

    const correctionFeed: import('../../src/core/ingestion/call-processor.js').CorrectionFeedItem[] = [];
    const recallFeed: import('../../src/core/ingestion/call-processor.js').RecallFeedItem[] = [];

    await processCallsFromExtracted(
      graph, calls, ctx, undefined, undefined, undefined,
      { lsp: true, correctionFeed, recallFeed },
    );

    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(0);
    expect(correctionFeed).toEqual([]);
    expect(recallFeed).toEqual([
      { sourceId: 'Function:src/index.ts:main', calledName: 'render', file: 'src/index.ts', line: 5, character: 3 },
      { sourceId: 'Function:src/index.ts:main', calledName: 'ghost',  file: 'src/index.ts', line: 8, character: 3 },
    ]);
  });

  it('member-call a.b.c() records the `c` position, not the `a` position', async () => {
    // We can\'t drive real tree-sitter here; instead assert that whatever
    // line/character ExtractedCall carries is what the feed records.
    // The worker (parse-worker.ts:2682) emits `callNameNode.startPosition`, which
    // is the `c` identifier for `a.b.c()`. This test pins the contract.
    ctx.symbols.add('src/other.ts', 'c', 'Function:src/other.ts:c', 'Function');

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'c',
      callForm: 'member',
      receiverName: 'a',
      sourceId: 'Function:src/index.ts:main',
      // Empirically the column of `c` in `a.b.c()` is the column of `c` itself,
      // not of `a`. Worker passes callNameNode.startPosition through unchanged.
      line: 100,
      character: 8,
    }];

    const correctionFeed: import('../../src/core/ingestion/call-processor.js').CorrectionFeedItem[] = [];
    const recallFeed: import('../../src/core/ingestion/call-processor.js').RecallFeedItem[] = [];

    await processCallsFromExtracted(
      graph, calls, ctx, undefined, undefined, undefined,
      { lsp: true, correctionFeed, recallFeed },
    );

    expect(correctionFeed).toEqual([{
      sourceId: 'Function:src/index.ts:main',
      calledName: 'c',
      oldTargetId: 'Function:src/other.ts:c',
      file: 'src/index.ts',
      line: 100,
      character: 8,
    }]);
  });
});

describe('processCalls — Mode A candidate feeds (WI-1 / #166)', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  // AC-5: default analyze (opts undefined) is byte-identical; feeds stay empty.
  // Drives the active sequential resolver on a real TypeScript file with a single
  // call site and asserts (a) the CALLS edge exists and (b) the default path
  // (no opts arg) does not error. Since the default path has no feed handles,
  // the byte-identity invariant is that the call signature accepts a missing
  // 10th arg without complaint — the gated `opts?.lsp && opts.<feed>` predicates
  // short-circuit to falsy and no push ever runs.
  it('default path (opts undefined) — identical CALLS counts, no error, signature accepts missing 10th arg', async () => {
    ctx.symbols.add('src/utils.ts', 'format', 'Function:src/utils.ts:format', 'Function');
    ctx.importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const files = [
      {
        path: 'src/index.ts',
        content: 'import { format } from "./utils";\nexport function main() { format("hi"); }\n',
      },
    ];

    // No opts arg → all gated push predicates (`opts?.lsp && opts.<feed>`) are falsy.
    const heritage = await processCalls(graph, files, createASTCache(files.length), ctx);
    expect(heritage).toEqual([]);

    const callsEdges = graph.relationships.filter(r => r.type === 'CALLS');
    expect(callsEdges).toHaveLength(1);
    // Graph-level default stamp is 'heuristic' (B1 integration contract);
    // KD-7 serializer-side default only kicks in on the DB write path.
    expect(callsEdges[0].source).toBe('heuristic');
  });

  // AC-1: a `global`-0.50 site populates `correctionFeed` with the callee
  // identifier position when opts.lsp is true.
  it('lsp:true — global-0.50 site populates the correction feed with callee-identifier position', async () => {
    ctx.symbols.add('src/other.ts', 'uniqueFunc', 'Function:src/other.ts:uniqueFunc', 'Function');

    const files = [
      { path: 'src/caller.ts', content: 'export function main() { uniqueFunc(); }\n' },
    ];
    const cf: CorrectionFeedItem[] = [];
    const rf: RecallFeedItem[] = [];

    await processCalls(
      graph, files, createASTCache(files.length), ctx,
      undefined, undefined, undefined, undefined, undefined,
      { lsp: true, correctionFeed: cf, recallFeed: rf },
    );

    const callsEdges = graph.relationships.filter(r => r.type === 'CALLS');
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0].reason).toBe('global');
    expect(callsEdges[0].confidence).toBe(0.5);

    expect(rf).toEqual([]);
    expect(cf).toHaveLength(1);
    const item = cf[0];
    expect(item.sourceId).toBe('Function:src/caller.ts:main');
    expect(item.calledName).toBe('uniqueFunc');
    expect(item.oldTargetId).toBe('Function:src/other.ts:uniqueFunc');
    expect(item.file).toBe('src/caller.ts');
    // The `uniqueFunc` identifier starts on line 0 (zero-indexed), at the column
    // immediately after `main() { ` — pins the callee-identifier position contract.
    expect(item.line).toBe(0);
    expect(typeof item.character).toBe('number');
    expect(item.character).toBeGreaterThanOrEqual(0);
  });

  // AC-1 / I-2: an unresolved site populates `recallFeed` (no `oldTargetId`).
  it('lsp:true — unresolved site populates the recall feed (no oldTargetId)', async () => {
    const files = [
      { path: 'src/caller.ts', content: 'export function main() { ghostCall(); }\n' },
    ];
    const cf: CorrectionFeedItem[] = [];
    const rf: RecallFeedItem[] = [];

    await processCalls(
      graph, files, createASTCache(files.length), ctx,
      undefined, undefined, undefined, undefined, undefined,
      { lsp: true, correctionFeed: cf, recallFeed: rf },
    );

    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(0);
    expect(cf).toEqual([]);
    expect(rf).toHaveLength(1);
    expect(rf[0].sourceId).toBe('Function:src/caller.ts:main');
    expect(rf[0].calledName).toBe('ghostCall');
    expect(rf[0].file).toBe('src/caller.ts');
    // 'oldTargetId' is intentionally absent on recall items.
    expect((rf[0] as any).oldTargetId).toBeUndefined();
  });

  // AC-2: a member call `a.b.c()` records the `.c` callee-identifier position.
  // The capture parse-worker uses for the call.name is the `c` identifier
  // (call-processor.ts:460-462), not the receiver `a`. The resolver falls
  // through to a global lookup for `c` and finds it (we seeded it), so this
  // site lands in the *correction* feed (reason: 'global', confidence: 0.5).
  it('lsp:true — member call a.b.c() records the .c callee-identifier position, not the receiver', async () => {
    ctx.symbols.add('src/other.ts', 'c', 'Function:src/other.ts:c', 'Function');

    // Line 1 has the call: `  a.b.c();`
    //   0123456789
    //     a.b.c();
    // So `c` is at column 6 of line 1 (NOT the column of `a` at col 2).
    const files = [
      {
        path: 'src/caller.ts',
        content: 'export function main() {\n  a.b.c();\n}\n',
      },
    ];
    const cf: CorrectionFeedItem[] = [];
    const rf: RecallFeedItem[] = [];

    await processCalls(
      graph, files, createASTCache(files.length), ctx,
      undefined, undefined, undefined, undefined, undefined,
      { lsp: true, correctionFeed: cf, recallFeed: rf },
    );

    // The call resolves globally → correction feed (AC-1 path).
    expect(rf).toEqual([]);
    expect(cf).toHaveLength(1);
    expect(cf[0].calledName).toBe('c');
    // Line 1 (the body line), not line 0 (the function signature).
    expect(cf[0].line).toBe(1);
    // The exact column of `c` in `  a.b.c();` — not the column of `a` (col 2).
    expect(cf[0].character).toBe(6);
  });

  // AC-3: a router/builtin-dropped site emits no recall candidate.
  // The TypeScript router classifies `console` as a built-in; `console.log`
  // is therefore routed-and-dropped by `isBuiltInName` at :522 (the
  // forEach early-return). No recall entry should be recorded.
  it('lsp:true — router/builtin-dropped site emits no recall candidate', async () => {
    const files = [
      { path: 'src/caller.ts', content: 'export function main() { console.log("x"); }\n' },
    ];
    const cf: CorrectionFeedItem[] = [];
    const rf: RecallFeedItem[] = [];

    await processCalls(
      graph, files, createASTCache(files.length), ctx,
      undefined, undefined, undefined, undefined, undefined,
      { lsp: true, correctionFeed: cf, recallFeed: rf },
    );

    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(0);
    // Built-in name pre-filter must not push any feed entries.
    expect(cf).toEqual([]);
    expect(rf).toEqual([]);
  });

  // AC-5 / I-1: opts.lsp=false (or opts without lsp:true) must be a no-op
  // on the feeds while preserving the CALLS count exactly.
  it('lsp:false (or truthy opts without lsp) — feeds stay empty, CALLS count unchanged', async () => {
    ctx.symbols.add('src/other.ts', 'uniqueFunc', 'Function:src/other.ts:uniqueFunc', 'Function');

    const files = [
      { path: 'src/caller.ts', content: 'export function main() { uniqueFunc(); }\n' },
    ];
    const cf: CorrectionFeedItem[] = [];
    const rf: RecallFeedItem[] = [];

    // Pass `lsp:false` explicitly. The push predicates short-circuit on
    // `opts?.lsp === false`, so the function still emits the CALLS edge
    // (the default behavior) but never touches the feed arrays.
    await processCalls(
      graph, files, createASTCache(files.length), ctx,
      undefined, undefined, undefined, undefined, undefined,
      { lsp: false, correctionFeed: cf, recallFeed: rf },
    );

    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(1);
    expect(cf).toEqual([]);
    expect(rf).toEqual([]);
  });
});

describe('candidateLocationKey dedup (WI-1 / #166)', () => {
  // AC-4: a call site reachable by both producers (`processCalls` + Angular
  // post-pass) yields exactly one candidate after dedup.
  // The dedup happens in `pipeline.ts` between the merge site and
  // `withReconciliationSession`. We assert the *function* of the dedup
  // (Map-keyed uniqueness by `candidateLocationKey`) by replaying the
  // shape directly: two candidates with identical (sourceId, calledName,
  // file, line, character) must collapse to one.
  it('two producers reaching the same site collapse to one candidate', async () => {
    const { candidateLocationKey } = await import(
      '../../src/core/ingestion/mode-a-reconciler.js'
    );
    type Candidate = {
      sourceId: string;
      calledName: string;
      oldTargetId?: string;
      file: string;
      line: number;
      character: number;
    };

    const shared = {
      sourceId: 'Function:src/a.ts:main',
      calledName: 'foo',
      file: 'src/a.ts',
      line: 10,
      character: 4,
    };

    const correction: Candidate = { ...shared, oldTargetId: 'Function:src/b.ts:foo' };
    const recall: Candidate = { ...shared }; // no oldTargetId

    // Simulate the pipeline merge order: correction first, then recall.
    const candidates: Candidate[] = [correction, recall];

    const deduped: Candidate[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      const k = candidateLocationKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(c);
    }

    expect(deduped).toHaveLength(1);
    // First-writer wins: the correction shape (with oldTargetId) is kept,
    // not the recall shape. This matters because the engine keys its
    // confirmation pass on `oldTargetId`.
    expect(deduped[0].oldTargetId).toBe('Function:src/b.ts:foo');
  });

  it('distinct sites are not collapsed by dedup', async () => {
    const { candidateLocationKey } = await import(
      '../../src/core/ingestion/mode-a-reconciler.js'
    );
    type Candidate = {
      sourceId: string;
      calledName: string;
      oldTargetId?: string;
      file: string;
      line: number;
      character: number;
    };

    const a: Candidate = {
      sourceId: 'Function:src/a.ts:main',
      calledName: 'foo',
      file: 'src/a.ts',
      line: 10, character: 4,
    };
    const b: Candidate = {
      sourceId: 'Function:src/a.ts:main',
      calledName: 'bar', // different calledName
      file: 'src/a.ts',
      line: 10, character: 4,
    };
    const c: Candidate = {
      sourceId: 'Function:src/a.ts:main',
      calledName: 'foo',
      file: 'src/a.ts',
      line: 11, character: 0, // different line
    };
    const d: Candidate = {
      sourceId: 'Function:src/a.ts:main',
      calledName: 'foo',
      file: 'src/a.ts',
      line: 10, character: 5, // different character
    };

    const all: Candidate[] = [a, b, c, d];
    const deduped: Candidate[] = [];
    const seen = new Set<string>();
    for (const x of all) {
      const k = candidateLocationKey(x);
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(x);
    }

    expect(deduped).toHaveLength(4);
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
    const calls: ExtractedCall[] = [{
      filePath: 'src/service.ts',
      calledName: 'save',
      sourceId: 'Function:src/service.ts:run',
      receiverName: 'repo',
      callForm: 'member',
    }];

    const namedImportMap = new Map([
      ['src/service.ts', new Map([
        ['repo', { sourcePath: 'src/models/repo.ts', exportedName: 'repo' }],
      ])],
    ]);

    const exportedTypeMap = new Map([
      ['src/models/repo.ts', new Map([
        ['repo', 'Repo'],
      ])],
    ]);

    const { enrichedCount } = seedCrossFileReceiverTypes(calls, namedImportMap, exportedTypeMap);

    expect(enrichedCount).toBe(1);
    expect(calls[0].receiverTypeName).toBe('Repo');
  });

  it('no-op when receiverTypeName already exists', () => {
    const calls: ExtractedCall[] = [{
      filePath: 'src/service.ts',
      calledName: 'save',
      sourceId: 'Function:src/service.ts:run',
      receiverName: 'repo',
      receiverTypeName: 'AlreadyKnown',
      callForm: 'member',
    }];

    const namedImportMap = new Map([
      ['src/service.ts', new Map([
        ['repo', { sourcePath: 'src/models/repo.ts', exportedName: 'repo' }],
      ])],
    ]);

    const exportedTypeMap = new Map([
      ['src/models/repo.ts', new Map([
        ['repo', 'Repo'],
      ])],
    ]);

    const { enrichedCount } = seedCrossFileReceiverTypes(calls, namedImportMap, exportedTypeMap);

    expect(enrichedCount).toBe(0);
    expect(calls[0].receiverTypeName).toBe('AlreadyKnown');
  });

  it('no-op for free function calls (callForm !== member)', () => {
    const calls: ExtractedCall[] = [{
      filePath: 'src/service.ts',
      calledName: 'doSomething',
      sourceId: 'Function:src/service.ts:run',
      receiverName: 'repo',
      callForm: 'free',
    }];

    const namedImportMap = new Map([
      ['src/service.ts', new Map([
        ['repo', { sourcePath: 'src/models/repo.ts', exportedName: 'repo' }],
      ])],
    ]);

    const exportedTypeMap = new Map([
      ['src/models/repo.ts', new Map([
        ['repo', 'Repo'],
      ])],
    ]);

    const { enrichedCount } = seedCrossFileReceiverTypes(calls, namedImportMap, exportedTypeMap);

    expect(enrichedCount).toBe(0);
    expect(calls[0].receiverTypeName).toBeUndefined();
  });

  it('aliased imports: local name maps to exported name via binding', () => {
    const calls: ExtractedCall[] = [{
      filePath: 'src/controller.ts',
      calledName: 'find',
      sourceId: 'Function:src/controller.ts:handle',
      receiverName: 'myRepo',
      callForm: 'member',
    }];

    // import { repoInstance as myRepo } from 'src/models/repo.ts'
    const namedImportMap = new Map([
      ['src/controller.ts', new Map([
        ['myRepo', { sourcePath: 'src/models/repo.ts', exportedName: 'repoInstance' }],
      ])],
    ]);

    const exportedTypeMap = new Map([
      ['src/models/repo.ts', new Map([
        ['repoInstance', 'Repo'],
      ])],
    ]);

    const { enrichedCount } = seedCrossFileReceiverTypes(calls, namedImportMap, exportedTypeMap);

    expect(enrichedCount).toBe(1);
    expect(calls[0].receiverTypeName).toBe('Repo');
  });

  it('early exit when maps are empty', () => {
    const calls: ExtractedCall[] = [{
      filePath: 'src/service.ts',
      calledName: 'save',
      sourceId: 'Function:src/service.ts:run',
      receiverName: 'repo',
      callForm: 'member',
    }];

    const { enrichedCount: countA } = seedCrossFileReceiverTypes(
      calls,
      new Map(),
      new Map([['src/models/repo.ts', new Map([['repo', 'Repo']])]]),
    );
    expect(countA).toBe(0);

    const { enrichedCount: countB } = seedCrossFileReceiverTypes(
      calls,
      new Map([['src/service.ts', new Map([['repo', { sourcePath: 'src/models/repo.ts', exportedName: 'repo' }]])]]),
      new Map(),
    );
    expect(countB).toBe(0);

    expect(calls[0].receiverTypeName).toBeUndefined();
  });

  it('no mutation when no matching exports found', () => {
    const calls: ExtractedCall[] = [{
      filePath: 'src/service.ts',
      calledName: 'save',
      sourceId: 'Function:src/service.ts:run',
      receiverName: 'repo',
      callForm: 'member',
    }];

    // namedImportMap has the file, but exportedTypeMap has no entry for the source path
    const namedImportMap = new Map([
      ['src/service.ts', new Map([
        ['repo', { sourcePath: 'src/models/repo.ts', exportedName: 'repo' }],
      ])],
    ]);

    const exportedTypeMap = new Map([
      ['src/other-file.ts', new Map([['something', 'OtherType']])],
    ]);

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
    const dataCount = keys.filter(k => k === 'data').length;
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
    graph.addNode({ id: 'File:src/page.tsx', label: 'File', properties: { name: 'src/page.tsx', filePath: 'src/page.tsx' } });

    const fetchCalls: ExtractedFetchCall[] = [
      { filePath: 'src/page.tsx', fetchURL: '/api/grants', lineNumber: 10 },
    ];
    const routeRegistry = new Map([[ '/api/grants', 'src/app/api/grants/route.ts' ]]);

    processNextjsFetchRoutes(graph, fetchCalls, routeRegistry);

    const rels = graph.relationships.filter(r => r.type === 'FETCHES');
    expect(rels).toHaveLength(1);
    expect(rels[0].reason).toBe('fetch-url-match');
  });

  it('creates FETCHES edge with accessed keys in reason when consumer contents provided', () => {
    graph.addNode({ id: 'File:src/page.tsx', label: 'File', properties: { name: 'src/page.tsx', filePath: 'src/page.tsx' } });

    const fetchCalls: ExtractedFetchCall[] = [
      { filePath: 'src/page.tsx', fetchURL: '/api/grants', lineNumber: 10 },
    ];
    const routeRegistry = new Map([[ '/api/grants', 'src/app/api/grants/route.ts' ]]);

    const consumerContents = new Map([
      ['src/page.tsx', `
        const res = await fetch('/api/grants');
        const { data, pagination } = await res.json();
        console.log(data.items);
      `],
    ]);

    processNextjsFetchRoutes(graph, fetchCalls, routeRegistry, consumerContents);

    const rels = graph.relationships.filter(r => r.type === 'FETCHES');
    expect(rels).toHaveLength(1);
    expect(rels[0].reason).toMatch(/^fetch-url-match\|keys:/);
    // Should contain the destructured keys
    expect(rels[0].reason).toContain('data');
    expect(rels[0].reason).toContain('pagination');
  });

  it('falls back to basic reason when consumer file has no property accesses', () => {
    graph.addNode({ id: 'File:src/page.tsx', label: 'File', properties: { name: 'src/page.tsx', filePath: 'src/page.tsx' } });

    const fetchCalls: ExtractedFetchCall[] = [
      { filePath: 'src/page.tsx', fetchURL: '/api/grants', lineNumber: 10 },
    ];
    const routeRegistry = new Map([[ '/api/grants', 'src/app/api/grants/route.ts' ]]);

    const consumerContents = new Map([
      ['src/page.tsx', `
        // This file just fetches without accessing properties
        await fetch('/api/grants');
      `],
    ]);

    processNextjsFetchRoutes(graph, fetchCalls, routeRegistry, consumerContents);

    const rels = graph.relationships.filter(r => r.type === 'FETCHES');
    expect(rels).toHaveLength(1);
    expect(rels[0].reason).toBe('fetch-url-match');
  });

  it('encodes fetch count in reason when consumer fetches multiple routes', () => {
    graph.addNode({ id: 'File:src/dashboard.tsx', label: 'File', properties: { name: 'src/dashboard.tsx', filePath: 'src/dashboard.tsx' } });

    const fetchCalls: ExtractedFetchCall[] = [
      { filePath: 'src/dashboard.tsx', fetchURL: '/api/grants', lineNumber: 10 },
      { filePath: 'src/dashboard.tsx', fetchURL: '/api/users', lineNumber: 20 },
    ];
    const routeRegistry = new Map([
      ['/api/grants', 'src/app/api/grants/route.ts'],
      ['/api/users', 'src/app/api/users/route.ts'],
    ]);

    const consumerContents = new Map([
      ['src/dashboard.tsx', `
        const { data, pagination } = await grantsRes.json();
        const { users } = await usersRes.json();
      `],
    ]);

    processNextjsFetchRoutes(graph, fetchCalls, routeRegistry, consumerContents);

    const rels = graph.relationships.filter(r => r.type === 'FETCHES');
    expect(rels).toHaveLength(2);
    // Both edges should have |fetches:2 suffix
    for (const rel of rels) {
      expect(rel.reason).toContain('|fetches:2');
      expect(rel.reason).toMatch(/^fetch-url-match\|keys:[^|]+\|fetches:2$/);
    }
  });

  it('does not encode fetch count when consumer fetches only one route', () => {
    graph.addNode({ id: 'File:src/page.tsx', label: 'File', properties: { name: 'src/page.tsx', filePath: 'src/page.tsx' } });

    const fetchCalls: ExtractedFetchCall[] = [
      { filePath: 'src/page.tsx', fetchURL: '/api/grants', lineNumber: 10 },
    ];
    const routeRegistry = new Map([
      ['/api/grants', 'src/app/api/grants/route.ts'],
      ['/api/users', 'src/app/api/users/route.ts'],
    ]);

    const consumerContents = new Map([
      ['src/page.tsx', `const { data } = await res.json();`],
    ]);

    processNextjsFetchRoutes(graph, fetchCalls, routeRegistry, consumerContents);

    const rels = graph.relationships.filter(r => r.type === 'FETCHES');
    expect(rels).toHaveLength(1);
    expect(rels[0].reason).not.toContain('|fetches:');
  });
});
