import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('C++ qualified callee collisions', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-callee-collisions-'));
    await fs.writeFile(
      path.join(root, 'lib.h'),
      `
struct FreeProduct { void m(); };
struct MemberProduct { void m(); };
struct Factory { MemberProduct get() { return MemberProduct(); } };
inline FreeProduct get() { return FreeProduct(); }
namespace real { struct AliasProduct { void m(); }; AliasProduct make(); }
namespace handle { struct WrongProduct { void m(); }; WrongProduct make(); }
`,
    );
    await fs.writeFile(
      path.join(root, 'main.cpp'),
      `
#include "lib.h"
void bound() { auto x = get(); x.m(); }
void inlined() { get().m(); }
namespace client {
namespace handle = real;
void alias_inline() { handle::make().m(); }
void alias_bound() { auto x = handle::make(); x.m(); }
}
void actual_namespace() { handle::make().m(); }
`,
    );
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  function owners(caller: string): string[] {
    const edges = [...result.graph.iterRelationships()];
    return edges
      .filter(
        (edge) =>
          edge.type === 'CALLS' &&
          result.graph.getNode(edge.sourceId)?.properties.name === caller &&
          result.graph.getNode(edge.targetId)?.properties.name === 'm',
      )
      .map((edge) => {
        const owner = edges.find(
          (candidate) => candidate.type === 'HAS_METHOD' && candidate.targetId === edge.targetId,
        );
        return String(owner && result.graph.getNode(owner.sourceId)?.properties.name);
      })
      .sort();
  }
  it.each(['bound', 'inlined'])('%s keeps the free function return type', (caller) => {
    expect(owners(caller)).toEqual(['FreeProduct']);
  });
  it.each(['alias_inline', 'alias_bound'])(
    '%s cannot borrow a shadowed namespace factory',
    (caller) => {
      expect(owners(caller)).toEqual([]);
    },
  );
  it('keeps a real namespace factory with the same spelling', () => {
    expect(owners('actual_namespace')).toEqual(['WrongProduct']);
  });
});
