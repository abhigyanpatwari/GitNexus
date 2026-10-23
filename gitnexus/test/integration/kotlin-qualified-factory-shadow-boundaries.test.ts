import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';
let root: string;
let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
const body = 'val x = kqfmod.make(); x.m(); kqfmod.make().m()';
const cases: Record<string, string> = {
  'untypedloop.kt': `class Box { fun items(): List<Shadow> = listOf(Shadow()) }\nfun probeUntypedLoop(box: Box) { for (kqfmod in box.items()) { ${body} } }`,
  'unknownparameter.kt': `fun probeUnknownParameter(kqfmod: MissingLibraryType) { ${body} }`,
  'unknownloop.kt': `fun probeUnknownLoop(items: List<MissingLibraryType>) { for (kqfmod in items) { ${body} } }`,
  'unknownlocal.kt': `fun probeUnknownLocal() { val kqfmod: MissingLibraryType = TODO(); ${body} }`,
  'nesteduntyped.kt': `open class Parent { object kqfmod { fun make() {} } }\nclass Host: Parent() { fun probeNestedUntyped() { ${body} } }`,
  'plainimport.kt': `import shadowed.kqfmod\nfun probeImport() { ${body} }`,
  'escapeddestructure.kt':
    'fun probeEscaped(p: Pair<Shadow, Int>) { val (`kqfmod`, n) = p; ' + body + ' }',
  'destructure.kt': `fun probeDestructure(p: Pair<Shadow, Int>) { val (kqfmod, n) = p; ${body} }`,
  'loopdestructure.kt': `fun probeLoopDestructure(items: List<Pair<Shadow, Int>>) { for ((kqfmod, n) in items) { ${body} } }`,
  'constructparam.kt': `class Host(kqfmod: Shadow) { init { ${body} } }`,
  'whenbinding.kt': `fun probeWhen() { when (val kqfmod = Shadow()) { else -> { ${body} } } }`,
  'nestedobject.kt': `import parents.Other\nopen class Parent { object kqfmod { fun make(): Other = Other() } }\nclass Host: Parent() { fun probeNested() { ${body} } }`,
  'local.kt': `fun probeLocal() { val kqfmod = Shadow(); ${body} }`,
  'parameter.kt': `fun probeParameter(kqfmod: Shadow) { ${body} }`,
  'lambda.kt': `fun probeLambda() { listOf(Shadow()).forEach { kqfmod -> ${body} } }`,
  'implicit.kt': `fun probeImplicit() { listOf(Shadow()).forEach { val x = it.make(); x.m(); it.make().m() } }`,
  'catch.kt': `fun probeCatch() { try { throw ShadowError() } catch (kqfmod: ShadowError) { ${body} } }`,
  'loop.kt': `fun probeLoop(items: List<Shadow>) { for (kqfmod in items) { ${body} } }`,
  'member.kt': `class Host(val kqfmod: Shadow) { fun probeMember() { ${body} } }`,
  'companion.kt': `class Host { companion object { val kqfmod = Shadow() }; fun probeCompanion() { ${body} } }`,
  'alias.kt': `import parents.kqfObject as kqfmod\nfun probeAlias() { ${body} }`,
  'top.kt': `val kqfmod = Shadow()\nfun probeTop() { ${body} }`,
  'sibling.kt': `fun probeSibling() { ${body} }`,
  'star.kt': `import shadowed.*\nfun probeStar() { ${body} }`,
  'field.kt': `class Host { var entry: Shadow = Shadow()\nget() { val x = field.make(); x.m(); field.make().m(); return field } }`,
  'setter.kt': `class Host { var entry: Shadow = Shadow()\nset(value) { val x = field.make(); x.m(); field.make().m(); field = value } }`,
};
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-kotlin-package-shadow-'));
  const files: Record<string, string> = {
    'claim-collisions.kt':
      'package collisions\nclass Repo { fun save() {} }\nclass Foo { fun bar() {} }\nclass Service(repo: Repo) { private val repo: Repo = repo; fun run() { repo.save() } }\nfun probeLoop(m: Map<String, Int>) { for ((k, v) in m) {}; val k = Foo(); k.bar() }\nfun probeLoopVar(xs: List<Foo>, p: Pair<Int, Int>) { for (k in xs) { k.bar() }; val (k, n) = p }',
    'factory.kt': 'package kqfmod\nclass Product { fun m() {} }\nfun make(): Product = Product()',
    'it-factory.kt':
      'package it\nclass ItProduct { fun m() {} }\nfun make(): ItProduct = ItProduct()',
    'field-factory.kt':
      'package field\nclass FieldProduct { fun m() {} }\nfun make(): FieldProduct = FieldProduct()',
    'parents.kt':
      'package parents\nclass Other { fun m() {} }\nclass Shadow { fun make(): Other = Other() }\nclass ShadowError: Exception() { fun make(): Other = Other() }\nobject kqfObject { fun make(): Other = Other() }',
    'sibling-property.kt': 'package p.sibling\nimport parents.Shadow\nval kqfmod = Shadow()',
    'star-property.kt': 'package shadowed\nimport parents.Shadow\nval kqfmod = Shadow()',
    'unrelated.kt':
      'package p.unrelated\nfun unrelated() { val kqfmod = 1 }\nfun unrelatedBound() { val x = kqfmod.make(); x.m() }\nfun unrelatedInline() { kqfmod.make().m() }',
  };
  for (const [file, source] of Object.entries(cases)) {
    files[file] =
      `package p.${path.basename(file, '.kt')}\nimport parents.Shadow\nimport parents.ShadowError\n${source}`;
  }
  writeFixtureRepo(root, files);
  result = await runPipelineFromRepo(root, () => {}, {});
}, 120000);
afterAll(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});
it.each(['unrelatedBound', 'unrelatedInline'])(
  'retains %s despite a local in another function',
  (caller) => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === caller && edge.target === 'm',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.rel.targetId).toBe('Method:factory.kt:Product.m#0');
  },
);
it.each(Object.keys(cases))('never uses a package factory for a shadowed head in %s', (file) => {
  const calls = getRelationships(result, 'CALLS').filter(
    (edge) => edge.rel.sourceId.includes(`:${file}:`) && edge.rel.targetId.includes('Product.m'),
  );
  expect(calls).toEqual([]);
});

it.each([
  ['run', 'Repo.save'],
  ['probeLoop', 'Foo.bar'],
  ['probeLoopVar', 'Foo.bar'],
])('retains ordinary %s bindings alongside partial claims', (caller, target) => {
  const calls = getRelationships(result, 'CALLS').filter(
    (edge) =>
      edge.source === caller && edge.rel.targetId === `Method:claim-collisions.kt:${target}#0`,
  );
  expect(calls).toHaveLength(1);
});
