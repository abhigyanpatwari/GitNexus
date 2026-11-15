import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';

let root: string;
let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-kotlin-unicode-factory-'));
  writeFixtureRepo(root, {
    'factory.kt': `package προϊόν
class Product { fun m() {} }
fun φτιάξε(): Product = Product()
`,
    'caller.kt': `fun probeBound() { val x = προϊόν.φτιάξε(); x.m() }
fun probeInline() { προϊόν.φτιάξε().m() }
`,
  });
  result = await runPipelineFromRepo(root, () => {}, {});
}, 120000);
afterAll(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});
it.each(['probeBound', 'probeInline'])('types Unicode package and callee names in %s', (caller) => {
  const calls = getRelationships(result, 'CALLS').filter(
    (edge) => edge.source === caller && edge.target === 'm',
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.rel.targetId).toBe('Method:factory.kt:Product.m#0');
});
