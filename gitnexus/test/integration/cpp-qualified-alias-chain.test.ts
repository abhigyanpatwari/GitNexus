import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('C++ chained namespace alias receiver types', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-alias-chain-'));
    await fs.writeFile(
      path.join(root, 'main.cpp'),
      `
namespace impl { struct C { int m(); }; }
namespace first = impl;
namespace second = first;
struct Decoy { int m(); };
struct Holder { second::C c; int field_call() { return c.m(); } };
int brace_call() { auto c = second::C{}; return c.m(); }
`,
    );
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  it.each(['field_call', 'brace_call'])('%s resolves the canonical alias target', (caller) => {
    expect(
      [...result.graph.iterRelationships()]
        .filter(
          (edge) =>
            edge.type === 'CALLS' &&
            result.graph.getNode(edge.sourceId)?.properties.name === caller &&
            result.graph.getNode(edge.targetId)?.properties.name === 'm',
        )
        .map((edge) => edge.targetId),
    ).toEqual(['Method:main.cpp:C.m#0']);
  });
});
