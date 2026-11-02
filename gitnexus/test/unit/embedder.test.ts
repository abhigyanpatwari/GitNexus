import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isHttpMode } from '../../src/core/embeddings/http-client.js';
import { assessLocalEmbeddingRuntime } from '../../src/core/embeddings/runtime-support.js';
import { getEmbeddingDims, isEmbedderReady } from '../../src/mcp/core/embedder.js';

describe('embedder', () => {
  describe('getEmbeddingDims', () => {
    it('returns 384 (MiniLM default)', () => {
      expect(getEmbeddingDims()).toBe(384);
    });
  });

  describe('isEmbedderReady', () => {
    it('follows HTTP mode or a ready local runtime, not resolution alone', () => {
      expect(isEmbedderReady()).toBe(
        isHttpMode() || assessLocalEmbeddingRuntime().status === 'ready',
      );
    });
  });

  it('does not import the Hugging Face transformers package', () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/mcp/core/embedder.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"]@huggingface\/transformers['"]/);
    expect(src).not.toMatch(/import\s*\(\s*['"]@huggingface\/transformers['"]/);
    expect(src).not.toMatch(/from\s+['"]onnxruntime-node['"]/);
    expect(src).not.toMatch(/import\s*\(\s*['"]onnxruntime-node['"]/);
    expect(src).not.toMatch(/from\s+['"].*embedding-local-init['"]/);
    expect(src).not.toMatch(/import\s*\(\s*['"].*embedding-local-init['"]/);
  });
});
