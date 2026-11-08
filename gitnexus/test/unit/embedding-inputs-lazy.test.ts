import { expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({ loaded: false }));
vi.mock('../../src/core/ingestion/languages/index.js', () => {
  registry.loaded = true;
  throw new Error('The provider registry is unavailable in this fixture');
});

import { iterateEmbeddingInputs } from '../../src/core/embeddings/embedding-inputs.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../../src/core/embeddings/types.js';

it('generates fixed function inputs without initializing language providers', async () => {
  const content = 'export function value() { return 1; }';
  const inputs = [];
  for await (const input of iterateEmbeddingInputs(
    {
      id: 'Function:value.ts:value',
      label: 'Function',
      name: 'value',
      filePath: 'value.ts',
      content,
      startLine: 0,
      endLine: 0,
    },
    { ...DEFAULT_EMBEDDING_CONFIG, chunkStrategy: 'fixed' },
  )) {
    inputs.push(input);
  }
  expect(inputs).toHaveLength(1);
  expect(inputs[0].text).toContain(content);
  expect(registry.loaded).toBe(false);
});
