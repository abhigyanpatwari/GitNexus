import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('Kotlin package factory review boundaries', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kotlin-factory-review-'));
    const sources: Record<string, string> = {
      'factory.kt':
        'package kqfmod\nclass Product { fun m() {} }\nfun make(): Product = Product()\n',
      'wildcard.kt':
        'package caller\nimport kqfmod.*\nfun wildcard() { val x = kqfmod.make(); x.m() }\n',
      'spacing.kt': 'package caller\nfun spacing() { kqfmod\n .make().m() }\n',
      'base.kt':
        'package basepkg\nclass LocalProduct { fun m() {} }\nclass LocalFactory { fun make(): LocalProduct = LocalProduct() }\nopen class Base { val kqfmod: LocalFactory = LocalFactory() }\n',
      'derived.kt':
        'package caller\nimport basepkg.Base\nclass Derived: Base() { fun inherited() { val x = kqfmod.make(); x.m() } }\n',
      'plain.kt': 'package caller\nfun plain() { val x = kqfmod.make(); x.m() }\n',
    };
    for (const [file, source] of Object.entries(sources))
      await fs.writeFile(path.join(root, file), source);
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  const targets = (caller: string) =>
    [...result.graph.iterRelationships()]
      .filter(
        (edge) =>
          edge.type === 'CALLS' &&
          result.graph.getNode(edge.sourceId)?.properties.name === caller &&
          result.graph.getNode(edge.targetId)?.properties.name === 'm',
      )
      .map((edge) => edge.targetId);
  it.each(['plain', 'wildcard', 'spacing'])('%s resolves the package factory', (caller) => {
    expect(targets(caller)).toEqual(['Method:factory.kt:Product.m#0']);
  });
  it('does not borrow the package through an inherited field', () => {
    expect(targets('inherited')).not.toContain('Method:factory.kt:Product.m#0');
  });
});
