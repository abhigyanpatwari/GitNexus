import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('C++ namespace spelling and header order', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-namespace-order-'));
    const sources: Record<string, string> = {
      'z_provider.h': 'namespace one { struct FirstProduct { int m(); }; } namespace first = one;',
      'a_consumer.h':
        '#include "z_provider.h"\nnamespace second = first; struct FirstHolder { second::FirstProduct c; int first_use() { return c.m(); } };',
      'a_provider.h':
        'namespace two { struct SecondProduct { int m(); }; } namespace before = two;',
      'z_consumer.h':
        '#include "a_provider.h"\nnamespace after = before; struct SecondHolder { after::SecondProduct c; int second_use() { return c.m(); } };',
      'main.cpp': `
#include "a_consumer.h"
#include "z_consumer.h"
namespace outer {
namespace lib { inline namespace v1 { struct RelativeProduct { int m(); }; } }
struct Decoy { int m(); };
void relative_brace() { auto x = lib::RelativeProduct{}; x.m(); }
struct RelativeHolder { lib::RelativeProduct field; void relative_field() { field.m(); } };
}
`,
    };
    for (const [name, source] of Object.entries(sources))
      await fs.writeFile(path.join(root, name), source);
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  it.each([
    ['relative_brace', 'Method:main.cpp:RelativeProduct.m#0'],
    ['relative_field', 'Method:main.cpp:RelativeProduct.m#0'],
    ['first_use', 'Method:z_provider.h:FirstProduct.m#0'],
    ['second_use', 'Method:a_provider.h:SecondProduct.m#0'],
  ])('%s resolves its own namespace', (caller, target) => {
    expect(
      [...result.graph.iterRelationships()]
        .filter(
          (edge) =>
            edge.type === 'CALLS' &&
            result.graph.getNode(edge.sourceId)?.properties.name === caller &&
            result.graph.getNode(edge.targetId)?.properties.name === 'm',
        )
        .map((edge) => edge.targetId),
    ).toEqual([target]);
  });
});
