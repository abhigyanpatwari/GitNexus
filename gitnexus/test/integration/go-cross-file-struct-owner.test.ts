import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo, findDanglingEdges } from './resolvers/helpers.js';
import type { PipelineResult } from './resolvers/helpers.js';
import {
  emptyParseCache,
  loadParseCache,
  loadParseCacheChunk,
  PARSE_CACHE_VERSION,
  saveParseCache,
} from '../../src/storage/parse-cache.js';
import { mergeStagedDurableParsedFileStore } from '../../src/storage/parsedfile-store.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { goScopeResolver } from '../../src/core/ingestion/languages/go/scope-resolver.js';
import { populateGoWorkspaceOwners } from '../../src/core/ingestion/languages/go/method-owners.js';
import { createSemanticModel } from '../../src/core/ingestion/model/index.js';
import { reconcileOwnership } from '../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js';
import { buildGraphNodeLookup } from '../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { resolveDefGraphId } from '../../src/core/ingestion/scope-resolution/graph-bridge/ids.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/go-cross-file-struct-owner');
const EXPECTED_OWNERS = [
  'Struct:decl.go:Other -> Method:methods.go:Other.Run#0',
  'Struct:decl.go:Widget -> Method:decl.go:Widget.Describe#0',
  'Struct:decl.go:Widget -> Method:decl.go:Widget.UnnamedPointerLocal#0',
  'Struct:decl.go:Widget -> Method:decl.go:Widget.UnnamedValueLocal#0',
  'Struct:decl.go:Widget -> Method:methods.go:Widget.Clone#0',
  'Struct:decl.go:Widget -> Method:methods.go:Widget.Rename#1',
  'Struct:decl.go:Widget -> Method:methods.go:Widget.Run#0',
  'Struct:decl.go:Widget -> Method:methods.go:Widget.UnnamedPointer#0',
  'Struct:decl.go:Widget -> Method:methods.go:Widget.UnnamedValue#0',
  'Struct:external_decl_test.go:Widget -> Method:external_methods_test.go:Widget.Run#0',
].sort();

function goMethodOwners(result: PipelineResult): string[] {
  return [...result.graph.iterRelationshipsByType('HAS_METHOD')]
    .filter((edge) => result.graph.getNode(edge.targetId)?.properties.language === 'go')
    .map((edge) => `${edge.sourceId} -> ${edge.targetId}`)
    .sort();
}

// Real parser workers, semantic resolution, graph emission and durable cache.
describe('Go semantic member ownership (#3558, #3559)', () => {
  let temp: string;
  let repo: string;
  let storage: string;
  let cold: PipelineResult;
  let cache: ReturnType<typeof emptyParseCache>;

  beforeAll(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-semantic-owner-'));
    repo = path.join(temp, 'repo');
    storage = path.join(temp, 'cache');
    fs.cpSync(FIXTURE, repo, { recursive: true });
    fs.mkdirSync(storage);
    cache = emptyParseCache(storage);
    cold = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      workerPoolSize: 1,
      chunkByteBudget: 1,
      parseCache: cache,
    });
    const savedKeys = await saveParseCache(storage, cache);
    await mergeStagedDurableParsedFileStore(
      storage,
      storage,
      PARSE_CACHE_VERSION,
      new Set(savedKeys),
    );
  });
  afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

  it('attaches methods to exact owners across worker chunks and receiver forms', () => {
    expect(cold.usedWorkerPool).toBe(true);
    expect(cold.scopeExtractionFailures).toEqual([]);
    expect(cache.usedKeys.size).toBeGreaterThan(1);
    expect(goMethodOwners(cold)).toEqual(EXPECTED_OWNERS);
    expect(findDanglingEdges(cold, ['HAS_METHOD', 'HAS_PROPERTY'])).toEqual([]);
  });

  it('keeps external test packages and other languages separate and preserves fields', () => {
    for (const edge of cold.graph.iterRelationshipsByType('HAS_METHOD')) {
      const owner = cold.graph.getNode(edge.sourceId)!;
      const method = cold.graph.getNode(edge.targetId)!;
      expect(owner.properties.language).toBe(method.properties.language);
      if (method.properties.filePath === 'external_methods_test.go')
        expect(owner.properties.filePath).toBe('external_decl_test.go');
    }
    expect(
      [...cold.graph.iterRelationshipsByType('HAS_PROPERTY')].some(
        (edge) =>
          edge.sourceId === 'Struct:decl.go:Widget' &&
          cold.graph.getNode(edge.targetId)?.properties.name === 'Name',
      ),
    ).toBe(true);
  });

  it('uses the same owners in the semantic method registry and the graph', () => {
    const fileContents = new Map(
      fs
        .readdirSync(FIXTURE)
        .filter((file) => file.endsWith('.go'))
        .map((file) => [file, fs.readFileSync(path.join(FIXTURE, file), 'utf8')]),
    );
    const parsedFiles = [...fileContents].map(([file, content]) => {
      const parsed = extractParsedFile(goScopeResolver.languageProvider, content, file);
      if (!parsed) throw new Error(`Scope extraction failed for ${file}`);
      goScopeResolver.populateOwners(parsed);
      return parsed;
    });
    populateGoWorkspaceOwners(parsedFiles, { fileContents });
    const model = createSemanticModel();
    expect(reconcileOwnership(parsedFiles, model).methodsRegistered).toBe(10);
    const defs = new Map(
      parsedFiles.flatMap((parsed) => parsed.localDefs).map((def) => [def.nodeId, def]),
    );
    const lookup = buildGraphNodeLookup(cold.graph);
    const owners = [...defs.values()]
      .filter((def) => def.type === 'Method')
      .map((def) => {
        expect(def.ownerId).toBeDefined();
        const owner = defs.get(def.ownerId!)!;
        const name = def.qualifiedName!.split('.').pop()!;
        if (name.startsWith('Unnamed')) {
          expect((def as { goReceiverKind?: string }).goReceiverKind).toBe(
            name.includes('Pointer') ? 'pointer' : 'value',
          );
        }
        expect(model.methods.lookupAllByOwner(owner.nodeId, name)).toContainEqual(def);
        return `${resolveDefGraphId(owner.filePath, owner, lookup)} -> ${resolveDefGraphId(def.filePath, def, lookup)}`;
      });
    expect(owners.sort()).toEqual(EXPECTED_OWNERS);
  });

  it('does not cache fabricated owner IDs or ownership edges from parser workers', async () => {
    const stored = await loadParseCache(storage);
    const chunks = await Promise.all(
      [...cache.usedKeys].map((key) => loadParseCacheChunk(stored, key)),
    );
    const results = chunks.flatMap((chunk) => chunk ?? []);
    const deferred = results
      .flatMap((result) => result.symbols)
      .filter((symbol) => symbol.type === 'Method' && symbol.filePath === 'methods.go');
    expect(deferred).toHaveLength(6);
    expect(deferred.every((symbol) => symbol.ownerId === undefined)).toBe(true);
    const methodIds = new Set(deferred.map((symbol) => symbol.nodeId));
    expect(
      results
        .flatMap((result) => result.relationships)
        .filter((edge) => edge.type === 'HAS_METHOD' && methodIds.has(edge.targetId)),
    ).toEqual([]);
  });

  it('reconstructs identical ownership on durable warm-cache replay without workers', async () => {
    const warm = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      workerPoolSize: 1,
      chunkByteBudget: 1,
      parseCache: await loadParseCache(storage),
    });
    expect(warm.usedWorkerPool).toBe(false);
    expect(warm.reparsedFileCount).toBe(0);
    expect(warm.parseCacheHitFileCount).toBeGreaterThan(0);
    expect(goMethodOwners(warm)).toEqual(EXPECTED_OWNERS);
    expect(findDanglingEdges(warm, ['HAS_METHOD', 'HAS_PROPERTY'])).toEqual([]);
  });

  it('re-resolves a cached method when its declaring file moves', async () => {
    fs.renameSync(path.join(repo, 'decl.go'), path.join(repo, 'moved.go'));
    try {
      const moved = await runPipelineFromRepo(repo, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        chunkByteBudget: 1,
        parseCache: await loadParseCache(storage),
      });
      expect(moved.parseCacheHitFileCount).toBeGreaterThan(0);
      expect(goMethodOwners(moved)).toEqual(
        EXPECTED_OWNERS.map((edge) => edge.replaceAll(':decl.go:', ':moved.go:')).sort(),
      );
      expect(findDanglingEdges(moved, ['HAS_METHOD', 'HAS_PROPERTY'])).toEqual([]);
    } finally {
      fs.renameSync(path.join(repo, 'moved.go'), path.join(repo, 'decl.go'));
    }
  });
});

it('declines unresolved and ambiguous owners, including same-file candidates', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ambiguous-owner-'));
  try {
    fs.writeFileSync(path.join(repo, 'go.mod'), 'module example.com/ambiguous\n\ngo 1.22\n');
    fs.writeFileSync(
      path.join(repo, 'a.go'),
      'package example\ntype Widget struct {}\nfunc (w Widget) Local() {}\n',
    );
    fs.writeFileSync(path.join(repo, 'b.go'), 'package example\ntype Widget struct {}\n');
    fs.writeFileSync(
      path.join(repo, 'methods.go'),
      'package example\nfunc (w Widget) Run() {}\nfunc (w Missing) Lost() {}\n',
    );
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      workerPoolSize: 1,
    });
    expect([...result.graph.iterNodes()].filter((node) => node.label === 'Method')).toHaveLength(3);
    expect(goMethodOwners(result)).toEqual([]);
    expect(findDanglingEdges(result, ['HAS_METHOD'])).toEqual([]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
