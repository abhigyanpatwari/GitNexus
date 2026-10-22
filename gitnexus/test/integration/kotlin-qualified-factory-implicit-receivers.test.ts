import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('Kotlin package factories and implicit receivers', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kotlin-implicit-factory-'));
    const sources = {
      'factory.kt':
        'package kqfmod\nclass Product { fun m() {} }\nfun make(): Product = Product()\n',
      'types.kt':
        'package modelpkg\nclass Other { fun m() {} }\nclass Shadow { fun make(): Other = Other() }\nclass Ctx { val kqfmod: Shadow = Shadow() }\n',
      'extension-bound.kt':
        'package caller\nimport modelpkg.Ctx\nfun Ctx.extensionBound() { val x = kqfmod.make(); x.m() }\n',
      'extension-inline.kt':
        'package caller\nimport modelpkg.Ctx\nfun Ctx.extensionInline() { kqfmod.make().m() }\n',
      'with-bound.kt':
        'package caller\nimport modelpkg.Ctx\nfun withBound(ctx: Ctx) { with(ctx) { val x = kqfmod.make(); x.m() } }\n',
      'with-inline.kt':
        'package caller\nimport modelpkg.Ctx\nfun withInline(ctx: Ctx) { with(ctx) { kqfmod.make().m() } }\n',
      'unknown-local.kt':
        'package caller\nfun load() = TODO()\nfun unknownLocal() { val kqfmod = load(); kqfmod.make().m() }\n',
      'unknown-parameter.kt':
        'package caller\nfun unknownParameter(kqfmod: ExternalThing) { kqfmod.make().m() }\n',
      'plain.kt': 'package caller\nfun plain() { kqfmod.make().m() }\n',
    };
    for (const [file, source] of Object.entries(sources))
      await fs.writeFile(path.join(root, file), source);
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  const packageTargets = (file: string) =>
    [...result.graph.iterRelationships()].filter(
      (edge) =>
        edge.type === 'CALLS' &&
        result.graph.getNode(edge.sourceId)?.properties.filePath === file &&
        edge.targetId === 'Method:factory.kt:Product.m#0',
    );
  it.each([
    'extension-bound.kt',
    'extension-inline.kt',
    'with-bound.kt',
    'with-inline.kt',
    'unknown-local.kt',
    'unknown-parameter.kt',
  ])('%s does not borrow the package receiver', (file) => {
    expect(packageTargets(file)).toEqual([]);
  });
  it('keeps the unshadowed package call', () => {
    expect(packageTargets('plain.kt')).toHaveLength(1);
  });
});
