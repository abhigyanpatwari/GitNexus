import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

async function writeProject(sources: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-kotlin-factory-boundary-'));
  for (const [file, source] of Object.entries(sources)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), source);
  }
  return root;
}

type Result = Awaited<ReturnType<typeof runPipelineFromRepo>>;
function memberTargets(result: Result, source: string) {
  expect(result.graph.getNode(source)).toBeDefined();
  return [...result.graph.iterRelationships()]
    .filter(
      (edge) =>
        edge.type === 'CALLS' &&
        edge.sourceId === source &&
        result.graph.getNode(edge.targetId)?.properties.name === 'm',
    )
    .map((edge) => edge.targetId);
}

describe('Kotlin package heads under incomplete inheritance', () => {
  let root: string;
  let result: Result;
  beforeAll(async () => {
    root = await writeProject({
      'factory.kt': 'package kqfmod\nclass Product { fun m() {} }\nfun make(): Product = Product()',
      'parents.kt':
        'package parents\nopen class NormalBase\nclass Other { fun m() {} }\nclass Shadow { fun make(): Other = Other() }\nopen class ShadowBase { val kqfmod: Shadow = Shadow() }',
      'caller.kt':
        'package caller\nimport parents.NormalBase\nclass UnknownHost : lib.Base() { fun unknownInline() { kqfmod.make().m() }\nfun unknownBound() { val x = kqfmod.make(); x.m() } }\nclass MixedHost : NormalBase(), lib.Iface { fun mixedInline() { kqfmod.make().m() }\nfun mixedBound() { val x = kqfmod.make(); x.m() } }\nclass KnownHost : NormalBase() { fun knownInline() { kqfmod.make().m() }\nfun knownBound() { val x = kqfmod.make(); x.m() } }',
      'companion.kt':
        'package caller\nclass UnknownCompanion { companion object : lib.Base() {}\nfun run() { kqfmod.make().m() } }\nclass KnownCompanion { companion object : parents.ShadowBase() {}\nfun run() { kqfmod.make().m() } }\nclass PlainCompanion { companion object { val marker = 1 }\nfun run() { kqfmod.make().m() } }',
      'plain.kt': 'package caller\nfun plain() { kqfmod.make().m() }',
    });
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  it.each([
    ['UnknownHost', 'unknownInline'],
    ['UnknownHost', 'unknownBound'],
    ['MixedHost', 'mixedInline'],
    ['MixedHost', 'mixedBound'],
  ])('refuses an unproven implicit receiver in %s.%s', (owner, method) => {
    expect(memberTargets(result, 'Method:caller.kt:' + owner + '.' + method + '#0')).toEqual([]);
  });
  it.each(['knownInline', 'knownBound'])('retains %s under a resolved base', (method) => {
    expect(memberTargets(result, 'Method:caller.kt:KnownHost.' + method + '#0')).toEqual([
      'Method:factory.kt:Product.m#0',
    ]);
  });
  it('refuses an unknown companion supertype', () => {
    expect(memberTargets(result, 'Method:companion.kt:UnknownCompanion.run#0')).toEqual([]);
  });
  it('never replaces an inherited companion member with a package', () => {
    const targets = memberTargets(result, 'Method:companion.kt:KnownCompanion.run#0');
    // The main-branch control currently emits no edge for this companion shape.
    // Allow future ordinary resolution of Other.m while rejecting every other owner.
    expect(targets.filter((target) => target !== 'Method:parents.kt:Other.m#0')).toEqual([]);
  });
  it('retains a package call with a companion that has no supertypes', () => {
    expect(memberTargets(result, 'Method:companion.kt:PlainCompanion.run#0')).toEqual([
      'Method:factory.kt:Product.m#0',
    ]);
  });
  it('retains the package call outside a class', () => {
    expect(memberTargets(result, 'Function:plain.kt:plain')).toEqual([
      'Method:factory.kt:Product.m#0',
    ]);
  });
});

it.each(['a', 'b'])(
  'refuses duplicate qualified types for producer root %s',
  async (producer) => {
    const root = await writeProject({
      'a/src/main/kotlin/model/Product.kt': 'package model\nclass Product { fun m() {} }',
      'b/src/main/kotlin/model/Product.kt': 'package model\nclass Product { fun m() {} }',
      [producer + '/src/main/kotlin/kqfmod/factory.kt']:
        'package kqfmod\nfun make(): model.Product = TODO()',
      [producer + '/src/main/kotlin/app/App.kt']:
        'package app\nfun inlineCall() { kqfmod.make().m() }\nfun boundCall() { val x = kqfmod.make(); x.m() }',
      'decoy.kt': 'package decoy\nclass Other { fun m() {} }',
    });
    try {
      const result = await runPipelineFromRepo(root, () => {}, {});
      for (const method of ['inlineCall', 'boundCall']) {
        expect(
          memberTargets(result, 'Function:' + producer + '/src/main/kotlin/app/App.kt:' + method),
        ).toEqual([]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  120000,
);

it.each(['unique', 'declaration-local'])(
  'retains a proven %s qualified type',
  async (kind) => {
    const local = kind === 'declaration-local';
    const sources: Record<string, string> = {
      'b/src/main/kotlin/model/Product.kt':
        'package model\nclass Product { fun m() {} }' +
        (local ? '\nfun make(): model.Product = TODO()' : ''),
      'b/src/main/kotlin/app/App.kt':
        'package app\nfun inlineCall() { model.make().m() }\nfun boundCall() { val x = model.make(); x.m() }',
      'decoy.kt': 'package decoy\nclass Other { fun m() {} }',
    };
    if (local)
      sources['a/src/main/kotlin/model/Product.kt'] = 'package model\nclass Product { fun m() {} }';
    else
      sources['b/src/main/kotlin/model/factory.kt'] =
        'package model\nfun make(): model.Product = TODO()';
    const root = await writeProject(sources);
    try {
      const result = await runPipelineFromRepo(root, () => {}, {});
      for (const method of ['inlineCall', 'boundCall']) {
        expect(memberTargets(result, 'Function:b/src/main/kotlin/app/App.kt:' + method)).toEqual([
          'Method:b/src/main/kotlin/model/Product.kt:Product.m#0',
        ]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
