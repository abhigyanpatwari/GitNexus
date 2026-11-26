import { beforeAll, describe, expect, it } from 'vitest';
import { finalize, SupportedLanguages, type ParsedFile } from 'gitnexus-shared';
import { getProviderForFile } from '../../src/core/ingestion/languages/index.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { describeGrammarPresence, optionalGrammarGate } from '../helpers/optional-grammar.js';

import {
  assertPlainFacts,
  assertWorkerDispatch,
  loaderSource,
  runWorkerParity,
} from '../helpers/worker-parity.js';
const zig = optionalGrammarGate(SupportedLanguages.Zig);
describeGrammarPresence(zig);

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
  'accessor.py': `def lazy_module():
    import target as namespace
    return namespace
def direct_accessor():
    return lazy_module().run()
def assigned_accessor():
    module = lazy_module()
    return module.run()
class Receiver:
    def run(self): return 1
`,
  'accessor_caller.py': `from accessor import lazy_module as imported_module
def imported_direct():
    return imported_module().run()
def imported_assigned():
    module = imported_module()
    return module.run()
`,
  'assignment_branches.py': `from accessor import lazy_module as first
from other import lazy_module as second
def conditional_module(flag):
    if flag:
        module = first()
    else:
        module = second()
    return module.run()
def conditional_builtin(flag):
    if flag:
        module = first()
    else:
        module = list()
    return module.run()
def sequential():
    module = first()
    module = second()
    return module.run()
`,
  'javascript.js': loaderSource,
  'javascript.jsx': `${loaderSource}\nconst element = <Child />;`,
  'vue-js.vue': `<template>\n<div />\n</template>\n<script lang="js">\n${loaderSource}\n</script>`,
  'vue-jsx.vue': `<template>\n<div />\n</template>\n<script lang="jsx">\n${loaderSource}\nconst element = <Child />;\n</script>`,
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

describe('local-import facts across the real parse worker', () => {
  let run: Awaited<ReturnType<typeof runWorkerParity>>;
  let workerFiles: typeof run.workerFiles;
  let directFiles: typeof run.directFiles;
  beforeAll(async () => {
    run = await runWorkerParity(fixtures);
    ({ workerFiles, directFiles } = run);
  }, 120_000);

  it('witnesses actual worker dispatch and returned ParsedFiles without a fallback', () => {
    assertWorkerDispatch(run, fixtures);
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

  it('transports accessor proofs and exact assigned calls alongside subtype-dispatch facts', () => {
    const accessor = workerFiles.get('accessor.py')!;
    expect(accessor.captureSideChannel).toEqual(
      expect.objectContaining({
        kind: 'python-capture',
        moduleAccessors: expect.arrayContaining([
          {
            definitionLine: 1,
            definitionColumn: 0,
            status: 'accepted',
            returnedName: 'namespace',
            returnLine: 3,
            returnColumn: 11,
          },
          expect.objectContaining({ status: 'declined' }),
        ]),
        subtypeDispatch: expect.objectContaining({
          kind: 'python-subtype-dispatch',
          simplePositionalCalls: expect.arrayContaining([expect.any(Array)]),
          positionalCapacities: expect.arrayContaining([expect.any(Array)]),
        }),
      }),
    );
    for (const [filePath, callee, assignmentLine] of [
      ['accessor.py', 'lazy_module', 7],
      ['accessor_caller.py', 'imported_module', 5],
    ] as const) {
      const parsed = workerFiles.get(filePath)!;
      const assignments = parsed.callResultAssignmentSites ?? [];
      expect(assignments).toHaveLength(1);
      const assignment = assignments[0]!;
      expect(assignment.lhs).toBe('module');
      expect(assignment.callSite.startLine).toBe(assignmentLine);
      expect(parsed.captureSideChannel).toEqual(
        expect.objectContaining({
          callResultAssignments: [
            {
              callLine: assignment.callSite.startLine,
              callColumn: assignment.callSite.startCol,
              straightLine: true,
            },
          ],
        }),
      );
      expect(parsed.referenceSites).toContainEqual(
        expect.objectContaining({
          kind: 'call',
          name: callee,
          inScope: assignment.inScope,
          atRange: assignment.callSite,
        }),
      );
    }
  });

  it('preserves branch provenance without dropping generic call-result assignments', () => {
    const parsed = workerFiles.get('assignment_branches.py')!;
    const assignments = parsed.callResultAssignmentSites ?? [];
    expect(assignments.map((assignment) => assignment.callSite.startLine)).toEqual([
      5, 7, 11, 13, 16, 17,
    ]);
    expect(assignments.every((assignment) => assignment.lhs === 'module')).toBe(true);
    expect(parsed.captureSideChannel).toEqual(
      expect.objectContaining({
        kind: 'python-capture',
        callResultAssignments: assignments.map((assignment, index) => ({
          callLine: assignment.callSite.startLine,
          callColumn: assignment.callSite.startCol,
          straightLine: index >= 4,
        })),
      }),
    );
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
    expect(workerFiles.get('cpp.cpp')!.captureSideChannel).toEqual(
      expect.objectContaining({
        usingDeclarations: expect.arrayContaining([expect.any(Object)]),
      }),
    );
  });
});
