import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processCallsFromExtracted } from '../../src/core/ingestion/call-processor.js';
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
