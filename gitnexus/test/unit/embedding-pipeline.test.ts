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
});

// ────────────────────────────────────────────────────────────────────────────
// fetchExistingEmbeddingHashes — tested in integration tests (requires native module)
// The function is tested via lbug-core-adapter integration tests which have the
// native @ladybugdb/core module available.
// ────────────────────────────────────────────────────────────────────────────
