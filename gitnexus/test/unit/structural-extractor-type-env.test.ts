import { describe, expect, it, vi } from 'vitest';

// Wrap the real builder so a call is observable without changing its result.
vi.mock('../../src/core/ingestion/type-env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/ingestion/type-env.js')>();
  return { ...original, buildTypeEnv: vi.fn(original.buildTypeEnv) };
});

import { buildTypeEnv } from '../../src/core/ingestion/type-env.js';
import { extractStructuralNames } from '../../src/core/embeddings/structural-extractor.js';

describe('structural names for embedding text (#3870)', () => {
  it.each([
    [
      'Sample.java',
      'Sample',
      'public class Sample { private final java.util.Map<String, Integer> cache = new java.util.HashMap<>(); private int size; int total(int limit) { int sum = 0; for (int i = 0; i < limit; i++) sum += i; return sum; } }',
      ['cache', 'size'],
      ['total'],
    ],
    [
      'sample.ts',
      'Sample',
      'class Sample { private cache = new Map<string, number>(); size: number = 0; total(limit: number): number { let sum = 0; for (let i = 0; i < limit; i++) sum += i; return sum; } }',
      ['cache', 'size'],
      ['total'],
    ],
  ])(
    'lists %s field and method names without building a type environment',
    async (filePath, name, source, fieldNames, methodNames) => {
      vi.mocked(buildTypeEnv).mockClear();
      expect(await extractStructuralNames(source, filePath, undefined, name)).toEqual({
        fieldNames,
        methodNames,
      });
      // Only field types consult a type environment, and embedding text keeps
      // names alone. Walking every method body of a hydrated class per node
      // was the dominant main-thread cost of Class embedding.
      expect(buildTypeEnv).not.toHaveBeenCalled();
    },
  );
});
