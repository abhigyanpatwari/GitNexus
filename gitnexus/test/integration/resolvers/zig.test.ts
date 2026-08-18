/**
 * Zig: container types, methods, calls, and @import resolution.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  edgeSet,
  FIXTURES,
  getNodesByLabel,
  getNodesByLabelFull,
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

// `@tree-sitter-grammars/tree-sitter-zig` is an optionalDependency: on a
// platform without a prebuild the grammar is absent and the pipeline skips
// `.zig` files by contract, so these suites skip too (Swift/Dart pattern).
const zigAvailable = isLanguageAvailable(SupportedLanguages.Zig);

describe.skipIf(!zigAvailable)('Zig basic resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-basic'), () => {});
  }, 60000);

  it('detects the Pioneer struct and State enum', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('Pioneer');
    expect(getNodesByLabel(result, 'Enum')).toContain('State');
  });

  it('labels `union(enum)` declarations as Union (not Class)', () => {
    expect(getNodesByLabel(result, 'Union')).toContain('Tag');
    // Negative-side check: Tag must NOT also appear under Class.
    expect(getNodesByLabel(result, 'Class')).not.toContain('Tag');
  });

  it('extracts top-level functions from main.zig', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('main');
    expect(fns).toContain('helper');
  });

  it('extracts struct methods (tick, reset) as Methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('tick');
    expect(methods).toContain('reset');
  });

  it('extracts union(enum) methods as Methods (Union is class-like)', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('isEnergy');
  });

  it('dispatches method calls on a union receiver (main → isEnergy)', () => {
    // Pins the `isClassLike('Union')` widening in scope/walkers.ts: without
    // it `populateClassOwnedMembers` finds no class-like def in the Tag
    // scope, the method gets no ownerId, and dispatch silently drops.
    expect(edgeSet(getRelationships(result, 'CALLS'))).toContain('main → isEnergy');
  });

  it('resolves the relative @import("./pioneer.zig") to pioneer.zig', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const internal = imports.filter((e) => e.targetFilePath.endsWith('pioneer.zig'));
    expect(internal.length).toBeGreaterThan(0);
    expect(internal[0].sourceFilePath).toContain('main.zig');
  });

  it('emits a CALLS edge for the free call main → helper', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(edgeSet(calls)).toContain('main → helper');
  });

  it('emits a CALLS edge for the receiver-bound method call main → tick', () => {
    const calls = getRelationships(result, 'CALLS');
    // `var p = pioneer.Pioneer{…}; p.tick()` — constructor-inferred receiver
    // type through the namespace import, dispatched onto Pioneer.tick.
    expect(edgeSet(calls)).toContain('main → tick');
  });
});

describe.skipIf(!zigAvailable)('Zig scope captures — variable bindings', () => {
  it('binds only the declared name, never the initializer identifier', async () => {
    // `(variable_declaration (identifier) @declaration.name)` without a
    // first-child anchor ALSO matches the RHS identifier of `const h = helper;`
    // and mints a phantom local named `helper` in the enclosing block. That
    // phantom shadows the real function for every later reference in the
    // block, so `helper()` below silently lost its CALLS edge — and the
    // callable-value-flow seed for `h` had nothing to resolve against.
    const { emitZigScopeCaptures } =
      await import('../../../src/core/ingestion/languages/zig/captures.js');
    const source = [
      'fn helper() void {}',
      'pub fn main() void {',
      '    const h = helper;',
      '    helper();',
      '}',
      '',
    ].join('\n');
    const variableNames = emitZigScopeCaptures(source, 'main.zig')
      .filter((m) => m['@declaration.variable'] !== undefined)
      .map((m) => m['@declaration.name']?.text);
    expect(variableNames).toEqual(['h']);
  });
});

describe.skipIf(!zigAvailable)('Zig export, opaque and test declarations (ffi.zig)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-basic'), () => {});
  }, 60000);

  it('marks `export fn` (C-ABI, no `pub`) as exported', () => {
    // `export` is the strongest visibility Zig has — FFI entry points are
    // declared this way and never carry `pub`. A `pub`-only checker left
    // every C-ABI symbol private in the graph.
    const cAdd = getNodesByLabelFull(result, 'Function').find((n) => n.name === 'c_add');
    expect(cAdd).toBeDefined();
    expect(cAdd!.properties.isExported).toBe(true);
  });

  it('models `opaque {}` as a Struct that owns its methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('Handle');
    expect(getNodesByLabel(result, 'Method')).toContain('close');
    expect(edgeSet(getRelationships(result, 'HAS_METHOD'))).toContain('Handle → close');
  });

  it('owns container members through the binding name (HAS_METHOD / HAS_PROPERTY)', () => {
    // tree-sitter-zig containers are anonymous; the owner walk used to climb
    // past them and NO Zig member ever got an owner edge, so `context(Pioneer)`
    // listed no methods and the struct's fields dangled off the File.
    expect(edgeSet(getRelationships(result, 'HAS_METHOD'))).toEqual(
      expect.arrayContaining(['Pioneer → tick', 'Pioneer → reset', 'Tag → isEnergy']),
    );
    expect(edgeSet(getRelationships(result, 'HAS_PROPERTY'))).toEqual(
      expect.arrayContaining(['Pioneer → energy', 'State → idle', 'Tag → energy']),
    );
  });

  it('dispatches a method call on an opaque receiver (release → close)', () => {
    expect(edgeSet(getRelationships(result, 'CALLS'))).toContain('release → close');
  });

  it('never mints a nameless Property for an empty container body', () => {
    // tree-sitter-zig 1.1.2 recovers `struct {}` / `opaque {}` as one
    // container_field with a zero-width MISSING identifier.
    expect(getNodesByLabel(result, 'Struct')).toContain('Empty');
    expect(getNodesByLabel(result, 'Property')).not.toContain('');
  });

  it('captures named tests as Functions, quoted, so `test "release"` and `fn release` stay distinct nodes', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('"c_add adds"');
    expect(fns).toContain('"release"');
    // Both must exist as separate nodes — an unquoted test name would have
    // merged onto Function:<file>:release and fabricated a self-call.
    expect(fns.filter((n) => n === 'release')).toHaveLength(1);
    expect(fns.filter((n) => n === '"release"')).toHaveLength(1);
  });

  it('attributes calls inside a named test to the test node, not the file', () => {
    const calls = edgeSet(getRelationships(result, 'CALLS'));
    expect(calls).toContain('"c_add adds" → c_add');
    expect(calls).toContain('"release" → release');
    expect(calls).not.toContain('release → release');
  });

  it('does not create a graph node for an anonymous `test {}`', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns.some((n) => n.startsWith('test@') || n === 'test')).toBe(false);
  });
});
