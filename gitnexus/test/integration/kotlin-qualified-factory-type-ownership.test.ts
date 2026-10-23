import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('Kotlin qualified factory type ownership', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kotlin-factory-owners-'));
    const sources = {
      'wrong-client.kt':
        'package wrong\nclass Wrong { fun m() {} }\nclass Client { val child: Wrong = Wrong() }\n',
      'vendor-use.kt':
        'package caller\nfun externalCtor() { val x = vendor.Client(); x.child.m() }\n',
      'real.kt': 'package real\nclass Product { fun m() {} }\n',
      'factory.kt':
        'package factory\nclass Product { fun m() {} }\nfun make(): real.Product = real.Product()\n',
      'consumer.kt':
        'package caller\nfun boundReturn() { val x = factory.make(); x.m() }\nfun inlineReturn() { factory.make().m() }\n',
    };
    for (const [file, source] of Object.entries(sources))
      await fs.writeFile(path.join(root, file), source);
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  const targets = (name: string) =>
    [...result.graph.iterRelationships()]
      .filter(
        (edge) =>
          edge.type === 'CALLS' &&
          result.graph.getNode(edge.sourceId)?.properties.name === name &&
          result.graph.getNode(edge.targetId)?.properties.name === 'm',
      )
      .map((edge) => edge.targetId);
  it('does not borrow a workspace class through an unresolved external constructor', () => {
    expect(targets('externalCtor')).toEqual([]);
  });
  it.each(['boundReturn', 'inlineReturn'])('%s preserves the qualified return owner', (name) => {
    expect(targets(name)).toEqual(['Method:real.kt:Product.m#0']);
  });
});
