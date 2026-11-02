import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('C++ lexical qualified factory boundaries', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-template-review-'));
    await fs.writeFile(
      path.join(root, 'original.h'),
      `
namespace original { struct C { int m(); }; }
namespace alias = original;
`,
    );
    await fs.writeFile(
      path.join(root, 'inner.h'),
      `
#include "original.h"
namespace inner {
namespace alias { struct C { int m(); }; }
int nearer(alias::C c) { return c.m(); }
}
`,
    );
    await fs.writeFile(
      path.join(root, 'main.cpp'),
      `
#include "inner.h"
namespace actual { struct Product { int m(); }; }
struct Wrong { int m(); };
struct Factory { actual::Product make(); };
struct AutoFactory { auto make() { return actual::Product{}; } };
Wrong make();
int qualified_method() { Factory f; return f.make().m(); }
int auto_method() { AutoFactory f; return f.make().m(); }
struct A { int m(); };
struct B { int m(); };
namespace rp { A produce(); }
struct Actual { static B produce(); };
template<class rp> int function_template() { return rp::produce().m(); }
template<class rp> A* pointer_template() { rp::produce().m(); return nullptr; }
struct Owner { template<class rp> int member_template() { return rp::produce().m(); } };
int concrete() { return rp::produce().m(); }
`,
    );
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  function targets(caller: string): string[] {
    return [...result.graph.iterRelationships()]
      .filter(
        (edge) =>
          edge.type === 'CALLS' &&
          result.graph.getNode(edge.sourceId)?.properties.name === caller &&
          result.graph.getNode(edge.targetId)?.properties.name === 'm',
      )
      .map((edge) => edge.targetId)
      .sort();
  }
  it('lets a nearer namespace hide an outer alias', () => {
    expect(targets('nearer')).toEqual(['Method:inner.h:C.m#0']);
  });
  it('does not borrow a free prototype for a qualified method return', () => {
    expect(targets('qualified_method')).toEqual(['Method:main.cpp:Product.m#0']);
  });
  it.each(['function_template', 'member_template', 'pointer_template'])(
    '%s retains dependent lookup',
    (caller) => {
      expect(targets(caller)).toEqual([]);
    },
  );
  it('does not borrow a free return annotation for an undeduced auto method', () => {
    expect(targets('auto_method')).toEqual([]);
  });
  it('keeps the nondependent namespace factory', () => {
    expect(targets('concrete')).toEqual(['Method:main.cpp:A.m#0']);
  });
});
