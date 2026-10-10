import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { finalize, SupportedLanguages, type ParsedFile } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { getProviderForFile } from '../../src/core/ingestion/languages/index.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { describeGrammarPresence, optionalGrammarGate } from '../helpers/optional-grammar.js';

const zig = optionalGrammarGate(SupportedLanguages.Zig);
describeGrammarPresence(zig);

const loaderSource = `function allowed() {
  const ns = require('./target');
  const { run: renamed } = require('./target');
  ns.run(); renamed();
}
function blocked(require) { const ns = require('./forbidden'); ns.run(); }
function ordered() { ns.run(); const ns = require('./target'); ns.run(); }
function hoisted() { { var ns = require('./target'); } ns.run(); }
async function dynamic() { const ns = await import('./target'); ns.run(); }
const Named = class Hidden { method() { return Hidden; } };
class Parent {}
class Child extends Parent {}
`;
const fixtures: Record<string, string> = {
  'depends.py': `from fastapi import Depends
def dependency(): return 1
def handler(value=Depends(dependency)): return value
`,
  'python.py': `from target import run
def allowed():
    from target import run
    return run()
def blocked():
    run()
    from target import run
def redirected():
    global run
    from target import run
    return run()
def enclosing():
    from target import run
    class Nested:
        before = run()
        from other import run
        after = run()
        def method(self): return run()
    return [run() for value in values]
class Parent: pass
class Child(Parent): pass
`,
  'typescript.ts': `${loaderSource}\nfunction typed(value: Child): Parent { return value; }`,
  'typescript.tsx': `${loaderSource}\nconst element = <Child />;`,
  'javascript.js': loaderSource,
  'javascript.jsx': `${loaderSource}\nconst element = <Child />;`,
  'vue-js.vue': `<template>\n<div />\n</template>\n<script lang="js">\n${loaderSource}\n</script>`,
  'vue-jsx.vue': `<template>\n<div />\n</template>\n<script lang="jsx">\n${loaderSource}\nconst element = <Child />;\n</script>`,
  'vue-ts.vue': `<template>\n<div />\n</template>\n<script setup lang="ts">\n${loaderSource}\nfunction typed(value: Child): Parent { return value; }\n</script>`,
  'rust.rs': `mod target;
fn allowed() { run(); use crate::target::run; }
fn blocked() { use crate::missing::run; run(); }
fn typed(value: Item) { use crate::target::Item; value.run(); }
fn sibling() { run(); }
`,
  'cpp.cpp': `#include "target.hpp"
int allowed() { using target::run; return run(); }
int blocked() { using missing::run; return run(); }
int directive() { using namespace target; return run(); }
int typed() { using target::Item; Item value; return value.run(); }
`,
  ...(zig.available
    ? {
        'zig.zig': `pub fn allowed() void { const ns = @import("target.zig"); ns.run(); }
pub fn blocked() void { ns.run(); const ns = @import("target.zig"); }
pub fn siblings() void { { const ns = @import("a.zig"); ns.run(); } { const ns = @import("b.zig"); ns.run(); } }
`,
      }
    : {}),
};

// Maps/Sets are part of the shared Scope contract. Their entries, and every
// provider fact, must contain only data: never a tree-sitter node or callback.
function assertPlainFacts(value: unknown): void {
  if (value === null || value === undefined || typeof value !== 'object') {
    expect(['function', 'symbol']).not.toContain(typeof value);
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      assertPlainFacts(key);
      assertPlainFacts(item);
    }
  } else if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) assertPlainFacts(item);
  } else {
    expect([Object.prototype, null]).toContain(Object.getPrototypeOf(value));
    for (const item of Object.values(value)) assertPlainFacts(item);
  }
}

describe('local-import facts across the real parse worker', () => {
  let tempDir: string;
  let output: Awaited<ReturnType<typeof runChunkedParseAndResolve>>;
  let workerFiles: Map<string, ParsedFile>;
  let directFiles: Map<string, ParsedFile>;
  let witness: Array<{
    type: string;
    files?: string[];
    fileCount?: number;
    parsedPaths?: string[];
  }>;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-local-import-worker-'));
    const repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir);
    const marker = path.join(tempDir, 'worker.jsonl');
    const worker = path.join(tempDir, 'observed-worker.mjs');
    const realWorker = new URL(
      '../../dist/core/ingestion/workers/parse-worker.js',
      import.meta.url,
    );
    expect(fs.existsSync(realWorker), 'build gitnexus before real-worker parity tests').toBe(true);
    fs.writeFileSync(
      worker,
      `
import fs from 'node:fs';
import { parentPort, threadId } from 'node:worker_threads';
const record = (entry) => fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(entry) + '\\n');
record({ type: 'boot', threadId });
parentPort.on('message', (message) => {
  if (message.type === 'sub-batch') record({ type: 'dispatch', files: message.files.map(file => file.path) });
});
const send = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, ...rest) => {
  if (message.type === 'result') record({ type: 'result', fileCount: message.data.fileCount,
    parsedPaths: message.data.parsedFiles.map(file => file.filePath) });
  return send(message, ...rest);
};
await import(${JSON.stringify(realWorker.href)});
`,
    );
    directFiles = new Map();
    for (const [filePath, source] of Object.entries(fixtures)) {
      fs.writeFileSync(path.join(repoDir, filePath), source);
      const provider = getProviderForFile(filePath)!;
      const parsed = extractParsedFile(provider, source, filePath);
      expect(parsed, `direct extraction for ${filePath}`).toBeDefined();
      const captureSideChannel = provider.collectCaptureSideChannel?.(filePath);
      directFiles.set(
        filePath,
        captureSideChannel === undefined ? parsed! : { ...parsed!, captureSideChannel },
      );
    }
    const paths = Object.keys(fixtures);
    output = await runChunkedParseAndResolve(
      createKnowledgeGraph(),
      paths.map((filePath) => ({
        path: filePath,
        size: fs.statSync(path.join(repoDir, filePath)).size,
      })),
      paths,
      paths.length,
      repoDir,
      Date.now(),
      () => {},
      { workerUrlForTest: pathToFileURL(worker), workerPoolSize: 1 },
    );
    workerFiles = new Map(output.parsedFiles.map((file) => [file.filePath, file]));
    witness = fs
      .readFileSync(marker, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }, 120_000);

  afterAll(() => {
    // runChunkedParseAndResolve owns the pool's native-safe drain handshake.
    if (tempDir)
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('witnesses actual worker dispatch and returned ParsedFiles without a fallback', () => {
    expect(output.usedWorkerPool).toBe(true);
    expect(output.reparsedFileCount).toBe(Object.keys(fixtures).length);
    expect(output.parseCacheHitFileCount).toBe(0);
    expect(output.scopeExtractionFailures).toEqual([]);
    expect(witness.some((entry) => entry.type === 'boot')).toBe(true);
    expect(witness.flatMap((entry) => entry.files ?? []).sort()).toEqual(
      Object.keys(fixtures).sort(),
    );
    expect(witness.flatMap((entry) => entry.parsedPaths ?? []).sort()).toEqual(
      Object.keys(fixtures).sort(),
    );
    expect([...workerFiles.keys()].sort()).toEqual(Object.keys(fixtures).sort());
  });

  it.each(Object.keys(fixtures))('preserves complete direct provider facts for %s', (filePath) => {
    const direct = directFiles.get(filePath)!;
    const transported = workerFiles.get(filePath)!;
    expect(direct.scopes.some((scope) => (scope.nameClaims?.length ?? 0) > 0)).toBe(true);
    expect(transported).toEqual(direct);
    assertPlainFacts(transported);
  });

  it('retains the deferred Depends caller independently of its lexical lookup scope', () => {
    const parsed = workerFiles.get('depends.py')!;
    const site = parsed.referenceSites.find(
      (reference) =>
        reference.kind === 'call' &&
        reference.name === 'dependency' &&
        reference.callerScope !== undefined,
    );
    expect(site).toBeDefined();
    expect(site!.inScope).toBe(parsed.moduleScope);
    expect(site!.callerScope).not.toBe(site!.inScope);
    expect(parsed.scopes.find((scope) => scope.id === site!.callerScope)?.kind).toBe('Function');
  });

  it('derives identical finalized ImportEdge positions from transported facts', () => {
    const target = extractParsedFile(
      getProviderForFile('target.py')!,
      'def run(): return 1\n',
      'target.py',
    )!;
    const link = (source: ParsedFile) =>
      finalize(
        {
          files: [source, target],
          workspaceIndex: undefined,
        },
        {
          importsBindAtLexicalScope: true,
          resolveImportTarget: (raw) => (raw === 'target' ? target.filePath : null),
          expandsWildcardTo: () => [],
          mergeBindings: (existing, incoming) => [...existing, ...incoming],
        },
      );
    const direct = link(directFiles.get('python.py')!);
    const transported = link(workerFiles.get('python.py')!);
    expect(transported.imports).toEqual(direct.imports);
    const edges = [...transported.imports.values()].flat();
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((edge) => edge.atRange !== undefined)).toBe(true);
    expect(edges.some((edge) => edge.targetFile === 'target.py' && edge.localName === 'run')).toBe(
      true,
    );
  });

  it('exercises ownership, activation, semantic positions, and C++ side-channel data', () => {
    const files = [...workerFiles.values()];
    const scopes = files.flatMap((file) => file.scopes);
    const claims = scopes.flatMap((scope) => scope.nameClaims ?? []);
    expect(claims.some((claim) => claim.availableFrom !== undefined)).toBe(true);
    expect(claims.some((claim) => claim.redirect !== undefined)).toBe(true);
    expect(claims.some((claim) => claim.inactive !== undefined)).toBe(true);
    expect(claims.some((claim) => claim.hoisted === true)).toBe(true);
    expect(claims.some((claim) => claim.merge === true)).toBe(true);
    const policies = scopes.flatMap((scope) => (scope.lookupPolicy ? [scope.lookupPolicy] : []));
    for (const key of [
      'skipFromChildren',
      'deferParentActivation',
      'parentScope',
      'visibleNamesFromChildren',
      'callerScopeIsAuthoritative',
      'nameClaimsComplete',
    ] as const) {
      expect(
        policies.some((policy) => policy[key] !== undefined),
        key,
      ).toBe(true);
    }
    const bindings = scopes.flatMap((scope) => [...scope.bindings.values()].flat());
    expect(bindings.some((binding) => binding.declarationRange !== undefined)).toBe(true);
    // BindingRef.availableFrom is synthesized by the C++ resolution hook,
    // after transport; the persistence graph assertions cover its activation.
    const types = scopes.flatMap((scope) => [...scope.typeBindings.values()]);
    for (const key of ['lookupPosition', 'lookupPurpose', 'bindingRange'] as const) {
      expect(
        types.some((type) => type[key] !== undefined),
        key,
      ).toBe(true);
    }
    const imports = files.flatMap((file) => file.parsedImports);
    expect(imports.some((imp) => imp.atRange !== undefined)).toBe(true);
    expect(imports.some((imp) => imp.bindsAtLexicalScope === true)).toBe(true);
    expect(
      files.flatMap((file) => file.referenceSites).some((site) => site.lookupScope !== undefined),
    ).toBe(true);
    expect(
      workerFiles.get('vue-ts.vue')!.localDefs.some((def) => def.graphPosition !== undefined),
    ).toBe(true);
    expect(workerFiles.get('cpp.cpp')!.captureSideChannel).toEqual(
      expect.objectContaining({
        usingDeclarations: expect.arrayContaining([expect.any(Object)]),
      }),
    );
  });
});
