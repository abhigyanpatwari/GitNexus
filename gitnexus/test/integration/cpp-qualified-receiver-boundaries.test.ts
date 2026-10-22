import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('C++ qualified receiver boundaries', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-receiver-boundaries-'));
    await fs.copyFile(
      new URL('../fixtures/cpp-qualified-receiver-boundaries.cpp', import.meta.url),
      path.join(root, 'main.cpp'),
    );
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  function receiverOwners(caller: string, ids = false): string[] {
    const edges = [...result.graph.iterRelationships()];
    return edges
      .filter(
        (e) =>
          e.type === 'CALLS' &&
          result.graph.getNode(e.sourceId)?.properties.name === caller &&
          result.graph.getNode(e.targetId)?.properties.name === 'm',
      )
      .map((e) => {
        const owner = edges.find((x) => x.type === 'HAS_METHOD' && x.targetId === e.targetId);
        return ids
          ? String(owner?.sourceId)
          : String(owner && result.graph.getNode(owner.sourceId)?.properties.name);
      })
      .sort();
  }
  it.each(['alias_field', 'alias_brace'])('%s resolves the namespace alias', (caller) => {
    expect(receiverOwners(caller)).toEqual(['AliasC']);
  });
  it('keeps the method return separate from a same-name free prototype', () => {
    expect(receiverOwners('prototype_collision')).toEqual(['A']);
  });
  it('does not select a competing overload without call evidence', () => {
    expect(receiverOwners('using_overload')).toEqual([]);
  });
  it.each(['dependent_bound', 'dependent_inline', 'dependent_outer'])(
    '%s does not borrow a namespace factory',
    (caller) => {
      expect(receiverOwners(caller)).toEqual([]);
    },
  );
  it('alias_shadowed cannot borrow the namespace alias through a local class', () => {
    const namespaceTarget = receiverOwners('alias_field', true);
    expect(namespaceTarget).toHaveLength(1);
    expect(receiverOwners('alias_shadowed', true)).not.toContain(namespaceTarget[0]);
  });
  it('keeps the concrete namespace factory', () => {
    expect(receiverOwners('qualified_positive')).toEqual(['A']);
  });
});
