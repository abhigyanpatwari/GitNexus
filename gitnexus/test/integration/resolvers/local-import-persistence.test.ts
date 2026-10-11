import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SupportedLanguages, type ParsedFile } from 'gitnexus-shared';
import * as scopeBridge from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { getProviderForFile } from '../../../src/core/ingestion/languages/index.js';
import { summarizeUnresolvedReceivers } from '../../../src/core/ingestion/scope-resolution/unresolved-receivers.js';
import {
  loadParseCache,
  loadParseCacheChunk,
  PARSE_CACHE_VERSION,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../../src/storage/parse-cache.js';
import {
  clearParsedFileStore,
  durableChunkHasShards,
  getDurableParsedFileDir,
  loadDurableParsedFileIndex,
  loadParsedFilesForPaths,
  pruneAndSaveDurableParsedFileStore,
} from '../../../src/storage/parsedfile-store.js';
import { describeGrammarPresence, optionalGrammarGate } from '../../helpers/optional-grammar.js';
import { runPipelineFromRepo, writeFixtureRepo, type PipelineResult } from './helpers.js';

const zig = optionalGrammarGate(SupportedLanguages.Zig);
describeGrammarPresence(zig);

interface ExpectedCall {
  file: string;
  caller: string;
  targetFile: string;
  target: string;
}

describe('local-import graph targets across both persistent parse stores', () => {
  let tempDir: string;
  let repoDir: string;
  let storageDir: string;
  let marker: string;
  let worker: URL;
  let files: Record<string, string>;
  let expected: ExpectedCall[];
  const noOp = () => {};

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-local-import-persistence-'));
    repoDir = path.join(tempDir, 'repo');
    storageDir = path.join(tempDir, 'storage');
    marker = path.join(tempDir, 'worker.jsonl');
    const workerPath = path.join(tempDir, 'observed-worker.mjs');
    const actual = new URL('../../../dist/core/ingestion/workers/parse-worker.js', import.meta.url);
    expect(fs.existsSync(actual), 'build gitnexus before real-worker persistence tests').toBe(true);
    fs.writeFileSync(
      workerPath,
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
  if (message.type === 'result') record({ type: 'result', fileCount: message.data.fileCount });
  return send(message, ...rest);
};
await import(${JSON.stringify(actual.href)});
`,
    );
    worker = pathToFileURL(workerPath);
    expected = [];
    files = {
      'py/main.py': `from a import run
def allowed():
    from a import run
    return run()
def denied():
    run()
    from a import run
`,
      'py/a.py': 'def run(): return 1\n',
      'py/b.py': 'def run(): return 2\n',
      'py/accessors.py': `def lazy_module():
    import a as namespace
    return namespace
def direct_accessor():
    return lazy_module().run()
def assigned_accessor():
    module = lazy_module()
    return module.run()
`,
      'py/accessor_caller.py': `from accessors import lazy_module as imported_module
def imported_direct():
    return imported_module().run()
def imported_assigned():
    module = imported_module()
    return module.run()
`,
      'py/alternate_accessors.py': `def other_module():
    import b as namespace
    return namespace
`,
      'py/branch_modules.py': `from accessors import lazy_module
from alternate_accessors import other_module
def conditional_modules(flag):
    if flag:
        module = lazy_module()
    else:
        module = other_module()
    return module.run()
`,
      'py/branch_builtin.py': `from accessors import lazy_module
def conditional_builtin(flag):
    if flag:
        module = lazy_module()
    else:
        module = list()
    return module.run()
`,
      'py/sequential_accessors.py': `from accessors import lazy_module
from alternate_accessors import other_module
def sequential():
    module = lazy_module()
    module = other_module()
    return module.run()
`,
      'py/metadata.py': `from a import run
from fastapi import Depends
def dependency(): return 1
def handler(value=Depends(dependency)): return value
def redirected():
    global run
    from a import run
class Parent: pass
class Child(Parent):
    value = 1
def comprehension(values):
    return [value for value in values]
`,
      'metadata.ts': `class Parent {}
class Child extends Parent {}
function typed(value: Child): Parent { return value; }
const Named = class Hidden { method() { return Hidden; } };
`,
      'Cargo.toml':
        '[package]\nname = "local-import-persistence"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': `mod target;
pub fn allowed() { run(); use crate::target::run; }
pub fn denied() { use crate::missing::run; run(); }
`,
      'src/target.rs': 'pub fn run() {}\n',
      'cpp/main.cpp': `#include "target.hpp"
int allowed() { using target::run; return run(); }
int denied() { using missing::run; return run(); }
int before() { return run(); using target::run; }
int outside() { { using target::run; } return run(); }
`,
      'cpp/target.hpp': 'namespace target { int run() { return 1; } }\n',
    };
    expected.push(
      { file: 'py/main.py', caller: 'allowed', targetFile: 'py/a.py', target: 'run' },
      { file: 'src/lib.rs', caller: 'allowed', targetFile: 'src/target.rs', target: 'run' },
      { file: 'cpp/main.cpp', caller: 'allowed', targetFile: 'cpp/target.hpp', target: 'run' },
    );
    for (const [file, callers] of [
      ['py/accessors.py', ['direct_accessor', 'assigned_accessor']],
      ['py/accessor_caller.py', ['imported_direct', 'imported_assigned']],
    ] as const) {
      for (const caller of callers) {
        expected.push(
          { file, caller, targetFile: 'py/a.py', target: 'run' },
          { file, caller, targetFile: 'py/accessors.py', target: 'lazy_module' },
        );
      }
    }
    for (const [file, caller] of [
      ['py/branch_modules.py', 'conditional_modules'],
      ['py/branch_builtin.py', 'conditional_builtin'],
      ['py/sequential_accessors.py', 'sequential'],
    ] as const) {
      expected.push({ file, caller, targetFile: 'py/accessors.py', target: 'lazy_module' });
      if (file !== 'py/branch_builtin.py') {
        expected.push({
          file,
          caller,
          targetFile: 'py/alternate_accessors.py',
          target: 'other_module',
        });
      }
    }
    expected.push({
      file: 'py/sequential_accessors.py',
      caller: 'sequential',
      targetFile: 'py/b.py',
      target: 'run',
    });
    for (const extension of ['ts', 'tsx', 'js', 'jsx']) {
      const dir = extension;
      const targetExtension = extension.startsWith('ts') ? 'ts' : 'js';
      files[`${dir}/main.${extension}`] =
        `export function allowed() { const ns = require('./a'); return ns.run(); }
export function denied(require) { const ns = require('./a'); return ns.run(); }
`;
      files[`${dir}/a.${targetExtension}`] = 'export function run() { return 1; }\n';
      files[`${dir}/b.${targetExtension}`] = 'export function run() { return 2; }\n';
      expected.push({
        file: `${dir}/main.${extension}`,
        caller: 'allowed',
        targetFile: `${dir}/a.${targetExtension}`,
        target: 'run',
      });
    }
    for (const language of ['js', 'jsx', 'ts']) {
      const dir = `vue-${language}`;
      const targetExtension = language === 'ts' ? 'ts' : 'js';
      files[`${dir}/App.vue`] = `<template>\n<div />\n</template>\n<script lang="${language}">
function allowed() { const ns = require('./a'); return ns.run(); }
function denied(require) { const ns = require('./a'); return ns.run(); }
</script>`;
      files[`${dir}/a.${targetExtension}`] = 'export function run() { return 1; }\n';
      expected.push({
        file: `${dir}/App.vue`,
        caller: 'allowed',
        targetFile: `${dir}/a.${targetExtension}`,
        target: 'run',
      });
    }
    if (zig.available) {
      files['zig/main.zig'] = `pub fn allowed() void { const ns = @import("target.zig"); ns.run(); }
pub fn denied() void { ns.run(); const ns = @import("target.zig"); }
`;
      files['zig/target.zig'] = 'pub fn run() void {}\n';
      expected.push({
        file: 'zig/main.zig',
        caller: 'allowed',
        targetFile: 'zig/target.zig',
        target: 'run',
      });
    }
    writeFixtureRepo(repoDir, files);
  });

  afterAll(() => {
    if (tempDir)
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const run = (parseCache: ParseCache) =>
    runPipelineFromRepo(repoDir, noOp, {
      skipGraphPhases: true,
      workerPoolSize: 1,
      workerUrlForTest: worker,
      parseCache,
    });

  async function persist(cache: ParseCache): Promise<void> {
    pruneCache(cache, cache.usedKeys);
    const keys = await saveParseCache(storageDir, cache);
    await pruneAndSaveDurableParsedFileStore(
      getDurableParsedFileDir(storageDir),
      PARSE_CACHE_VERSION,
      new Set(keys),
    );
  }

  async function durableRecords(): Promise<Map<string, ParsedFile>> {
    await clearParsedFileStore(storageDir);
    const index = await loadDurableParsedFileIndex(
      getDurableParsedFileDir(storageDir),
      PARSE_CACHE_VERSION,
    );
    expect(index.size).toBeGreaterThan(0);
    const paths = new Set<string>();
    for (const [key, wanted] of index) {
      expect(await durableChunkHasShards(storageDir, key, wanted)).toBe(true);
      for (const filePath of wanted) paths.add(filePath);
    }
    // This is the same validated durable-to-run snapshot and reader used by
    // warm scope resolution, after the previous pipeline cleared its run store.
    const loaded = await loadParsedFilesForPaths(storageDir, paths);
    expect([...loaded.keys()].sort()).toEqual([...paths].sort());
    return loaded;
  }

  function graphEdges(result: PipelineResult): string[] {
    return [...result.graph.iterRelationships()]
      .filter((edge) => edge.type === 'CALLS' || edge.type === 'IMPORTS')
      .map((edge) => `${edge.type} ${edge.sourceId} -> ${edge.targetId}`)
      .sort();
  }

  function assertExactCalls(result: PipelineResult, wanted: ExpectedCall[]): void {
    const sourceFiles = new Set(expected.map((item) => item.file));
    const nodeId = (filePath: string, name: string) => {
      const nodes = [...result.graph.nodes.values()].filter(
        (node) =>
          node.properties.filePath === filePath &&
          node.properties.name === name &&
          (node.label === 'Function' || node.label === 'Method'),
      );
      expect(nodes, `one callable ${filePath}:${name}`).toHaveLength(1);
      return nodes[0]!.id;
    };
    const calls = [...result.graph.iterRelationships()].filter(
      (edge) =>
        edge.type === 'CALLS' &&
        sourceFiles.has(result.graph.getNode(edge.sourceId)?.properties.filePath ?? ''),
    );
    expect(calls.map((edge) => `${edge.sourceId} -> ${edge.targetId}`).sort()).toEqual(
      wanted
        .map(
          (item) => `${nodeId(item.file, item.caller)} -> ${nodeId(item.targetFile, item.target)}`,
        )
        .sort(),
    );
    // The exact set rejects both sibling-target leakage and every denied call.
    for (const filePath of ['py/branch_modules.py', 'py/branch_builtin.py']) {
      expect(
        summarizeUnresolvedReceivers(
          result.resolutionOutcomes.filter((outcome) => outcome.filePath === filePath),
        ),
        `one in-program/unknown branch call for ${filePath}`,
      ).toEqual({ counts: { run: 1 }, totalSites: 1 });
    }
    expect(
      summarizeUnresolvedReceivers(
        result.resolutionOutcomes.filter(
          (outcome) => outcome.filePath === 'py/sequential_accessors.py',
        ),
      ),
    ).toBeUndefined();
  }

  it('reuses genuine cold output, retains exact targets, and invalidates changed ownership', async () => {
    const parsedPaths = Object.keys(files).filter(
      (filePath) => getProviderForFile(filePath) !== null,
    );
    const extract = vi.spyOn(scopeBridge, 'extractParsedFile');
    try {
      const coldCache = await loadParseCache(storageDir);
      const cold = await run(coldCache);
      expect(cold.usedWorkerPool).toBe(true);
      expect(cold.reparsedFileCount).toBe(parsedPaths.length);
      expect(cold.parseCacheHitFileCount).toBe(0);
      expect(extract).not.toHaveBeenCalled();
      const observed = fs
        .readFileSync(marker, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; files?: string[]; fileCount?: number });
      expect(observed.some((entry) => entry.type === 'boot')).toBe(true);
      expect(observed.flatMap((entry) => entry.files ?? []).sort()).toEqual(parsedPaths.sort());
      expect(
        observed
          .filter((entry) => entry.type === 'result')
          .reduce((sum, entry) => sum + (entry.fileCount ?? 0), 0),
      ).toBe(parsedPaths.length);
      assertExactCalls(cold, expected);
      await persist(coldCache);
      const coldRecords = await durableRecords();
      expect([...coldRecords.keys()].sort()).toEqual(parsedPaths.sort());
      expect(coldRecords.get('cpp/main.cpp')!.captureSideChannel).toEqual(
        expect.objectContaining({
          usingDeclarations: expect.arrayContaining([expect.any(Object)]),
        }),
      );
      expect(coldRecords.get('py/accessors.py')!.captureSideChannel).toEqual(
        expect.objectContaining({
          kind: 'python-capture',
          moduleAccessors: expect.arrayContaining([
            expect.objectContaining({ status: 'accepted', returnedName: 'namespace' }),
            expect.objectContaining({ status: 'declined' }),
          ]),
          subtypeDispatch: expect.objectContaining({
            kind: 'python-subtype-dispatch',
            simplePositionalCalls: expect.arrayContaining([expect.any(Array)]),
          }),
        }),
      );
      for (const filePath of ['py/accessors.py', 'py/accessor_caller.py']) {
        expect(coldRecords.get(filePath)!.callResultAssignmentSites).toEqual([
          expect.objectContaining({ lhs: 'module', callSite: expect.any(Object) }),
        ]);
      }
      for (const [filePath, straightLine] of [
        ['py/branch_modules.py', false],
        ['py/branch_builtin.py', false],
        ['py/sequential_accessors.py', true],
      ] as const) {
        const parsed = coldRecords.get(filePath)!;
        const assignments = parsed.callResultAssignmentSites ?? [];
        expect(assignments).toHaveLength(2);
        expect(parsed.captureSideChannel).toEqual(
          expect.objectContaining({
            kind: 'python-capture',
            callResultAssignments: assignments.map((assignment) => ({
              callLine: assignment.callSite.startLine,
              callColumn: assignment.callSite.startCol,
              straightLine,
            })),
          }),
        );
      }
      expect(
        coldRecords
          .get('py/main.py')!
          .scopes.some((scope) =>
            scope.nameClaims?.some(
              (claim) =>
                claim.name === 'run' &&
                claim.kind === 'import' &&
                claim.availableFrom !== undefined,
            ),
          ),
      ).toBe(true);
      expect(
        coldRecords.get('vue-ts/App.vue')!.localDefs.some((def) => def.graphPosition !== undefined),
      ).toBe(true);
      const scopes = [...coldRecords.values()].flatMap((file) => file.scopes);
      const claims = scopes.flatMap((scope) => scope.nameClaims ?? []);
      for (const key of [
        'name',
        'range',
        'kind',
        'purpose',
        'availableFrom',
        'inactive',
        'redirect',
        'hoisted',
        'merge',
      ] as const) {
        expect(
          claims.some((claim) => claim[key] !== undefined),
          `durable NameClaim.${key}`,
        ).toBe(true);
      }
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
          `durable Scope.lookupPolicy.${key}`,
        ).toBe(true);
      }
      const types = scopes.flatMap((scope) => [...scope.typeBindings.values()]);
      for (const key of ['lookupPosition', 'lookupPurpose', 'bindingRange'] as const) {
        expect(
          types.some((type) => type[key] !== undefined),
          `durable TypeRef.${key}`,
        ).toBe(true);
      }
      expect(
        scopes
          .flatMap((scope) => [...scope.bindings.values()].flat())
          .some((binding) => binding.declarationRange !== undefined),
      ).toBe(true);
      const imports = [...coldRecords.values()].flatMap((file) => file.parsedImports);
      for (const key of ['atRange', 'declaredAtScope', 'bindsAtLexicalScope'] as const) {
        expect(
          imports.some((imp) => imp[key] !== undefined),
          `durable ParsedImport.${key}`,
        ).toBe(true);
      }
      const references = [...coldRecords.values()].flatMap((file) => file.referenceSites);
      expect(references.some((site) => site.lookupPurpose !== undefined)).toBe(true);
      expect(references.some((site) => site.lookupScope !== undefined)).toBe(true);
      const dependency = coldRecords
        .get('py/metadata.py')!
        .referenceSites.find(
          (site) =>
            site.kind === 'call' && site.name === 'dependency' && site.callerScope !== undefined,
        );
      expect(dependency).toBeDefined();
      expect(dependency!.inScope).toBe(coldRecords.get('py/metadata.py')!.moduleScope);
      expect(dependency!.callerScope).not.toBe(dependency!.inScope);
      expect(
        coldRecords
          .get('py/metadata.py')!
          .scopes.find((scope) => scope.id === dependency!.callerScope)?.kind,
      ).toBe('Function');

      const warmCache = await loadParseCache(storageDir);
      expect(warmCache.entries.size).toBe(0);
      expect(warmCache.onDiskKeys!.size).toBeGreaterThan(0);
      let persistedFileCount = 0;
      for (const key of warmCache.onDiskKeys!) {
        const chunk = await loadParseCacheChunk(warmCache, key);
        expect(chunk).toBeDefined();
        persistedFileCount += chunk!.reduce((sum, part) => sum + part.fileCount, 0);
        expect(chunk!.flatMap((part) => part.parsedFiles ?? [])).toEqual([]);
      }
      expect(persistedFileCount).toBe(parsedPaths.length);
      fs.rmSync(marker);
      const warm = await run(warmCache);
      expect(warm.usedWorkerPool).toBe(false);
      expect(warm.reparsedFileCount).toBe(0);
      expect(warm.parseCacheHitFileCount).toBe(parsedPaths.length);
      expect(fs.existsSync(marker)).toBe(false);
      expect(extract).not.toHaveBeenCalled();
      assertExactCalls(warm, expected);
      expect(graphEdges(warm)).toEqual(graphEdges(cold));
      await persist(warmCache);
      expect(await durableRecords()).toEqual(coldRecords);

      // Change the accessor's returned module while its importing caller is unchanged.
      // Also change one local target and one loader that ceases to be an import.
      writeFixtureRepo(repoDir, {
        'ts/main.ts': files['ts/main.ts']!.replace("require('./a')", "require('./b')"),
        'js/main.js': files['js/main.js']!.replace('allowed()', 'allowed(require)'),
        'py/accessors.py': files['py/accessors.py']!.replace(
          'import a as namespace',
          'import b as namespace',
        ),
        'py/alternate_accessors.py': files['py/alternate_accessors.py']!.replace(
          'import b as namespace',
          'import a as namespace',
        ),
      });
      const editedCache = await loadParseCache(storageDir);
      const edited = await run(editedCache);
      expect(edited.usedWorkerPool).toBe(true);
      expect(edited.reparsedFileCount).toBeGreaterThanOrEqual(4);
      expect(edited.parseCacheHitFileCount).toBeGreaterThan(0);
      expect(edited.reparsedFileCount! + edited.parseCacheHitFileCount!).toBe(parsedPaths.length);
      expect(fs.existsSync(marker)).toBe(true);
      expect(extract).not.toHaveBeenCalled();
      const changedExpected = expected
        .filter((item) => item.file !== 'js/main.js')
        .map((item) => {
          if (item.file === 'ts/main.ts') return { ...item, targetFile: 'ts/b.ts' };
          if (item.file === 'py/sequential_accessors.py' && item.target === 'run') {
            return { ...item, targetFile: 'py/a.py' };
          }
          if (
            (item.file === 'py/accessors.py' || item.file === 'py/accessor_caller.py') &&
            item.target === 'run'
          ) {
            return { ...item, targetFile: 'py/b.py' };
          }
          return item;
        });
      assertExactCalls(edited, changedExpected);
      expect(graphEdges(edited)).not.toEqual(graphEdges(cold));
      await persist(editedCache);
      const editedRecords = await durableRecords();
      expect(editedRecords.get('js/main.js')!.parsedImports).toEqual([]);
      expect(editedRecords.get('ts/main.ts')!.parsedImports.map((imp) => imp.targetRaw)).toEqual([
        './b',
      ]);
      expect(editedRecords.get('py/main.py')).toEqual(coldRecords.get('py/main.py'));
      expect(
        editedRecords.get('py/accessors.py')!.parsedImports.map((imp) => imp.targetRaw),
      ).toEqual(['b']);
      expect(editedRecords.get('py/accessor_caller.py')).toEqual(
        coldRecords.get('py/accessor_caller.py'),
      );
      expect(fs.readFileSync(path.join(repoDir, 'py/accessor_caller.py'), 'utf8')).toBe(
        files['py/accessor_caller.py'],
      );
      for (const filePath of [
        'py/branch_modules.py',
        'py/branch_builtin.py',
        'py/sequential_accessors.py',
      ]) {
        expect(editedRecords.get(filePath)).toEqual(coldRecords.get(filePath));
        expect(fs.readFileSync(path.join(repoDir, filePath), 'utf8')).toBe(files[filePath]);
      }

      fs.rmSync(marker);
      const editedWarm = await run(await loadParseCache(storageDir));
      expect(editedWarm.usedWorkerPool).toBe(false);
      expect(editedWarm.reparsedFileCount).toBe(0);
      expect(editedWarm.parseCacheHitFileCount).toBe(parsedPaths.length);
      expect(fs.existsSync(marker)).toBe(false);
      expect(extract).not.toHaveBeenCalled();
      assertExactCalls(editedWarm, changedExpected);
      expect(graphEdges(editedWarm)).toEqual(graphEdges(edited));

      // Both stores reject the pre-accessor schema. run() constructs a fresh
      // graph, proving the full-rebuild upgrade path with unchanged sources;
      // cache invalidation alone is not evidence of persisted graph-row updates.
      const previousVersion = PARSE_CACHE_VERSION.replace(/^\d+\+/, '136+');
      expect(previousVersion).not.toBe(PARSE_CACHE_VERSION);
      for (const indexPath of [
        path.join(storageDir, 'parse-cache', 'index.json'),
        path.join(getDurableParsedFileDir(storageDir), 'index.json'),
      ]) {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        fs.writeFileSync(indexPath, JSON.stringify({ ...index, version: previousVersion }));
      }
      await clearParsedFileStore(storageDir);
      expect(
        await loadDurableParsedFileIndex(getDurableParsedFileDir(storageDir), PARSE_CACHE_VERSION),
      ).toEqual(new Map());
      const upgradedCache = await loadParseCache(storageDir);
      expect(upgradedCache.entries.size).toBe(0);
      expect(upgradedCache.onDiskKeys?.size ?? 0).toBe(0);
      const rebuilt = await run(upgradedCache);
      expect(rebuilt.usedWorkerPool).toBe(true);
      expect(rebuilt.reparsedFileCount).toBe(parsedPaths.length);
      expect(rebuilt.parseCacheHitFileCount).toBe(0);
      expect(extract).not.toHaveBeenCalled();
      assertExactCalls(rebuilt, changedExpected);
      expect(graphEdges(rebuilt)).toEqual(graphEdges(edited));
      await persist(upgradedCache);
      expect(await durableRecords()).toEqual(editedRecords);
    } finally {
      extract.mockRestore();
    }
  }, 180_000);
});
