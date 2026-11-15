import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import {
  typescriptProvider,
  javascriptProvider,
} from '../../../../src/core/ingestion/languages/typescript.js';
import { vueProvider } from '../../../../src/core/ingestion/languages/vue.js';
import { emitVueScopeCaptures } from '../../../../src/core/ingestion/languages/vue/captures.js';
import { extractVueScript } from '../../../../src/core/ingestion/vue-sfc-extractor.js';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from '../../../integration/resolvers/helpers.js';

const variants = [
  { extension: 'ts', provider: typescriptProvider },
  { extension: 'tsx', provider: typescriptProvider },
  { extension: 'js', provider: javascriptProvider },
  { extension: 'jsx', provider: javascriptProvider },
  { extension: 'vue', provider: vueProvider },
] as const;
const wrap = (source: string, extension: string) =>
  extension === 'vue' ? `<script setup lang="ts">\n${source}\n</script>` : source;

describe.each(variants)('$extension local loader extraction', ({ extension, provider }) => {
  function extract(source: string) {
    return extractParsedFile(provider, wrap(source, extension), `app.${extension}`)!;
  }

  it('keeps module and function ownership when their source ranges coincide', () => {
    const parsed = extract('function sole(require) { const ns = require("./blocked"); }');
    const module = parsed.scopes.find((scope) => scope.kind === 'Module')!;
    const functionScope = parsed.scopes.find((scope) => scope.kind === 'Function')!;
    expect(module.nameClaims?.some((claim) => claim.name === 'sole')).toBe(true);
    expect(module.nameClaims?.some((claim) => claim.name === 'require')).toBe(false);
    expect(functionScope.nameClaims?.some((claim) => claim.name === 'require')).toBe(true);
    expect(parsed.parsedImports).toEqual([]);
  });

  it('retains namespace, named, alias and immediately awaited bindings in their function', () => {
    const parsed = extract(`
      async function owner() {
        const ns = require('./a');
        const { run, other: renamed } = require('./b');
        const lazy = await import('./c');
        return ns.run() + run() + renamed() + lazy.run();
      }
    `);
    const imports = parsed.parsedImports.filter((imp) => 'localName' in imp && imp.localName);
    expect(imports.map((imp) => ('localName' in imp ? imp.localName : '')).sort()).toEqual([
      'lazy',
      'ns',
      'renamed',
      'run',
    ]);
    for (const imp of imports) {
      expect(parsed.scopes.find((scope) => scope.id === imp.declaredAtScope)?.kind).toBe(
        'Function',
      );
    }
  });

  it('recognizes the loader binding, including destructured parameters and catch names', () => {
    const parsed = extract(`
      function parameter(require) { const nope = require('./parameter'); }
      function destructured({ require }) { const nope = require('./destructured'); }
      function local() { const nope = require('./tdz'); const require = factory; }
      function written(require) { require = factory; const nope = require('./written'); }
      try { fail(); } catch (require) { const nope = require('./catch'); }
      const yes = require('./genuine');
    `);
    expect(parsed.parsedImports.map((imp) => imp.targetRaw)).toEqual(['./genuine']);
  });

  it('does not claim namespaces for promises, computed loads or unsupported destructuring', () => {
    const parsed = extract(`
      const promised = import('./promise');
      const computed = require(specifier);
      const { run = fallback, ...rest } = require('./unsupported');
    `);
    expect(parsed.parsedImports.filter((imp) => 'localName' in imp && imp.localName)).toEqual([]);
    expect(parsed.parsedImports.some((imp) => imp.targetRaw === './promise')).toBe(true);
  });

  it('hoists var imports to the function while keeping lexical imports in the block', () => {
    const parsed = extract(`function owner() {
      { let marker = 1; var functionLocal = require('./a'); const blockLocal = require('./b'); }
    }`);
    const imports = parsed.parsedImports.filter((imp) => 'localName' in imp && imp.localName);
    expect(
      imports
        .map((imp) => [
          'localName' in imp ? imp.localName : '',
          parsed.scopes.find((scope) => scope.id === imp.declaredAtScope)?.kind,
        ])
        .sort(),
    ).toEqual([
      ['blockLocal', 'Block'],
      ['functionLocal', 'Function'],
    ]);
  });

  it('rejects a reassigned root loader and forwarding exports from a shadowed loader', () => {
    const reassigned = extract(`require = custom; const ns = require('./blocked');`);
    expect(reassigned.parsedImports).toEqual([]);
    const forwarded = extract(`const require = custom;
      const ns = require('./blocked'); exports.forwarded = ns.run;`);
    expect(forwarded.parsedImports).toEqual([]);
  });

  it('treats a named class expression as a local loader shadow without hiding the real loader', () => {
    const parsed = extract(`const Holder = class require {
      method() { const ns = require('./shadowed'); return ns.run(); }
    }; const real = require('./genuine');`);
    expect(parsed.parsedImports.map((imp) => imp.targetRaw)).toEqual(['./genuine']);
  });

  it('does not forward a reassigned CommonJS namespace or named handle', () => {
    const parsed = extract(`let ns = require('./a'); ns = custom; exports.forwarded = ns.run;
      let { run } = require('./b'); run = custom; exports.named = run;`);
    expect(parsed.parsedImports.filter((imp) => imp.kind === 'reexport')).toEqual([]);
    expect(
      parsed.parsedImports.filter((imp) => imp.kind !== 'reexport').map((imp) => imp.targetRaw),
    ).toEqual(['./a', './b']);
  });

  it('keeps unchanged destructured CommonJS exports when sibling handles are reassigned', () => {
    const parsed = extract(`
      let { changed, stable } = require('./a');
      changed = custom;
      exports.changed = changed;
      exports.stable = stable;
      let { changed: renamedChanged, stable: renamedStable } = require('./b');
      renamedChanged = custom;
      exports.renamedChanged = renamedChanged;
      exports.renamedStable = renamedStable;
    `);
    expect(parsed.parsedImports.filter((imp) => imp.kind === 'reexport')).toEqual([
      expect.objectContaining({ targetRaw: './a', importedName: 'stable', localName: 'stable' }),
      expect.objectContaining({
        targetRaw: './b',
        importedName: 'stable',
        localName: 'renamedStable',
      }),
    ]);
  });

  it('limits reassignment barriers to imported handles, preserving ordinary local values', () => {
    const parsed = extract(`function owner(parameter) {
      let local = new Service();
      var hoisted = new Service();
      local = new Service();
      hoisted = new Service();
      parameter = new Service();
      let imported = require('./a');
      imported = custom;
    }`);
    expect(
      parsed.scopes
        .flatMap((scope) => scope.nameClaims ?? [])
        .filter((claim) => claim.kind === 'blocked')
        .map((claim) => claim.name),
    ).toEqual(['imported']);
  });
});

it('recognizes TypeScript import-equals as a module namespace binding', () => {
  const parsed = extractParsedFile(
    typescriptProvider,
    `import tools = require('./tools'); tools.run();`,
    'app.ts',
  )!;
  expect(parsed.parsedImports).toEqual([
    expect.objectContaining({
      kind: 'namespace',
      localName: 'tools',
      targetRaw: './tools',
    }),
  ]);
  const owner = parsed.scopes.find((scope) => scope.id === parsed.parsedImports[0].declaredAtScope);
  expect(owner?.kind).toBe('Module');
});

it('retains erasure on a type-only import-equals declaration', () => {
  const parsed = extractParsedFile(
    typescriptProvider,
    'import type tools = require("./tools");',
    'app.ts',
  )!;
  expect(parsed.parsedImports).toEqual([
    expect.objectContaining({
      kind: 'namespace',
      localName: 'tools',
      targetRaw: './tools',
      typeOnly: true,
    }),
  ]);
});

it('uses the same local-loader facts for full and pre-extracted Vue script', () => {
  const source = `function caller() { const ns = require('./target'); ns.run(); }`;
  const full = emitVueScopeCaptures(`<script lang="js">${source}</script>`, 'App.vue');
  const worker = emitVueScopeCaptures(source, 'App.vue', undefined, {
    sourceKind: 'pre-extracted-script',
  });
  const imports = (captures: typeof full) =>
    captures
      .filter((match) => match['@import.statement'])
      .map((match) => [
        match['@import.kind']?.text,
        match['@import.alias']?.text,
        match['@import.source']?.text,
      ]);
  expect(imports(full)).toEqual([['namespace', 'ns', './target']]);
  expect(imports(worker)).toEqual(imports(full));
});

it('preserves lexical positions while giving full and pre-extracted Vue declarations equal graph positions', () => {
  const declaration =
    'function outer() { function inner() { return ns.run(); } const ns = require("./target"); return inner(); }';
  const source = `<template>\n<div />\n</template>\n<script setup lang="ts">\n${declaration}\n</script>`;
  const extracted = extractVueScript(source)!;
  const full = extractParsedFile(vueProvider, source, 'App.vue')!;
  const worker = extractParsedFile(
    vueProvider,
    extracted.scriptContent,
    'App.vue',
    undefined,
    undefined,
    'pre-extracted-script',
    undefined,
    extracted.lineOffset,
  )!;
  expect(worker.localDefs).toEqual(full.localDefs);
  const inner = full.localDefs.find((def) => def.qualifiedName === 'inner')!;
  const innerColumn = declaration.indexOf('function inner');
  expect(inner.nodeId).toBe(`def:App.vue#2:${innerColumn}:Function:inner`);
  expect(inner.graphPosition).toEqual({
    startLine: 2 + extracted.lineOffset,
    startCol: innerColumn,
  });
  expect(
    full.scopes.find((scope) => scope.ownedDefs.some((def) => def.nodeId === inner.nodeId))?.range
      .startLine,
  ).toBe(2);
});

describe('local-loader graph targets', () => {
  let repo: string;
  let result: PipelineResult;
  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-local-loaders-'));
    const files: Record<string, string> = {};
    for (const { extension } of variants) {
      const targetExtension =
        extension === 'vue' || extension === 'tsx' ? 'ts' : extension === 'jsx' ? 'js' : extension;
      files[`${extension}/a.${targetExtension}`] = 'export function run() { return 1; }';
      files[`${extension}/b.${targetExtension}`] = 'export function run() { return 2; }';
      files[`${extension}/app.${extension}`] = wrap(
        `
        import { run } from './a';
        import * as root from './a';
        class LocalService { work() { return 1; } }
        ${
          extension === 'js' || extension === 'jsx'
            ? '/** @type {LocalService} */ let moduleClient;'
            : 'let moduleClient: LocalService;'
        }
        export function assignModuleClient() { moduleClient = new LocalService(); }
        export function readModuleClient() { return moduleClient.work(); }
        export function assignedLet() {
          let service = new LocalService(); service = new LocalService(); service.work();
        }
        export function assignedVar() {
          var service = new LocalService(); service = new LocalService(); service.work();
        }
        ${
          extension === 'ts' || extension === 'tsx' || extension === 'vue'
            ? `
        export function assignedTyped() {
          let service: LocalService; service = new LocalService(); service.work();
        }
        export function assignedParameter(service: LocalService) {
          service = new LocalService(); service.work();
        }`
            : ''
        }
        function replacedLoader() {}
        var replacedLoader = require('./a');
        replacedLoader = factory;
        export function replacedDeclaration() { return replacedLoader.run(); }
        export function first() { const ns = require('./a'); return ns.run(); }
        export function second() { const ns = require('./b'); return ns.run(); }
        export function named() { const { run: chosen } = require('./b'); return chosen(); }
        export async function lazy() { const { run: chosen } = await import('./a'); return chosen(); }
        export function varAfter() { { let marker = 1; var ns = require('./a'); } return ns.run(); }
        export function varRedeclared() { var ns = require('./a'); var ns; return ns.run(); }
        export function varDeclaredBefore() { var ns; var ns = require('./b'); return ns.run(); }
        export function functionRedeclared() { function retained() {} var retained; retained(); }
        export function varOnly() { run(); var run; }
        export function closure() { function inner() { return ns.run(); } const ns = require('./a'); return inner(); }
        export function unbound() { return ns.run(); }
        export function parameter(ns) { return ns.run(); }
        export function parameterCall(run) { return run(); }
        export function destructured({ run }) { return run(); }
        export function outsideBlock() { { const ns = require('./a'); } return ns.run(); }
        export function unresolved() { const root = require('./missing'); return root.run(); }
        export function mutated() { let ns = require('./a'); ns = factory; return ns.run(); }
        export function conditional() { if (flag) { var ns = require('./a'); } return ns.run(); }
        export function before() { ns.run(); const ns = require('./a'); }
        export function blocked(require) { const ns = require('./a'); return ns.run(); }
      `,
        extension,
      );
      if (extension === 'ts' || extension === 'js') {
        files[`${extension}/forward.${extension}`] = `
          let { run: changed, stable } = require('./exports');
          changed = custom;
          exports.changed = changed;
          exports.stable = stable;
          let { run: renamedChanged, stable: renamedStable } = require('./exports');
          renamedChanged = custom;
          exports.renamedChanged = renamedChanged;
          exports.renamedStable = renamedStable;
        `;
        files[`${extension}/exports.${extension}`] = `
          exports.run = function run() { return 1; };
          exports.stable = function stable() { return 2; };
        `;
        files[`${extension}/consumer.${extension}`] = `
          const { changed, stable, renamedChanged, renamedStable } = require('./forward');
          export function callChanged() { return changed(); }
          export function callStable() { return stable(); }
          export function callRenamedChanged() { return renamedChanged(); }
          export function callRenamedStable() { return renamedStable(); }
        `;
      }
    }
    writeFixtureRepo(repo, files);
    result = await runPipelineFromRepo(repo, () => {}, { workerPoolSize: 1 });
  }, 120_000);
  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it.each(variants)(
    '$extension retains method calls after ordinary receiver assignment',
    ({ extension }) => {
      expect(
        getRelationships(result, 'CALLS')
          .filter(
            (edge) =>
              edge.sourceFilePath === `${extension}/app.${extension}` && edge.target === 'work',
          )
          .map((edge) => [edge.source, edge.targetFilePath])
          .sort(),
      ).toEqual(
        [
          'assignedLet',
          'assignedVar',
          'readModuleClient',
          ...(extension === 'ts' || extension === 'tsx' || extension === 'vue'
            ? ['assignedTyped', 'assignedParameter']
            : []),
        ]
          .sort()
          .map((name) => [name, `${extension}/app.${extension}`]),
      );
    },
  );

  it.each(['ts', 'js'])(
    '%s forwards unchanged destructured siblings to their exact definition',
    (extension) => {
      expect(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.sourceFilePath === `${extension}/consumer.${extension}`)
          .map((edge) => [edge.source, edge.target, edge.targetFilePath])
          .sort(),
      ).toEqual([
        ['callRenamedStable', 'stable', `${extension}/exports.${extension}`],
        ['callStable', 'stable', `${extension}/exports.${extension}`],
      ]);
    },
  );

  it.each(variants)(
    '$extension binds exact targets and excludes sibling, parameter and TDZ leakage',
    ({ extension }) => {
      const calls = getRelationships(result, 'CALLS')
        .filter(
          (edge) =>
            edge.sourceFilePath === `${extension}/app.${extension}` && edge.target === 'run',
        )
        .map((edge) => `${edge.source} -> ${edge.targetFilePath}`)
        .sort();
      const targetExtension =
        extension === 'vue' || extension === 'tsx' ? 'ts' : extension === 'jsx' ? 'js' : extension;
      expect(calls).toEqual([
        `first -> ${extension}/a.${targetExtension}`,
        `inner -> ${extension}/a.${targetExtension}`,
        `lazy -> ${extension}/a.${targetExtension}`,
        `named -> ${extension}/b.${targetExtension}`,
        `second -> ${extension}/b.${targetExtension}`,
        `varAfter -> ${extension}/a.${targetExtension}`,
        `varDeclaredBefore -> ${extension}/b.${targetExtension}`,
        `varRedeclared -> ${extension}/a.${targetExtension}`,
      ]);
      expect(
        getRelationships(result, 'CALLS')
          .filter(
            (edge) =>
              edge.sourceFilePath === `${extension}/app.${extension}` &&
              edge.source === 'functionRedeclared',
          )
          .map((edge) => [edge.target, edge.targetFilePath]),
      ).toEqual([['retained', `${extension}/app.${extension}`]]);
    },
  );
});
