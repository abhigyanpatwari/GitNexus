import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processCallsFromExtracted, extractReturnTypeName } from '../../src/core/ingestion/call-processor.js';
import { createResolutionContext, type ResolutionContext } from '../../src/core/ingestion/resolution-context.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { ExtractedCall, FileConstructorBindings } from '../../src/core/ingestion/workers/parse-worker.js';

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
});
