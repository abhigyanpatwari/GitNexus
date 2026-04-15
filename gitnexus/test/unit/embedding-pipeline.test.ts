import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { contentHashForNode } from '../../src/core/embeddings/embedding-pipeline.js';
import { generateEmbeddingText } from '../../src/core/embeddings/text-generator.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../../src/core/embeddings/types.js';

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

  it('matches sha1(generateEmbeddingText(node))', () => {
    const node = makeNode();
    const expected = createHash('sha1')
      .update(generateEmbeddingText(node))
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
// fetchExistingEmbeddingHashes — tested in integration tests (requires native module)
// The function is tested via lbug-core-adapter integration tests which have the
// native @ladybugdb/core module available.
// ────────────────────────────────────────────────────────────────────────────
