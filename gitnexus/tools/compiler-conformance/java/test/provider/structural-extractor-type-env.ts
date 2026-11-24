import assert from 'node:assert/strict';
import { test } from 'node:test';

test('extracts Java field and method names for embeddings without building a type environment', async (t) => {
  const path = new URL('../../../../../dist/core/ingestion/type-env.js', import.meta.url);
  const original = await import('../../../../../dist/core/ingestion/type-env.js');
  const build = t.mock.fn(original.buildTypeEnv);
  t.mock.module(path.href, { namedExports: { ...original, buildTypeEnv: build } });
  const { extractStructuralNames } =
    await import('../../../../../dist/core/embeddings/structural-extractor.js');
  const source =
    'public class Sample { private final java.util.Map<String, Integer> cache = new java.util.HashMap<>(); private int size; int total(int limit) { int sum = 0; for (int i = 0; i < limit; i++) sum += i; return sum; } }';
  assert.deepEqual(await extractStructuralNames(source, 'Sample.java', undefined, 'Sample'), {
    fieldNames: ['cache', 'size'],
    methodNames: ['total'],
  });
  assert.equal(build.mock.callCount(), 0);
});
