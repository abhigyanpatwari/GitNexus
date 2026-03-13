import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processCallsFromExtracted } from '../../src/core/ingestion/call-processor.js';
import { createSymbolTable } from '../../src/core/ingestion/symbol-table.js';
import { createImportMap, type ImportMap } from '../../src/core/ingestion/import-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { ExtractedCall } from '../../src/core/ingestion/workers/parse-worker.js';

describe('processCallsFromExtracted', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let symbolTable: ReturnType<typeof createSymbolTable>;
  let importMap: ImportMap;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    symbolTable = createSymbolTable();
    importMap = createImportMap();
  });

  it('creates CALLS relationship for same-file resolution', async () => {
    symbolTable.add('src/index.ts', 'helper', 'Function:src/index.ts:helper', 'Function');

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'helper',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].sourceId).toBe('Function:src/index.ts:main');
    expect(rels[0].targetId).toBe('Function:src/index.ts:helper');
    expect(rels[0].confidence).toBe(0.95);
    expect(rels[0].reason).toBe('same-file');
  });

  it('creates CALLS relationship for import-resolved resolution', async () => {
    symbolTable.add('src/utils.ts', 'format', 'Function:src/utils.ts:format', 'Function');
    importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'format',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].confidence).toBe(0.9);
    expect(rels[0].reason).toBe('import-resolved');
  });

  it('resolves unique global symbol with moderate confidence', async () => {
    symbolTable.add('src/other.ts', 'uniqueFunc', 'Function:src/other.ts:uniqueFunc', 'Function');

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'uniqueFunc',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].confidence).toBe(0.5);
    expect(rels[0].reason).toBe('unique-global');
  });

  it('refuses ambiguous global symbols — no CALLS edge created', async () => {
    symbolTable.add('src/a.ts', 'render', 'Function:src/a.ts:render', 'Function');
    symbolTable.add('src/b.ts', 'render', 'Function:src/b.ts:render', 'Function');

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'render',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);

    // Ambiguous matches are refused — a wrong edge is worse than no edge
    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('skips unresolvable calls', async () => {
    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'nonExistent',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);
    expect(graph.relationshipCount).toBe(0);
  });

  it('refuses non-callable symbols even when the name resolves', async () => {
    symbolTable.add('src/index.ts', 'Widget', 'Class:src/index.ts:Widget', 'Class');

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'Widget',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);
    expect(graph.relationshipCount).toBe(0);
  });

  it('refuses CALLS edges to Interface symbols', async () => {
    symbolTable.add('src/types.ts', 'Serializable', 'Interface:src/types.ts:Serializable', 'Interface');
    importMap.set('src/index.ts', new Set(['src/types.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'Serializable',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);
    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(0);
  });

  it('refuses CALLS edges to Enum symbols', async () => {
    symbolTable.add('src/status.ts', 'Status', 'Enum:src/status.ts:Status', 'Enum');
    importMap.set('src/index.ts', new Set(['src/status.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'Status',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);
    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(0);
  });

  it('prefers same-file over import-resolved', async () => {
    // Symbol exists both locally and in imported file
    symbolTable.add('src/index.ts', 'render', 'Function:src/index.ts:render', 'Function');
    symbolTable.add('src/utils.ts', 'render', 'Function:src/utils.ts:render', 'Function');
    importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'render',
      sourceId: 'Function:src/index.ts:main',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    // Same-file resolution takes priority
    expect(rels[0].targetId).toBe('Function:src/index.ts:render');
    expect(rels[0].reason).toBe('same-file');
  });

  it('handles multiple calls from the same file', async () => {
    symbolTable.add('src/index.ts', 'foo', 'Function:src/index.ts:foo', 'Function');
    symbolTable.add('src/index.ts', 'bar', 'Function:src/index.ts:bar', 'Function');

    const calls: ExtractedCall[] = [
      { filePath: 'src/index.ts', calledName: 'foo', sourceId: 'Function:src/index.ts:main' },
      { filePath: 'src/index.ts', calledName: 'bar', sourceId: 'Function:src/index.ts:main' },
    ];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);
    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(2);
  });

  it('uses arity to disambiguate import-scoped callable candidates', async () => {
    symbolTable.add('src/logger.ts', 'log', 'Function:src/logger.ts:log', 'Function', { parameterCount: 0 });
    symbolTable.add('src/formatter.ts', 'log', 'Function:src/formatter.ts:log', 'Function', { parameterCount: 1 });
    importMap.set('src/index.ts', new Set(['src/logger.ts', 'src/formatter.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'log',
      sourceId: 'Function:src/index.ts:main',
      argCount: 1,
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Function:src/formatter.ts:log');
    expect(rels[0].reason).toBe('import-resolved');
  });

  it('refuses ambiguous call targets when arity does not produce a unique match', async () => {
    symbolTable.add('src/logger.ts', 'log', 'Function:src/logger.ts:log', 'Function', { parameterCount: 1 });
    symbolTable.add('src/formatter.ts', 'log', 'Function:src/formatter.ts:log', 'Function', { parameterCount: 1 });
    importMap.set('src/index.ts', new Set(['src/logger.ts', 'src/formatter.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'log',
      sourceId: 'Function:src/index.ts:main',
      argCount: 1,
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);
    expect(graph.relationships.filter(r => r.type === 'CALLS')).toHaveLength(0);
  });

  it('calls progress callback', async () => {
    symbolTable.add('src/index.ts', 'foo', 'Function:src/index.ts:foo', 'Function');

    const calls: ExtractedCall[] = [
      { filePath: 'src/index.ts', calledName: 'foo', sourceId: 'Function:src/index.ts:main' },
    ];

    const onProgress = vi.fn();
    await processCallsFromExtracted(graph, calls, symbolTable, importMap, undefined, onProgress);

    // Final progress call
    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });

  it('handles empty calls array', async () => {
    await processCallsFromExtracted(graph, [], symbolTable, importMap);
    expect(graph.relationshipCount).toBe(0);
  });

  // ---- Constructor-aware resolution (Phase 2) ----

  it('resolves constructor call to Class when no Constructor node exists', async () => {
    symbolTable.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'User',
      sourceId: 'Function:src/index.ts:main',
      callForm: 'constructor',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Class:src/models.ts:User');
    expect(rels[0].reason).toBe('import-resolved');
  });

  it('resolves constructor call to Constructor node over Class node', async () => {
    symbolTable.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    symbolTable.add('src/models.ts', 'User', 'Constructor:src/models.ts:User', 'Constructor', { parameterCount: 1 });
    importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'User',
      sourceId: 'Function:src/index.ts:main',
      argCount: 1,
      callForm: 'constructor',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Constructor:src/models.ts:User');
  });

  it('refuses Class target without callForm=constructor (existing behavior)', async () => {
    symbolTable.add('src/models.ts', 'User', 'Class:src/models.ts:User', 'Class');
    importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'User',
      sourceId: 'Function:src/index.ts:main',
      // no callForm — treated as regular call
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);

    // Without constructor callForm, Class is not in CALLABLE_SYMBOL_TYPES → refused
    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(0);
  });

  it('constructor call falls back to callable types when no Constructor/Class found', async () => {
    // Edge case: calledName matches a Function, not a Class/Constructor
    symbolTable.add('src/utils.ts', 'Widget', 'Function:src/utils.ts:Widget', 'Function');
    importMap.set('src/index.ts', new Set(['src/utils.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'Widget',
      sourceId: 'Function:src/index.ts:main',
      callForm: 'constructor',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);

    // Falls back to callable filtering — Function is callable
    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Function:src/utils.ts:Widget');
  });

  it('constructor arity filtering narrows overloaded constructors', async () => {
    symbolTable.add('src/models.ts', 'User', 'Constructor:src/models.ts:User(0)', 'Constructor', { parameterCount: 0 });
    symbolTable.add('src/models.ts', 'User', 'Constructor:src/models.ts:User(2)', 'Constructor', { parameterCount: 2 });
    importMap.set('src/index.ts', new Set(['src/models.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'User',
      sourceId: 'Function:src/index.ts:main',
      argCount: 2,
      callForm: 'constructor',
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);

    const rels = graph.relationships.filter(r => r.type === 'CALLS');
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('Constructor:src/models.ts:User(2)');
  });

  it('cannot discriminate same-arity overloads by parameter type (known limitation)', async () => {
    // Java: save(User u) vs save(Repo r) — both have parameterCount: 1
    // The system counts arguments, not their types, so both candidates match equally.
    // With parameter type capture, receiver-typed calls could be discriminated.
    symbolTable.add('src/UserDao.ts', 'save', 'Function:src/UserDao.ts:save', 'Function', { parameterCount: 1 });
    symbolTable.add('src/RepoDao.ts', 'save', 'Function:src/RepoDao.ts:save', 'Function', { parameterCount: 1 });
    importMap.set('src/index.ts', new Set(['src/UserDao.ts', 'src/RepoDao.ts']));

    const calls: ExtractedCall[] = [{
      filePath: 'src/index.ts',
      calledName: 'save',
      sourceId: 'Function:src/index.ts:main',
      argCount: 1,
    }];

    await processCallsFromExtracted(graph, calls, symbolTable, importMap);
    const rels = graph.relationships.filter(r => r.type === 'CALLS');

    // Both candidates match (same name, same arity) — ambiguous → no edge emitted
    // Discriminating by parameter type would require capturing type annotations at call sites
    expect(rels).toHaveLength(0);
  });
});
