import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import {
  contentHashForNode,
  EMBEDDING_TEXT_VERSION,
  resolveEmbeddingInstallPolicy,
} from '../../src/core/embeddings/embedding-pipeline.js';
import { generateEmbeddingText } from '../../src/core/embeddings/text-generator.js';
import type { EmbeddableNode, EmbeddingProgress } from '../../src/core/embeddings/types.js';
import { DEFAULT_EMBEDDING_CONFIG, EMBEDDABLE_LABELS } from '../../src/core/embeddings/types.js';
import { STALE_HASH_SENTINEL } from '../../src/core/lbug/schema.js';

const CLASS_CHUNK_SIZE = 90;
const CLASS_OVERLAP = 10;

// ────────────────────────────────────────────────────────────────────────────
// resolveEmbeddingInstallPolicy (offline-first, #1153)
// ────────────────────────────────────────────────────────────────────────────

describe('resolveEmbeddingInstallPolicy (#1153)', () => {
  const ENV = 'GITNEXUS_LBUG_EXTENSION_INSTALL';
  const original = process.env[ENV];
  const restore = () => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  };

  it('defaults to auto when unset (embeddings are an explicit network-capable opt-in)', () => {
    delete process.env[ENV];
    try {
      expect(resolveEmbeddingInstallPolicy()).toBe('auto');
    } finally {
      restore();
    }
  });

  it('honors an explicit load-only override (offline operator is not forced onto the network)', () => {
    process.env[ENV] = 'load-only';
    try {
      expect(resolveEmbeddingInstallPolicy()).toBe('load-only');
    } finally {
      restore();
    }
  });

  it('honors an explicit never override', () => {
    process.env[ENV] = 'never';
    try {
      expect(resolveEmbeddingInstallPolicy()).toBe('never');
    } finally {
      restore();
    }
  });

  it('falls back to auto for invalid values', () => {
    process.env[ENV] = 'bogus';
    try {
      expect(resolveEmbeddingInstallPolicy()).toBe('auto');
    } finally {
      restore();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// contentHashForNode
// ────────────────────────────────────────────────────────────────────────────
describe('contentHashForNode', () => {
  const makeNode = (overrides: Partial<EmbeddableNode> = {}): EmbeddableNode => ({
    id: 'Function:foo:src/main.ts',
    name: 'foo',
    label: 'Function',
    filePath: 'src/main.ts',
    content: 'function foo() { return 1; }',
    ...overrides,
  });

  it('returns a 40-char hex SHA-1 digest', () => {
    const hash = contentHashForNode(makeNode());
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is deterministic — same node always produces the same hash', () => {
    const node = makeNode();
    expect(contentHashForNode(node)).toBe(contentHashForNode(node));
  });

  it('matches sha1(generateEmbeddingText(node, node.content))', () => {
    const node = makeNode();
    const expected = createHash('sha1')
      .update(EMBEDDING_TEXT_VERSION)
      .update('\n')
      .update(generateEmbeddingText(node, node.content))
      .digest('hex');
    expect(contentHashForNode(node)).toBe(expected);
  });

  it('changes when node content is edited', () => {
    const original = makeNode({ content: 'function foo() { return 1; }' });
    const edited = makeNode({ content: 'function foo() { return 42; }' });
    expect(contentHashForNode(original)).not.toBe(contentHashForNode(edited));
  });

  it('depends on the bounded location (last 1-2 segments) but not the deep path prefix (#2333 U3)', () => {
    // U3 reinstated a BOUNDED location signal (last 1-2 path segments) in the
    // embedding header, so the hash now tracks that signal — but only it, not the
    // full deep prefix. Same last-2-segments ⇒ identical embedding text ⇒ identical
    // hash, even with a totally different prefix.
    const samePrefixA = makeNode({ filePath: 'src/very/deep/nested/svc/Impl.ts' });
    const samePrefixB = makeNode({ filePath: 'other/svc/Impl.ts' });
    expect(contentHashForNode(samePrefixA)).toBe(contentHashForNode(samePrefixB));

    // Different last segments (e.g. a real service-folder move) ⇒ different bounded
    // location ⇒ different hash, so the re-embed correctly picks up the new location.
    const billing = makeNode({ filePath: 'billing/handler.ts' });
    const identity = makeNode({ filePath: 'identity/handler.ts' });
    expect(contentHashForNode(billing)).not.toBe(contentHashForNode(identity));
  });

  it('is independent of repoName/serverName/isExported (#2333 — dropped from header)', () => {
    // #2333 dropped these three (alongside filePath) from the embedding header.
    // The hash must not depend on them; if any were re-added to the header, this
    // assertion flips and flags the silent re-coupling before it ships.
    const a = makeNode({ repoName: 'repo-a', serverName: 'svc-a', isExported: true });
    const b = makeNode({ repoName: 'repo-b', serverName: 'svc-b', isExported: false });
    expect(contentHashForNode(a)).toBe(contentHashForNode(b));
  });

  it('produces identical hash regardless of config vs finalConfig when config is empty', () => {
    const node = makeNode();
    const hashWithEmptyConfig = contentHashForNode(node, {});
    const hashWithFullDefaults = contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG);
    expect(hashWithEmptyConfig).toBe(hashWithFullDefaults);
  });

  it('exports a text template version marker', () => {
    expect(EMBEDDING_TEXT_VERSION).toBe('v4');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// STALE_HASH_SENTINEL
// ────────────────────────────────────────────────────────────────────────────
describe('STALE_HASH_SENTINEL', () => {
  it('is the empty string', () => {
    expect(STALE_HASH_SENTINEL).toBe('');
  });

  it('is falsy — enables consistent `hash || STALE_HASH_SENTINEL` patterns', () => {
    expect(!STALE_HASH_SENTINEL).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runEmbeddingPipeline — exports
// ────────────────────────────────────────────────────────────────────────────
describe('runEmbeddingPipeline incremental mode', () => {
  it('exports contentHashForNode as a named export', async () => {
    const mod = await import('../../src/core/embeddings/embedding-pipeline.js');
    expect(typeof mod.contentHashForNode).toBe('function');
  });

  it('exports runEmbeddingPipeline as a named export', async () => {
    const mod = await import('../../src/core/embeddings/embedding-pipeline.js');
    expect(typeof mod.runEmbeddingPipeline).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EMBEDDING_SCHEMA includes contentHash column
// ────────────────────────────────────────────────────────────────────────────
describe('EMBEDDING_SCHEMA', () => {
  it('includes contentHash STRING column', async () => {
    const { EMBEDDING_SCHEMA } = await import('../../src/core/lbug/schema.js');
    expect(EMBEDDING_SCHEMA).toContain('contentHash STRING');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EMBEDDING_INDEX_NAME export
// ────────────────────────────────────────────────────────────────────────────
describe('EMBEDDING_INDEX_NAME', () => {
  it('is exported from schema.ts', async () => {
    const { EMBEDDING_INDEX_NAME } = await import('../../src/core/lbug/schema.js');
    expect(EMBEDDING_INDEX_NAME).toBe('code_embedding_idx');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runEmbeddingPipeline — incremental filter logic with mocked embedder
//
// Tests the three incremental-mode code paths:
// 1. New node (not in existingEmbeddings) → embedded
// 2. Unchanged node (hash matches) → skipped
// 3. Stale node (hash mismatch) → DELETE old → re-embed
// 4. Zero nodes after filter → createVectorIndex still called
// ────────────────────────────────────────────────────────────────────────────
describe('runEmbeddingPipeline incremental filter', () => {
  // Track mocked calls
  let queryCalls: string[];
  let stmtCalls: Array<{ cypher: string; params: Array<Record<string, any>> }>;
  let progressUpdates: EmbeddingProgress[];
  // Spy for the adapter's createVectorIndex (the pipeline delegates index
  // creation to it via conn.query — see #2114). Captured so tests can assert
  // it was invoked instead of asserting CREATE_VECTOR_INDEX flowed through the
  // injected (prepared) executeQuery, which it must NOT.
  let vectorIndexMock: ReturnType<typeof vi.fn>;

  // Helper node
  const makeNode = (overrides: Partial<EmbeddableNode> = {}): EmbeddableNode => ({
    id: 'Function:foo:src/main.ts',
    name: 'foo',
    label: 'Function',
    filePath: 'src/main.ts',
    content: 'function foo() { return 1; }',
    ...overrides,
  });

  beforeEach(() => {
    queryCalls = [];
    stmtCalls = [];
    progressUpdates = [];
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // Mock the embedder module so we never need a real model
  const mockEmbedderSetup = () => {
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: vi
        .fn()
        .mockImplementation((texts: string[]) =>
          Promise.resolve(texts.map(() => new Float32Array(384))),
        ),
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));

    // Mock the adapter (avoids needing the native lbug module). The pipeline
    // imports both loadVectorExtension and createVectorIndex from here.
    vectorIndexMock = vi.fn().mockResolvedValue(true);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(true),
      createVectorIndex: vectorIndexMock,
    }));
  };

  // Same stubs as mockEmbedderSetup, but with a caller-supplied embedBatch so a
  // test can make specific sub-batches reject (#2790). The real module's
  // embedBatch always resolves here, which is why no pre-#2790 test ever
  // exercised the failure path.
  const mockEmbedderWith = (embedBatchImpl: (texts: string[]) => Promise<Float32Array[]>) => {
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: vi.fn().mockImplementation(embedBatchImpl),
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));
    vectorIndexMock = vi.fn().mockResolvedValue(true);
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(true),
      createVectorIndex: vectorIndexMock,
    }));
  };

  /**
   * Builds an embedBatch that rejects on the given 1-based call indices and
   * resolves otherwise. Keyed on call ORDER, never on timing, so the sub-batch
   * that fails is fully deterministic. `subBatchTexts` records each call's text
   * count so a test can pin how chunks were split across sub-batches.
   */
  const failingEmbedBatch = (
    failOnCalls: readonly number[],
    makeError: () => Error,
    subBatchTexts: number[] = [],
  ) => {
    const failing = new Set(failOnCalls);
    let call = 0;
    return async (texts: string[]): Promise<Float32Array[]> => {
      call += 1;
      subBatchTexts.push(texts.length);
      if (failing.has(call)) throw makeError();
      return texts.map(() => new Float32Array(384));
    };
  };

  const mockExecuteQuery = (nodes: EmbeddableNode[]) => {
    return vi.fn().mockImplementation(async (cypher: string) => {
      queryCalls.push(cypher);
      // Respond to node queries based on label
      for (const label of [
        'Function',
        'Class',
        'Method',
        'Interface',
        'File',
        ...(EMBEDDABLE_LABELS as readonly string[]),
      ]) {
        if (cypher.includes(`MATCH (n:${label})`) || cypher.includes(`MATCH (n:\`${label}\``)) {
          return nodes
            .filter((n) => n.label === label)
            .map((n) => ({
              id: n.id,
              name: n.name,
              label: n.label,
              filePath: n.filePath,
              content: n.content,
              startLine: n.startLine,
              endLine: n.endLine,
            }));
        }
      }
      return [];
    });
  };

  const mockExecuteWithReusedStatement = () => {
    return vi
      .fn()
      .mockImplementation(async (cypher: string, params: Array<Record<string, any>>) => {
        stmtCalls.push({ cypher, params });
      });
  };

  const onProgress = (p: EmbeddingProgress) => {
    progressUpdates.push({ ...p });
  };

  it('falls back to text-bearing File nodes when a repo has no code symbols', async () => {
    mockEmbedderSetup();

    const fileNode = makeNode({
      id: 'File:README.md',
      name: 'README.md',
      label: 'File',
      filePath: 'README.md',
      content: '# Static Site\n\nDeployment and recovery notes.',
      startLine: 1,
      endLine: 3,
    });
    const emptyFile = makeNode({
      id: 'File:empty.txt',
      name: 'empty.txt',
      label: 'File',
      filePath: 'empty.txt',
      content: '   ',
    });
    const binaryFile = makeNode({
      id: 'File:logo.png',
      name: 'logo.png',
      label: 'File',
      filePath: 'logo.png',
      content: '[Binary file - content not stored]',
    });
    const executeQuery = mockExecuteQuery([fileNode, emptyFile, binaryFile]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    const result = await runEmbeddingPipeline(executeQuery, executeWithReusedStatement, onProgress);

    expect(queryCalls.some((cypher) => cypher.includes('MATCH (n:File)'))).toBe(true);
    const insertedNodeIds = stmtCalls
      .filter((call) => call.cypher.includes('CREATE'))
      .flatMap((call) => call.params.map((param) => param.nodeId));
    expect(insertedNodeIds).toContain(fileNode.id);
    expect(insertedNodeIds).not.toContain(emptyFile.id);
    expect(insertedNodeIds).not.toContain(binaryFile.id);
    expect(result.nodesProcessed).toBe(1);
  });

  it('retains symbol-first selection when code symbols exist', async () => {
    mockEmbedderSetup();

    const functionNode = makeNode();
    const fileNode = makeNode({
      id: 'File:src/main.ts',
      name: 'main.ts',
      label: 'File',
      filePath: 'src/main.ts',
      content: 'function foo() { return 1; }',
    });
    const executeQuery = mockExecuteQuery([functionNode, fileNode]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    const result = await runEmbeddingPipeline(executeQuery, executeWithReusedStatement, onProgress);

    expect(queryCalls.some((cypher) => cypher.includes('MATCH (n:File)'))).toBe(false);
    const insertedNodeIds = stmtCalls
      .filter((call) => call.cypher.includes('CREATE'))
      .flatMap((call) => call.params.map((param) => param.nodeId));
    expect(insertedNodeIds).toContain(functionNode.id);
    expect(insertedNodeIds).not.toContain(fileNode.id);
    expect(result.nodesProcessed).toBe(1);
  });

  it('skips unchanged nodes when hash matches', async () => {
    mockEmbedderSetup();

    const node = makeNode();
    const hash = contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG);
    const existingEmbeddings = new Map<string, string>([[node.id, hash]]);

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined, // skipNodeIds
      existingEmbeddings,
    );

    // No CREATE calls — node was skipped because hash matched
    const createCalls = stmtCalls.filter((c) => c.cypher.includes('CREATE'));
    expect(createCalls).toHaveLength(0);

    // Pipeline should reach 'ready' state
    const readyProgress = progressUpdates.find((p) => p.phase === 'ready');
    expect(readyProgress).toBeDefined();
    expect(readyProgress!.percent).toBe(100);
  });

  it('embeds new nodes not in existingEmbeddings', async () => {
    mockEmbedderSetup();

    const node = makeNode({
      id: 'Function:newFn:src/new.ts',
      name: 'newFn',
      filePath: 'src/new.ts',
    });
    const existingEmbeddings = new Map<string, string>(); // empty — no prior embeddings

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined, // skipNodeIds
      existingEmbeddings,
    );

    // Should have a CREATE call to insert the embedding
    const createCalls = stmtCalls.filter((c) => c.cypher.includes('CREATE'));
    expect(createCalls.length).toBeGreaterThanOrEqual(1);

    // The inserted row should contain the node id and a contentHash
    const insertParams = createCalls[0].params;
    expect(insertParams.some((p: any) => p.nodeId === node.id)).toBe(true);
    expect(insertParams[0].contentHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('deletes exact embedding row ids before inserting a batch (#2452)', async () => {
    mockEmbedderSetup();

    const node = makeNode({
      id: 'Function:retry:src/retry.ts',
      name: 'retry',
      filePath: 'src/retry.ts',
    });
    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined,
      new Map(),
    );

    const rowDeleteIndex = stmtCalls.findIndex(
      (c) => c.cypher.includes('{id: $id}') && c.cypher.includes('DELETE'),
    );
    const createIndex = stmtCalls.findIndex((c) => c.cypher.includes('CREATE'));
    expect(rowDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(rowDeleteIndex);
    expect(stmtCalls[rowDeleteIndex].params).toContainEqual({ id: `${node.id}:0` });
  });

  it('maps positional query rows with description/isExported columns correctly', async () => {
    const embedBatchSpy = vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => new Float32Array(384))),
      );
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: embedBatchSpy,
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(true),
      createVectorIndex: vi.fn().mockResolvedValue(true),
    }));

    const executeQuery = vi.fn().mockImplementation(async (cypher: string) => {
      queryCalls.push(cypher);
      if (cypher.includes('MATCH (n:`Class`)')) {
        return [
          [
            'Class:src/parser.ts:Parser',
            'Parser',
            'Class',
            'src/parser.ts',
            'class Parser { value = 1; }',
            10,
            12,
            true,
            'Parses typed payloads.',
          ],
        ];
      }
      if (cypher.includes('MATCH (n:`Enum`)')) {
        return [
          [
            'Enum:src/status.ts:Status',
            'Status',
            'Enum',
            'src/status.ts',
            'enum Status { Active, Pending }',
            20,
            22,
            'Represents user status.',
          ],
        ];
      }
      return [];
    });
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined,
      new Map(),
    );

    const embeddedTexts = embedBatchSpy.mock.calls.flatMap((call) => call[0] as string[]);
    const classText = embeddedTexts.find((text) => text.includes('Class: Parser'));
    const enumText = embeddedTexts.find((text) => text.includes('Enum: Status'));

    // #2333 dropped Export/metadata from embedding text, but the description
    // assertions still prove the positional column mapping is correct. The Class
    // row carries isExported at index 7 and description at index 8; the Enum row
    // has no isExported column (description at index 7), exercising the other
    // mapping branch. The toContain checks below are the primary guard: an
    // off-by-one would put the boolean from index 7 into description, so the real
    // text would be absent, failing here.
    expect(classText).toContain('Parses typed payloads.');
    // Header-integrity guard (#2333 U5): the embedding text must start with the
    // `Label: name` header. A positional mis-map that corrupted the header line
    // (e.g. the name column shifting) is caught here directly, instead of via the
    // old narrow `not.toContain('\ntrue')` coincidence.
    expect(classText).toMatch(/^Class: Parser\n/);
    expect(enumText).toContain('Represents user status.');
  });

  it('deletes and re-embeds stale nodes (hash mismatch)', async () => {
    mockEmbedderSetup();

    const node = makeNode({ content: 'function foo() { return 42; }' });
    const staleHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // wrong hash
    const existingEmbeddings = new Map<string, string>([[node.id, staleHash]]);

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined, // skipNodeIds
      existingEmbeddings,
    );

    // Should have a DELETE call for the stale node
    const deleteCalls = stmtCalls.filter((c) => c.cypher.includes('{nodeId: $nodeId}'));
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(deleteCalls[0].params.some((p: any) => p.nodeId === node.id)).toBe(true);

    // Should also have a CREATE call to re-insert with new hash
    const createCalls = stmtCalls.filter((c) => c.cypher.includes('CREATE'));
    expect(createCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('treats STALE_HASH_SENTINEL as stale — triggers re-embed', async () => {
    mockEmbedderSetup();

    const node = makeNode();
    // Legacy row: nodeId present but contentHash is STALE_HASH_SENTINEL
    const existingEmbeddings = new Map<string, string>([[node.id, STALE_HASH_SENTINEL]]);

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined, // skipNodeIds
      existingEmbeddings,
    );

    // Should have a DELETE call (stale)
    const deleteCalls = stmtCalls.filter((c) => c.cypher.includes('{nodeId: $nodeId}'));
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);

    // Should also have a CREATE (re-embed)
    const createCalls = stmtCalls.filter((c) => c.cypher.includes('CREATE'));
    expect(createCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('deletes each batch stale rows interleaved with its insert, not all up front (#2333 U6)', async () => {
    mockEmbedderSetup();

    const n1 = makeNode({ id: 'Function:a:src/a.ts', name: 'a', filePath: 'src/a.ts' });
    const n2 = makeNode({ id: 'Function:b:src/b.ts', name: 'b', filePath: 'src/b.ts' });
    // Both stale (hash mismatch) → both re-embed.
    const existingEmbeddings = new Map<string, string>([
      [n1.id, 'wronghash1'],
      [n2.id, 'wronghash2'],
    ]);

    const executeQuery = mockExecuteQuery([n1, n2]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      { batchSize: 1 }, // one node per batch → two batches
      undefined, // skipNodeIds
      existingEmbeddings,
    );

    // U6 / KTD7: per-batch interleaving means TWO separate DELETE calls (one per
    // batch), not one up-front bulk delete of both stale rows.
    const deleteCalls = stmtCalls.filter((c) => c.cypher.includes('{nodeId: $nodeId}'));
    expect(deleteCalls.length).toBe(2);

    // Ordering proof: batch 1's INSERT lands BEFORE batch 2's DELETE. An up-front
    // bulk delete would put both DELETEs before any INSERT, failing this — so an
    // interrupted re-embed can lose at most one batch, never the whole index.
    const insertN1 = stmtCalls.findIndex(
      (c) => c.cypher.includes('CREATE') && c.params.some((p) => p.nodeId === n1.id),
    );
    const deleteN2 = stmtCalls.findIndex(
      (c) => c.cypher.includes('{nodeId: $nodeId}') && c.params.some((p) => p.nodeId === n2.id),
    );
    expect(insertN1).toBeGreaterThanOrEqual(0);
    expect(deleteN2).toBeGreaterThanOrEqual(0);
    expect(insertN1).toBeLessThan(deleteN2);
  });

  it('stops at a batch boundary when cancellation is requested', async () => {
    mockEmbedderSetup();
    const first = makeNode({ id: 'Function:first:src/first.ts', name: 'first' });
    const second = makeNode({ id: 'Function:second:src/second.ts', name: 'second' });
    const executeQuery = mockExecuteQuery([first, second]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();
    const controller = new AbortController();
    const checkpoints: number[] = [];

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');
    const promise = runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      { batchSize: 1 },
      undefined,
      new Map(),
      {
        signal: controller.signal,
        checkpointEveryNodes: 1,
        onCheckpoint: async ({ nodesProcessed }) => {
          checkpoints.push(nodesProcessed);
          controller.abort();
        },
      },
    );

    await expect(promise).rejects.toThrow(/abort/i);
    const insertedIds = stmtCalls
      .filter((call) => call.cypher.includes('CREATE'))
      .flatMap((call) => call.params.map((param) => param.nodeId));
    expect(insertedIds).toEqual([first.id]);
    expect(checkpoints).toEqual([1]);
  });

  it('resumes idempotently from the hashes persisted before an interrupted checkpoint', async () => {
    mockEmbedderSetup();
    const first = makeNode({ id: 'Function:first:src/first.ts', name: 'first' });
    const second = makeNode({ id: 'Function:second:src/second.ts', name: 'second' });
    const executeQuery = mockExecuteQuery([first, second]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();
    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await expect(
      runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { batchSize: 1 },
        undefined,
        new Map(),
        {
          checkpointEveryNodes: 1,
          onCheckpoint: async ({ nodesProcessed }) => {
            if (nodesProcessed === 1) throw new Error('simulated interruption after checkpoint');
          },
        },
      ),
    ).rejects.toThrow('simulated interruption');

    const firstInsert = stmtCalls.find(
      (call) => call.cypher.includes('CREATE') && call.params.some((p) => p.nodeId === first.id),
    );
    expect(firstInsert).toBeDefined();
    const firstParam = firstInsert?.params.find((param) => param.nodeId === first.id);
    if (!firstParam) throw new Error('expected first checkpoint insert');
    const firstHash = firstParam.contentHash;

    stmtCalls = [];
    progressUpdates = [];
    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      { batchSize: 1 },
      undefined,
      new Map([[first.id, firstHash]]),
      { checkpointEveryNodes: 1, onCheckpoint: async () => {} },
    );

    const resumedIds = stmtCalls
      .filter((call) => call.cypher.includes('CREATE'))
      .flatMap((call) => call.params.map((param) => param.nodeId));
    expect(resumedIds).toEqual([second.id]);
  });

  it('re-embeds a pending-window node even when its persisted content hash matches', async () => {
    mockEmbedderSetup();
    const node = makeNode({
      id: 'Function:pending:src/pending.ts',
      name: 'pending',
      filePath: 'src/pending.ts',
    });
    const currentHash = contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG);
    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();
    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined,
      new Map([[node.id, currentHash]]),
      { forceReembedNodeIds: new Set([node.id]) },
    );

    const deletedIds = stmtCalls
      .filter((call) => call.cypher.includes('DELETE'))
      .flatMap((call) => call.params.map((param) => param.nodeId));
    const insertedIds = stmtCalls
      .filter((call) => call.cypher.includes('CREATE'))
      .flatMap((call) => call.params.map((param) => param.nodeId));
    expect(deletedIds).toContain(node.id);
    expect(insertedIds).toContain(node.id);
  });

  it('announces each checkpoint window before mutating any node in that window', async () => {
    mockEmbedderSetup();
    const first = makeNode({ id: 'Function:first:src/first.ts', name: 'first' });
    const second = makeNode({ id: 'Function:second:src/second.ts', name: 'second' });
    const third = makeNode({ id: 'Function:third:src/third.ts', name: 'third' });
    const executeQuery = mockExecuteQuery([first, second, third]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();
    const windows: string[][] = [];
    const createCountsAtWindowStart: number[] = [];
    const checkpoints: number[] = [];
    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      { batchSize: 1 },
      undefined,
      new Map(),
      {
        checkpointEveryNodes: 2,
        onCheckpointWindowStart: async ({ nodeIds }) => {
          windows.push(nodeIds);
          createCountsAtWindowStart.push(
            stmtCalls.filter((call) => call.cypher.includes('CREATE')).length,
          );
        },
        onCheckpoint: async ({ nodesProcessed }) => {
          checkpoints.push(nodesProcessed);
        },
      },
    );

    expect(windows).toEqual([[first.id, second.id], [third.id]]);
    expect(createCountsAtWindowStart).toEqual([0, 2]);
    expect(checkpoints).toEqual([2, 3]);
  });

  it('deletes pending-window rows whose node is no longer embeddable', async () => {
    mockEmbedderSetup();
    const live = makeNode({ id: 'Function:live:src/live.ts', name: 'live' });
    const removedNodeId = 'Function:removed:src/removed.ts';
    const executeQuery = mockExecuteQuery([live]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();
    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined,
      new Map([[removedNodeId, 'persisted-partial-hash']]),
      { forceReembedNodeIds: new Set([removedNodeId]) },
    );

    const deletedIds = stmtCalls
      .filter((call) => call.cypher.includes('DELETE'))
      .flatMap((call) => call.params.map((param) => param.nodeId));
    expect(deletedIds).toContain(removedNodeId);
  });

  it('deletes only stale nodes — new and unchanged nodes are never deleted (#2333 U6)', async () => {
    mockEmbedderSetup();

    const unchanged = makeNode({ id: 'Function:u:src/u.ts', name: 'u', filePath: 'src/u.ts' });
    const stale = makeNode({ id: 'Function:s:src/s.ts', name: 's', filePath: 'src/s.ts' });
    const brandNew = makeNode({ id: 'Function:n:src/n.ts', name: 'n', filePath: 'src/n.ts' });
    const unchangedHash = contentHashForNode(unchanged, DEFAULT_EMBEDDING_CONFIG);
    const existingEmbeddings = new Map<string, string>([
      [unchanged.id, unchangedHash], // hash matches → skipped, no delete
      [stale.id, 'wronghash'], // hash mismatch → deleted + re-embed
      // brandNew absent from the map → new → embedded, no delete
    ]);

    const executeQuery = mockExecuteQuery([unchanged, stale, brandNew]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      { batchSize: 1 },
      undefined, // skipNodeIds
      existingEmbeddings,
    );

    const deletedIds = stmtCalls
      .filter((c) => c.cypher.includes('{nodeId: $nodeId}'))
      .flatMap((c) => c.params.map((p) => p.nodeId));
    expect(deletedIds).toContain(stale.id);
    expect(deletedIds).not.toContain(brandNew.id);
    expect(deletedIds).not.toContain(unchanged.id);
  });

  it('calls createVectorIndex even when zero nodes need embedding after filter', async () => {
    mockEmbedderSetup();

    const node = makeNode();
    const hash = contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG);
    // All existing hashes match — zero nodes to embed
    const existingEmbeddings = new Map<string, string>([[node.id, hash]]);

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    const result = await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined, // skipNodeIds
      existingEmbeddings,
    );

    // Index creation must go through the adapter's createVectorIndex (conn.query),
    // NOT the injected/prepared executeQuery — CALL CREATE_VECTOR_INDEX cannot be
    // prepared (#2114). It must still run on the zero-nodes-to-embed branch.
    expect(vectorIndexMock).toHaveBeenCalledTimes(1);
    expect(queryCalls.some((c) => c.includes('CREATE_VECTOR_INDEX'))).toBe(false);
    expect(result.vectorIndexReady).toBe(true);
    expect(result.semanticMode).toBe('vector-index');
  });

  it('stores embeddings with exact-scan fallback when VECTOR is unavailable', async () => {
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: vi
        .fn()
        .mockImplementation((texts: string[]) =>
          Promise.resolve(texts.map(() => new Float32Array(384))),
        ),
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(false),
      createVectorIndex: vi.fn().mockResolvedValue(false),
    }));

    const node = makeNode();
    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();
    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    const result = await runEmbeddingPipeline(executeQuery, executeWithReusedStatement, onProgress);

    expect(result.vectorIndexReady).toBe(false);
    expect(result.semanticMode).toBe('exact-scan');
    expect(stmtCalls.some((call) => call.cypher.includes('CREATE'))).toBe(true);
    expect(progressUpdates.at(-1)?.phase).toBe('ready');
  });

  it('degrades to exact-scan (without throwing) when vector index creation fails', async () => {
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: vi
        .fn()
        .mockImplementation((texts: string[]) =>
          Promise.resolve(texts.map(() => new Float32Array(384))),
        ),
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));
    // VECTOR loads, but the adapter's createVectorIndex throws (e.g. a DB error
    // during HNSW build). The pipeline wrapper must swallow it, log, and fall
    // back to exact-scan rather than failing the whole analyze run (#2114).
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(true),
      createVectorIndex: vi.fn().mockRejectedValue(new Error('HNSW build failed')),
    }));

    const node = makeNode();
    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();
    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    const result = await runEmbeddingPipeline(executeQuery, executeWithReusedStatement, onProgress);

    expect(result.vectorIndexReady).toBe(false);
    expect(result.semanticMode).toBe('exact-scan');
    // Embeddings were still persisted and the pipeline completed normally.
    expect(stmtCalls.some((call) => call.cypher.includes('CREATE'))).toBe(true);
    expect(progressUpdates.at(-1)?.phase).toBe('ready');
  });

  it('does not inject preceding context when overlap is disabled', async () => {
    const embedBatchSpy = vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => new Float32Array(384))),
      );
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: embedBatchSpy,
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(true),
      createVectorIndex: vi.fn().mockResolvedValue(true),
    }));

    const node = makeNode({
      label: 'Class',
      name: 'Parser',
      content: `class Parser {
  options: ParserOptions;
  cache: Map<string, any>;
  parseJSON() { return JSON.parse("{}"); }
  validate() { return true; }
}`,
      startLine: 1,
      endLine: 6,
    });

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      { chunkSize: 90, overlap: 0 },
      undefined,
      new Map(),
    );

    const embeddedTexts = embedBatchSpy.mock.calls.flatMap((call) => call[0] as string[]);
    const laterChunks = embeddedTexts.slice(1);
    expect(laterChunks.length).toBeGreaterThan(0);
    for (const text of laterChunks) {
      expect(text).not.toContain('[preceding context]:');
    }
  });

  it('truncates preceding context to the configured overlap size', async () => {
    const embedBatchSpy = vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => new Float32Array(384))),
      );
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: embedBatchSpy,
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(true),
      createVectorIndex: vi.fn().mockResolvedValue(true),
    }));

    const node = makeNode({
      label: 'Class',
      name: 'Parser',
      content: `class Parser {
  options: ParserOptions;
  cache: Map<string, any>;
  parseJSON() { return JSON.parse("{}"); }
  validate() { return true; }
}`,
      startLine: 1,
      endLine: 6,
    });

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      { chunkSize: CLASS_CHUNK_SIZE, overlap: CLASS_OVERLAP },
      undefined,
      new Map(),
    );

    const embeddedTexts = embedBatchSpy.mock.calls.flatMap((call) => call[0] as string[]);
    const laterChunk = embeddedTexts.find((text) => text.includes('[preceding context]:'));
    expect(laterChunk).toBeDefined();
    expect(laterChunk).toContain('[preceding context]: ...');
    const precedingContextLine = laterChunk
      ?.split('\n')
      .find((line) => line.startsWith('[preceding context]: ...'));
    expect(precedingContextLine).toBeDefined();
    expect(precedingContextLine).toContain('ring, any>');
    expect(precedingContextLine).not.toContain('parseJSON() {');
  });

  it('throws when DELETE for stale nodes fails with non-trivial error', async () => {
    mockEmbedderSetup();

    const node = makeNode({ content: 'function foo() { return 42; }' });
    const staleHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const existingEmbeddings = new Map<string, string>([[node.id, staleHash]]);

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = vi.fn().mockRejectedValue(new Error('Connection lost'));

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await expect(
      runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        {},
        undefined, // skipNodeIds
        existingEmbeddings,
      ),
    ).rejects.toThrow('vector-index corruption');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Sub-batch failure tolerance (#2790)
  //
  // A single transient embedBatch rejection used to abort the whole pipeline,
  // discarding hours of work on a large repo. It is now tolerated — but only
  // safely, because the affected nodes have ALL their rows deleted (see the
  // straddling-chunk regression test below) and a dead endpoint still aborts.
  // ──────────────────────────────────────────────────────────────────────────
  describe('sub-batch failure tolerance (#2790)', () => {
    // 'Enum' is a chunkable label with no CHUNKING_RULES entry, so chunkNode
    // falls through to the pure characterChunk sliding window — deterministic
    // chunk counts with no tree-sitter involvement.
    const makeEnumNode = (name: string, content: string): EmbeddableNode => ({
      id: `Enum:src/${name}.ts:${name}`,
      name,
      label: 'Enum',
      filePath: `src/${name}.ts`,
      content,
      startLine: 1,
      endLine: 1,
    });

    const createdRows = () =>
      stmtCalls.filter((c) => c.cypher.includes('CREATE')).flatMap((c) => c.params);
    // The per-nodeId DELETE (`{nodeId: $nodeId}`), i.e. "drop every row this node
    // has" — distinct from batchInsertEmbeddings' per-row `{id: $id}` DELETE.
    const nodeIdDeletes = () => stmtCalls.filter((c) => c.cypher.includes('{nodeId: $nodeId}'));

    it('survives a failing sub-batch and reports the dropped nodes', async () => {
      mockEmbedderWith(failingEmbedBatch([1], () => new Error('endpoint hiccup')));

      // Four one-chunk nodes, sub-batches of two → sub-batch 1 = [a, b] (fails),
      // sub-batch 2 = [c, d] (succeeds).
      const a = makeEnumNode('a', 'enum A {}');
      const b = makeEnumNode('b', 'enum B {}');
      const c = makeEnumNode('c', 'enum C {}');
      const d = makeEnumNode('d', 'enum D {}');
      const executeQuery = mockExecuteQuery([a, b, c, d]);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      const result = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { chunkSize: 100, overlap: 0, subBatchSize: 2 },
        undefined,
        new Map(),
      );

      // Resolves rather than throwing — the whole point of #2790.
      expect(result).toMatchObject({
        failedNodeIds: [a.id, b.id],
        nodesProcessed: 2,
      });
      const insertedIds = createdRows().map((p) => p.nodeId);
      expect(insertedIds).toEqual([c.id, d.id]);
      expect(progressUpdates.at(-1)?.phase).toBe('ready');
      expect(vectorIndexMock).toHaveBeenCalledTimes(1);
    });

    it('deletes ALL rows of a node whose chunks straddled the failed sub-batch boundary', async () => {
      // The H1 regression. `allTexts`/`allUpdates` are flat over the outer batch
      // with no node alignment, so a node's chunks can span a sub-batch boundary.
      // Keeping the surviving chunks would be silent permanent corruption: they
      // carry the CURRENT contentHash, and both downstream hash-map builders
      // collapse a node's rows to one entry per nodeId, so the half-embedded node
      // would read as FRESH forever and its missing chunks would never return.
      const subBatchTexts: number[] = [];
      mockEmbedderWith(failingEmbedBatch([2], () => new Error('endpoint hiccup'), subBatchTexts));

      const solo = makeEnumNode('solo', 'enum S {}'); // 9 chars ≤ chunkSize → 1 chunk
      const straddler = makeEnumNode('straddler', 'x'.repeat(30)); // 30 chars → 3 chunks
      const executeQuery = mockExecuteQuery([solo, straddler]);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      const result = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { chunkSize: 10, overlap: 0, subBatchSize: 2 },
        undefined,
        new Map(),
      );

      // Fixture guard: 4 chunks split 2+2, so sub-batch 1 = [solo#0, straddler#0]
      // and sub-batch 2 = [straddler#1, straddler#2] — the straddle is real, not
      // an accident of a chunker change that quietly made this test vacuous.
      expect(subBatchTexts).toEqual([2, 2]);
      expect(createdRows().map((p) => p.nodeId)).toEqual([solo.id, straddler.id]);
      // straddler#0 WAS written by the surviving sub-batch — the corrupting row.
      const straddlerCreateIndex = stmtCalls.findIndex(
        (call) =>
          call.cypher.includes('CREATE') && call.params.some((p) => p.nodeId === straddler.id),
      );
      expect(
        stmtCalls[straddlerCreateIndex].params
          .filter((p) => p.nodeId === straddler.id)
          .map((p) => p.chunkIndex),
      ).toEqual([0]);

      // …and it is deleted afterwards, leaving the node with ZERO rows, so the
      // next run's incremental filter sees it as a new node and re-embeds it.
      const straddlerDeleteIndex = stmtCalls.findIndex(
        (call) =>
          call.cypher.includes('{nodeId: $nodeId}') &&
          call.params.some((p) => p.nodeId === straddler.id),
      );
      expect(straddlerDeleteIndex).toBeGreaterThan(straddlerCreateIndex);
      // The untouched node keeps its row — the drop is scoped to the failure.
      expect(nodeIdDeletes().flatMap((c) => c.params.map((p) => p.nodeId))).toEqual([straddler.id]);
      expect(result).toMatchObject({ failedNodeIds: [straddler.id], nodesProcessed: 1 });
    });

    it('rethrows once the consecutive-failure ceiling is reached (endpoint fully down)', async () => {
      // Five one-chunk nodes, one chunk per sub-batch, every call rejecting →
      // the 5th consecutive failure trips MAX_CONSECUTIVE_SUB_BATCH_FAILURES.
      // Without the ceiling a dead endpoint would walk every remaining node
      // deleting rows as it went, wiping surviving embeddings on an incremental.
      mockEmbedderWith(failingEmbedBatch([1, 2, 3, 4, 5], () => new Error('endpoint down')));

      const nodes = ['n1', 'n2', 'n3', 'n4', 'n5'].map((n) => makeEnumNode(n, `enum ${n} {}`));
      const executeQuery = mockExecuteQuery(nodes);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      await expect(
        runEmbeddingPipeline(
          executeQuery,
          executeWithReusedStatement,
          onProgress,
          { chunkSize: 100, overlap: 0, subBatchSize: 1 },
          undefined,
          new Map(),
        ),
      ).rejects.toThrow('endpoint down');

      // The bail-out still cleans up first: nodes touched before the ceiling
      // tripped must not be left half-embedded just because the run is aborting.
      expect(nodeIdDeletes().flatMap((c) => c.params.map((p) => p.nodeId))).toEqual(
        nodes.map((n) => n.id),
      );
      expect(createdRows()).toEqual([]);
    });

    it('rethrows the FIRST error of the streak, not the generic one that tripped the ceiling', async () => {
      // Verified trace for a permanently misconfigured endpoint (#2790): the HTTP
      // client's shared circuit breaker opens after 3 rejections, so sub-batches 4
      // and 5 never reach the network and fail with "circuit open, retry in 30s" —
      // advice to wait for a condition that will never change. Rethrowing the last
      // error of the streak buries the only message that names the real defect.
      let failureCount = 0;
      mockEmbedderWith(
        failingEmbedBatch([1, 2, 3, 4, 5], () => {
          failureCount += 1;
          return new Error(
            failureCount <= 3
              ? `unexpected response shape (attempt ${failureCount})`
              : `circuit open, retry in 30s (attempt ${failureCount})`,
          );
        }),
      );

      const nodes = ['c1', 'c2', 'c3', 'c4', 'c5'].map((n) => makeEnumNode(n, `enum ${n} {}`));
      const executeQuery = mockExecuteQuery(nodes);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      // Anchored so "attempt 1" cannot be satisfied by a substring of a later
      // attempt's message.
      await expect(
        runEmbeddingPipeline(
          executeQuery,
          executeWithReusedStatement,
          onProgress,
          { chunkSize: 100, overlap: 0, subBatchSize: 1 },
          undefined,
          new Map(),
        ),
      ).rejects.toThrow(/^unexpected response shape \(attempt 1\)$/);
      // Fixture guard: the ceiling really was reached by five failing sub-batches.
      expect(failureCount).toBe(5);
    });

    it('retains the first error of the streak that tripped the ceiling, not an earlier isolated one', async () => {
      // The counter resets on any success, so the retained error must reset with
      // it: sub-batch 1 fails in isolation, 2 succeeds, and 3-7 are the unbroken
      // streak that trips the ceiling. The reported error must be sub-batch 3's.
      let failureCount = 0;
      mockEmbedderWith(
        failingEmbedBatch([1, 3, 4, 5, 6, 7], () => {
          failureCount += 1;
          return new Error(`sub-batch failure ${failureCount}`);
        }),
      );

      const nodes = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].map((n) =>
        makeEnumNode(n, `enum ${n} {}`),
      );
      const executeQuery = mockExecuteQuery(nodes);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      await expect(
        runEmbeddingPipeline(
          executeQuery,
          executeWithReusedStatement,
          onProgress,
          { chunkSize: 100, overlap: 0, subBatchSize: 1 },
          undefined,
          new Map(),
        ),
      ).rejects.toThrow(/^sub-batch failure 2$/);
      expect(failureCount).toBe(6);
    });

    it('resets the consecutive counter on success — scattered failures do not abort', async () => {
      mockEmbedderWith(failingEmbedBatch([1, 3, 5], () => new Error('endpoint hiccup')));

      const nodes = ['s1', 's2', 's3', 's4', 's5', 's6'].map((n) =>
        makeEnumNode(n, `enum ${n} {}`),
      );
      const executeQuery = mockExecuteQuery(nodes);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      const result = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { chunkSize: 100, overlap: 0, subBatchSize: 1 },
        undefined,
        new Map(),
      );

      // Six failures total would trip a cumulative counter; three interleaved
      // with successes must not, so the run completes.
      expect(result).toMatchObject({
        failedNodeIds: [nodes[0].id, nodes[2].id, nodes[4].id],
        nodesProcessed: 3,
      });
      expect(createdRows().map((p) => p.nodeId)).toEqual([nodes[1].id, nodes[3].id, nodes[5].id]);
    });

    it('aborts on the cumulative failure ratio when an endpoint sheds every other sub-batch', async () => {
      // The gap the consecutive ceiling cannot see: alternating fail/succeed
      // resets it forever, so a load-shedding endpoint used to walk the whole
      // repo dropping half of it and still exit 0 (#2790).
      const subBatchTexts: number[] = [];
      mockEmbedderWith(
        failingEmbedBatch(
          Array.from({ length: 12 }, (_, i) => i * 2 + 1), // sub-batches 1,3,…,23
          () => new Error('load shed by endpoint'),
          subBatchTexts,
        ),
      );

      const nodes = Array.from({ length: 24 }, (_, i) =>
        makeEnumNode(`alt${i}`, `enum Alt${i} {}`),
      );
      const executeQuery = mockExecuteQuery(nodes);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      const promise = runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { chunkSize: 100, overlap: 0, batchSize: 24, subBatchSize: 1 },
        undefined,
        new Map(),
      );

      // Fires on sub-batch 21 — the first failure at or past the 20-sub-batch
      // floor. The message names the corpus-wide cause, not one bad batch…
      await expect(promise).rejects.toThrow(
        /^\[embed\] Aborting: 11 of 21 embed sub-batches failed \(52%, limit 25%\)/,
      );
      // …while still surfacing the endpoint error that actually caused it.
      await expect(promise).rejects.toThrow(/Underlying failure: load shed by endpoint$/);
      // Fixture guard: it aborted mid-run at 21 of 24 sub-batches, and consecutive
      // failures never exceeded 1 — so the consecutive ceiling was never in play.
      expect(subBatchTexts).toHaveLength(21);

      // The cleanup DELETE still ran before the rethrow: every node the failed
      // sub-batches touched is left at zero rows, not half embedded.
      const failedIds = nodes.filter((_, i) => i % 2 === 0 && i <= 20).map((n) => n.id);
      expect(nodeIdDeletes().map((c) => c.params.map((p) => p.nodeId))).toEqual([failedIds]);
      expect(createdRows().map((p) => p.nodeId)).toEqual(
        nodes.filter((_, i) => i % 2 === 1 && i < 20).map((n) => n.id),
      );
    });

    it('completes a run that stays just below the cumulative failure ratio', async () => {
      // 5 of 24 sub-batches (21%) — past the 20-sub-batch floor but under the
      // 25% bar, so the guard must not fire early and cost a mostly-good run.
      const subBatchTexts: number[] = [];
      mockEmbedderWith(
        failingEmbedBatch([1, 6, 11, 16, 21], () => new Error('occasional hiccup'), subBatchTexts),
      );

      const nodes = Array.from({ length: 24 }, (_, i) =>
        makeEnumNode(`near${i}`, `enum Near${i} {}`),
      );
      const executeQuery = mockExecuteQuery(nodes);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      const result = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { chunkSize: 100, overlap: 0, batchSize: 24, subBatchSize: 1 },
        undefined,
        new Map(),
      );

      // Every sub-batch was attempted — nothing bailed out early.
      expect(subBatchTexts).toHaveLength(24);
      expect(result).toMatchObject({
        failedNodeIds: [nodes[0].id, nodes[5].id, nodes[10].id, nodes[15].id, nodes[20].id],
        nodesProcessed: 19,
      });
      expect(progressUpdates.at(-1)?.phase).toBe('ready');
    });

    it('never applies the failure ratio to a repo too small to have a meaningful rate', async () => {
      // 1 of 3 sub-batches is a 33% failure rate but a single failure. Aborting
      // here would be strictly worse than #2790's tolerate-and-report behavior,
      // which is why the ratio is gated behind a minimum-sample floor.
      const subBatchTexts: number[] = [];
      mockEmbedderWith(failingEmbedBatch([1], () => new Error('endpoint hiccup'), subBatchTexts));

      const nodes = ['t1', 't2', 't3'].map((n) => makeEnumNode(n, `enum ${n} {}`));
      const executeQuery = mockExecuteQuery(nodes);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      const result = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { chunkSize: 100, overlap: 0, subBatchSize: 1 },
        undefined,
        new Map(),
      );

      expect(subBatchTexts).toHaveLength(3);
      expect(result).toMatchObject({ failedNodeIds: [nodes[0].id], nodesProcessed: 2 });
      expect(createdRows().map((p) => p.nodeId)).toEqual([nodes[1].id, nodes[2].id]);
    });

    it('still trips the consecutive ceiling first on a total outage long enough to reach the ratio floor', async () => {
      // Both guards would eventually fire on a 30-sub-batch outage; the ceiling
      // must get there first so the operator sees the raw endpoint error rather
      // than a corpus-ratio verdict five sub-batches into a dead endpoint.
      const subBatchTexts: number[] = [];
      mockEmbedderWith(
        failingEmbedBatch(
          Array.from({ length: 30 }, (_, i) => i + 1),
          () => new Error('endpoint down'),
          subBatchTexts,
        ),
      );

      const nodes = Array.from({ length: 30 }, (_, i) =>
        makeEnumNode(`out${i}`, `enum Out${i} {}`),
      );
      const executeQuery = mockExecuteQuery(nodes);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      await expect(
        runEmbeddingPipeline(
          executeQuery,
          executeWithReusedStatement,
          onProgress,
          { chunkSize: 100, overlap: 0, batchSize: 30, subBatchSize: 1 },
          undefined,
          new Map(),
        ),
      ).rejects.toThrow(/^endpoint down$/);
      // Stopped at 5, not at the ratio floor of 20 — the ceiling is still the
      // faster guard, and its verbatim-rethrow shape is unchanged.
      expect(subBatchTexts).toHaveLength(5);
      expect(createdRows()).toEqual([]);
    });

    it('aborts immediately when the pipeline signal is cancelled mid sub-batch', async () => {
      const controller = new AbortController();
      // Cancellation surfaces as an ordinary rejection from embedBatch here; only
      // the aborted signal distinguishes it from a tolerable endpoint hiccup.
      mockEmbedderWith(
        failingEmbedBatch([1], () => {
          controller.abort();
          return new Error('embed aborted by caller');
        }),
      );

      const a = makeEnumNode('ca', 'enum CA {}');
      const b = makeEnumNode('cb', 'enum CB {}');
      const executeQuery = mockExecuteQuery([a, b]);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      await expect(
        runEmbeddingPipeline(
          executeQuery,
          executeWithReusedStatement,
          onProgress,
          { chunkSize: 100, overlap: 0, subBatchSize: 1 },
          undefined,
          new Map(),
          { signal: controller.signal },
        ),
      ).rejects.toThrow('embed aborted by caller');

      // A cancel must not be laundered into the tolerant drop-and-continue path:
      // no rows deleted, nothing embedded after the abort.
      expect(nodeIdDeletes()).toEqual([]);
      expect(createdRows()).toEqual([]);
    });

    it('aborts immediately on an AbortError even when the pipeline owns no signal', async () => {
      // A transport-level cancel (host signal, fetch abort) reaches us only as
      // the error's shape, so the name is checked as well as our own signal.
      mockEmbedderWith(
        failingEmbedBatch([1], () =>
          Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
        ),
      );

      const a = makeEnumNode('aa', 'enum AA {}');
      const b = makeEnumNode('ab', 'enum AB {}');
      const executeQuery = mockExecuteQuery([a, b]);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      await expect(
        runEmbeddingPipeline(
          executeQuery,
          executeWithReusedStatement,
          onProgress,
          { chunkSize: 100, overlap: 0, subBatchSize: 1 },
          undefined,
          new Map(),
        ),
      ).rejects.toThrow('The operation was aborted');

      expect(nodeIdDeletes()).toEqual([]);
      expect(createdRows()).toEqual([]);
    });

    it('reports an empty failedNodeIds and the real node count on a clean run', async () => {
      mockEmbedderSetup();

      const a = makeEnumNode('ok1', 'enum OK1 {}');
      const b = makeEnumNode('ok2', 'enum OK2 {}');
      const executeQuery = mockExecuteQuery([a, b]);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      const result = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { chunkSize: 100, overlap: 0, subBatchSize: 2 },
        undefined,
        new Map(),
      );

      expect(result).toMatchObject({
        failedNodeIds: [],
        nodesProcessed: 2,
        chunksProcessed: 2,
      });
      expect(nodeIdDeletes()).toEqual([]);
    });

    it('returns an empty failedNodeIds when nothing needs embedding', async () => {
      mockEmbedderSetup();

      const node = makeEnumNode('fresh', 'enum Fresh {}');
      const executeQuery = mockExecuteQuery([node]);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      const result = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        {},
        undefined,
        new Map([[node.id, contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG)]]),
      );

      expect(result).toMatchObject({ failedNodeIds: [], nodesProcessed: 0 });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Incremental re-embed against a healthy existing index (#2790)
    //
    // The tests above all pass an EMPTY existingEmbeddings map, which makes the
    // pipeline skip the incremental filter entirely — `staleNodeIds` stays empty
    // so the pre-existing per-batch stale DELETE never fires, and the recorded
    // deletes only ever show the failure-path cleanup. These exercise the state
    // where the new DELETE can destroy live user data: real rows exist, the
    // per-batch stale DELETE has already removed some of them, and a tolerated
    // failure must leave the affected nodes at ZERO rows without touching anyone
    // else's.
    // ────────────────────────────────────────────────────────────────────────
    // Every nodeId named by a per-nodeId DELETE, grouped per statement so the
    // per-batch stale delete and the failure-path cleanup stay distinguishable.
    const nodeIdDeleteGroups = () => nodeIdDeletes().map((c) => c.params.map((p) => p.nodeId));

    it('leaves a stale node whose sub-batch failed with zero rows (incremental)', async () => {
      mockEmbedderWith(failingEmbedBatch([1], () => new Error('endpoint hiccup')));

      const staleFail = makeEnumNode('sf', 'enum SF {}');
      const staleOk = makeEnumNode('so', 'enum SO {}');
      // Both hashes mismatch → both are stale, so both have their existing rows
      // deleted up front, before a single text is embedded.
      const existingEmbeddings = new Map<string, string>([
        [staleFail.id, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        [staleOk.id, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
      ]);
      const executeQuery = mockExecuteQuery([staleFail, staleOk]);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      const result = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { chunkSize: 100, overlap: 0, subBatchSize: 1 },
        undefined,
        existingEmbeddings,
      );

      // Statement 1 = the pre-existing per-batch stale DELETE (both nodes),
      // statement 2 = the #2790 failure cleanup (only the node that lost its
      // sub-batch). Without the second, the assertion collapses to one group.
      expect(nodeIdDeleteGroups()).toEqual([[staleFail.id, staleOk.id], [staleFail.id]]);
      // Nothing re-inserted a partial row for the failed node: it holds zero rows,
      // which the next run's filter reads as "new node" and re-embeds.
      expect(createdRows().map((p) => p.nodeId)).toEqual([staleOk.id]);
      expect(createdRows()[0]).toMatchObject({
        nodeId: staleOk.id,
        chunkIndex: 0,
        contentHash: contentHashForNode(staleOk, DEFAULT_EMBEDDING_CONFIG),
      });
      expect(result).toMatchObject({
        failedNodeIds: [staleFail.id],
        nodesProcessed: 1,
        chunksProcessed: 1,
      });
    });

    it('never collateral-deletes an unchanged node when another node fails (incremental)', async () => {
      mockEmbedderWith(failingEmbedBatch([1], () => new Error('endpoint hiccup')));

      const unchanged = makeEnumNode('keep', 'enum Keep {}');
      const staleFail = makeEnumNode('sf2', 'enum SF2 {}');
      const fresh = makeEnumNode('new1', 'enum New1 {}');
      const existingEmbeddings = new Map<string, string>([
        // Hash matches → filtered out before batching, so it is never embedded and
        // its healthy rows are the ones a sloppy cleanup would take down with it.
        [unchanged.id, contentHashForNode(unchanged, DEFAULT_EMBEDDING_CONFIG)],
        [staleFail.id, 'cccccccccccccccccccccccccccccccccccccccc'],
        // `fresh` is absent from the map → embedded as a new node, not stale.
      ]);
      const executeQuery = mockExecuteQuery([unchanged, staleFail, fresh]);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      const result = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { chunkSize: 100, overlap: 0, subBatchSize: 1 },
        undefined,
        existingEmbeddings,
      );

      // Only the stale node is ever named by a DELETE — once by the per-batch
      // stale delete, once by the failure cleanup.
      const deletedNodeIds = nodeIdDeletes().flatMap((c) => c.params.map((p) => p.nodeId));
      expect(deletedNodeIds).toEqual([staleFail.id, staleFail.id]);
      // The data-loss guard, stated directly: a tolerated failure must not remove
      // embeddings that were fine.
      expect(deletedNodeIds).not.toContain(unchanged.id);
      expect(createdRows().map((p) => p.nodeId)).toEqual([fresh.id]);
      expect(result).toMatchObject({ failedNodeIds: [staleFail.id], nodesProcessed: 1 });
    });

    it('deletes the surviving chunk of a straddling stale node so it cannot read as fresh (incremental)', async () => {
      const subBatchTexts: number[] = [];
      mockEmbedderWith(failingEmbedBatch([2], () => new Error('endpoint hiccup'), subBatchTexts));

      const solo = makeEnumNode('isolo', 'enum S {}'); // 9 chars <= chunkSize → 1 chunk
      const straddler = makeEnumNode('istraddler', 'x'.repeat(30)); // 30 chars → 3 chunks
      const staleStraddlerHash = 'dddddddddddddddddddddddddddddddddddddddd';
      const existingEmbeddings = new Map<string, string>([
        [solo.id, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'],
        [straddler.id, staleStraddlerHash],
      ]);
      const executeQuery = mockExecuteQuery([solo, straddler]);
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');

      const result = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { chunkSize: 10, overlap: 0, subBatchSize: 2 },
        undefined,
        existingEmbeddings,
      );

      // Fixture guard: 4 chunks split 2+2, so sub-batch 1 = [solo#0, straddler#0]
      // and sub-batch 2 = [straddler#1, straddler#2] — the straddle is real.
      expect(subBatchTexts).toEqual([2, 2]);
      expect(nodeIdDeleteGroups()).toEqual([[solo.id, straddler.id], [straddler.id]]);

      // The surviving chunk carries the CURRENT hash, not the stale one that is
      // still in existingEmbeddings — which is exactly why it must not survive: a
      // downstream hash map collapses a node's rows to one entry, so this single
      // row would make the node read as fresh forever.
      const straddlerCreateIndex = stmtCalls.findIndex(
        (call) =>
          call.cypher.includes('CREATE') && call.params.some((p) => p.nodeId === straddler.id),
      );
      expect(
        stmtCalls[straddlerCreateIndex].params.filter((p) => p.nodeId === straddler.id),
      ).toMatchObject([
        { chunkIndex: 0, contentHash: contentHashForNode(straddler, DEFAULT_EMBEDDING_CONFIG) },
      ]);
      expect(contentHashForNode(straddler, DEFAULT_EMBEDDING_CONFIG)).not.toBe(staleStraddlerHash);

      // …and both of the straddler's DELETEs bracket that write: the stale delete
      // before it, the failure cleanup after it. Zero rows remain.
      const straddlerDeletePositions = stmtCalls
        .map((call, index) => ({ call, index }))
        .filter(
          ({ call }) =>
            call.cypher.includes('{nodeId: $nodeId}') &&
            call.params.some((p) => p.nodeId === straddler.id),
        )
        .map(({ index }) => index > straddlerCreateIndex);
      expect(straddlerDeletePositions).toEqual([false, true]);
      expect(result).toMatchObject({
        failedNodeIds: [straddler.id],
        nodesProcessed: 1,
        chunksProcessed: 1,
      });
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchExistingEmbeddingHashes — tested in integration tests (requires native module)
// The function is tested via lbug-core-adapter integration tests which have the
// native @ladybugdb/core module available.
// ────────────────────────────────────────────────────────────────────────────
