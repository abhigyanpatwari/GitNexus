import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isHttpMode } from '../../src/core/embeddings/http-client.js';
import { resolveEmbeddingRuntime } from '../../src/core/embeddings/runtime-install.js';
import { getEmbeddingDims, isEmbedderReady } from '../../src/mcp/core/embedder.js';

describe('embedder', () => {
  describe('getEmbeddingDims', () => {
    it('returns 384 (MiniLM default)', () => {
      expect(getEmbeddingDims()).toBe(384);
    });
  });

  describe('isEmbedderReady', () => {
    it('follows HTTP mode or stack resolution, not an in-process ONNX singleton', () => {
      expect(isEmbedderReady()).toBe(isHttpMode() || resolveEmbeddingRuntime() !== null);
    });
  });

  it('does not import the Hugging Face transformers package', () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/mcp/core/embedder.ts'),
      'utf8',
    );
    const imports = src
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /^\s*\} from /.test(line))
      .join('\n');
    expect(imports).not.toContain('@huggingface/transformers');
    expect(imports).not.toContain('onnxruntime-node');
    expect(imports).not.toContain('embedding-local-init');
  });
});
