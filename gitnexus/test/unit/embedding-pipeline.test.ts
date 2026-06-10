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

  it('changes when filePath differs', () => {
    const a = makeNode({ filePath: 'src/a.ts' });
    const b = makeNode({ filePath: 'src/b.ts' });
    // Different filePaths lead to different embedding text ⇒ different hashes
    expect(contentHashForNode(a)).not.toBe(contentHashForNode(b));
  });

  it('produces identical hash regardless of config vs finalConfig when config is empty', () => {
    const node = makeNode();
    const hashWithEmptyConfig = contentHashForNode(node, {});
    const hashWithFullDefaults = contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG);
    expect(hashWithEmptyConfig).toBe(hashWithFullDefaults);
  });

  it('exports a text template version marker', () => {
    expect(EMBEDDING_TEXT_VERSION).toBe('v2');
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
      undefined, // context
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
      undefined, // context
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
      undefined,
      new Map(),
    );

    const embeddedTexts = embedBatchSpy.mock.calls.flatMap((call) => call[0] as string[]);
    const classText = embeddedTexts.find((text) => text.includes('Class: Parser'));
    const enumText = embeddedTexts.find((text) => text.includes('Enum: Status'));

    expect(classText).toContain('Export: true');
    expect(classText).toContain('Parses typed payloads.');
    expect(enumText).not.toContain('Export:');
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
      undefined, // context
      existingEmbeddings,
    );

    // Should have a DELETE call for the stale node
    const deleteCalls = stmtCalls.filter((c) => c.cypher.includes('DELETE'));
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
      undefined, // context
      existingEmbeddings,
    );

    // Should have a DELETE call (stale)
    const deleteCalls = stmtCalls.filter((c) => c.cypher.includes('DELETE'));
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);

    // Should also have a CREATE (re-embed)
    const createCalls = stmtCalls.filter((c) => c.cypher.includes('CREATE'));
    expect(createCalls.length).toBeGreaterThanOrEqual(1);
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
      undefined, // context
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
        undefined, // context
        existingEmbeddings,
      ),
    ).rejects.toThrow('vector-index corruption');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchExistingEmbeddingHashes — tested in integration tests (requires native module)
// The function is tested via lbug-core-adapter integration tests which have the
// native @ladybugdb/core module available.
// ────────────────────────────────────────────────────────────────────────────
