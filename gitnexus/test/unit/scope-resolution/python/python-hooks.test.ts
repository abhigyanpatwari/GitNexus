/**
 * Per-hook unit tests for the Python scope-resolution provider hooks
 * (RFC #909 Ring 3).
 *
 * Pairs with `python-fixtures.test.ts` (end-to-end fixtures via
 * `extractParsedFile`). These tests target each hook in isolation —
 * fast, table-driven, no tree-sitter parsing.
 */

import { describe, it, expect } from 'vitest';
import type {
  BindingRef,
  Callsite,
  ParsedImport,
  Scope,
  ScopeId,
  SymbolDefinition,
  TypeRef,
  WorkspaceIndex,
} from 'gitnexus-shared';
import {
  pythonArityCompatibility,
  pythonImportOwningScope,
  pythonMergeBindings,
  pythonReceiverBinding,
  pythonBindingScopeFor,
  resolvePythonImportTarget,
} from '../../../../src/core/ingestion/languages/python/index.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const fnScope = (
  typeBindings: Record<string, TypeRef> = {},
  kind: Scope['kind'] = 'Function',
): Scope => ({
  id: 'scope:t.py#1:0-10:0:Function' as ScopeId,
  parent: null,
  kind,
  range: { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
  filePath: 't.py',
  bindings: new Map(),
  ownedDefs: [],
  imports: [],
  typeBindings: new Map(Object.entries(typeBindings)),
});

const def = (overrides: Partial<SymbolDefinition> = {}): SymbolDefinition => ({
  nodeId: 'def:1',
  filePath: 't.py',
  type: 'Function',
  ...overrides,
});

const binding = (origin: BindingRef['origin'], nodeId = 'd1'): BindingRef => ({
  def: def({ nodeId }),
  origin,
});

// ─── arityCompatibility ────────────────────────────────────────────────────

describe('pythonArityCompatibility', () => {
  const callsite = (arity: number): Callsite => ({ arity });

  it('returns "unknown" when both parameter counts are missing', () => {
    expect(pythonArityCompatibility(def(), callsite(2))).toBe('unknown');
  });

  it('compatible when argCount sits inside [required, total]', () => {
    expect(
      pythonArityCompatibility(def({ parameterCount: 3, requiredParameterCount: 1 }), callsite(2)),
    ).toBe('compatible');
  });

  it('compatible at the lower bound', () => {
    expect(
      pythonArityCompatibility(def({ parameterCount: 3, requiredParameterCount: 1 }), callsite(1)),
    ).toBe('compatible');
  });

  it('incompatible when argCount is below required', () => {
    expect(
      pythonArityCompatibility(def({ parameterCount: 3, requiredParameterCount: 2 }), callsite(1)),
    ).toBe('incompatible');
  });

  it('incompatible when argCount exceeds total and no varargs are declared', () => {
    expect(
      pythonArityCompatibility(def({ parameterCount: 2, requiredParameterCount: 0 }), callsite(5)),
    ).toBe('incompatible');
  });

  it('compatible when argCount exceeds total but def takes *args', () => {
    expect(
      pythonArityCompatibility(
        def({ parameterCount: 2, requiredParameterCount: 0, parameterTypes: ['int', '*args'] }),
        callsite(7),
      ),
    ).toBe('compatible');
  });

  it('compatible when argCount exceeds total but def takes **kwargs', () => {
    expect(
      pythonArityCompatibility(
        def({ parameterCount: 1, requiredParameterCount: 0, parameterTypes: ['**kwargs'] }),
        callsite(3),
      ),
    ).toBe('compatible');
  });

  it('"unknown" for negative or non-finite arities (defensive)', () => {
    expect(
      pythonArityCompatibility(def({ parameterCount: 3, requiredParameterCount: 1 }), callsite(-1)),
    ).toBe('unknown');
  });
});

// ─── receiverBinding ───────────────────────────────────────────────────────

describe('pythonReceiverBinding', () => {
  const userType: TypeRef = {
    rawName: 'User',
    declaredAtScope: 'scope:fake' as ScopeId,
    source: 'self',
  };

  it('returns the `self` binding when present', () => {
    expect(pythonReceiverBinding(fnScope({ self: userType }))).toEqual(userType);
  });

  it('falls back to `cls` when `self` is absent', () => {
    expect(pythonReceiverBinding(fnScope({ cls: userType }))).toEqual(userType);
  });

  it('returns null for free functions (no `self`/`cls`)', () => {
    expect(pythonReceiverBinding(fnScope({}))).toBeNull();
  });

  it('returns null for non-Function scopes (Class / Module)', () => {
    expect(pythonReceiverBinding(fnScope({ self: userType }, 'Class'))).toBeNull();
    expect(pythonReceiverBinding(fnScope({ self: userType }, 'Module'))).toBeNull();
  });
});

// ─── mergeBindings ─────────────────────────────────────────────────────────

describe('pythonMergeBindings — LEGB precedence', () => {
  it('local shadows imported', () => {
    const local = binding('local', 'L');
    const imp = binding('import', 'I');
    expect(pythonMergeBindings([imp, local])).toEqual([local]);
  });

  it('explicit import shadows wildcard', () => {
    const imp = binding('import', 'I');
    const wc = binding('wildcard', 'W');
    expect(pythonMergeBindings([wc, imp])).toEqual([imp]);
  });

  it('local shadows BOTH imported and wildcard', () => {
    const local = binding('local', 'L');
    const imp = binding('import', 'I');
    const wc = binding('wildcard', 'W');
    expect(pythonMergeBindings([wc, imp, local])).toEqual([local]);
  });

  it('keeps multiple bindings within the same tier (overload-like)', () => {
    const a = binding('local', 'A');
    const b = binding('local', 'B');
    expect(pythonMergeBindings([a, b])).toEqual([a, b]);
  });

  it('dedupes by DefId — same nodeId collapses', () => {
    const a = binding('local', 'A');
    const a2 = binding('local', 'A');
    expect(pythonMergeBindings([a, a2])).toHaveLength(1);
  });

  it('returns empty when given empty', () => {
    expect(pythonMergeBindings([])).toEqual([]);
  });

  it('namespace and reexport tie with explicit import (same tier)', () => {
    const ns = binding('namespace', 'N');
    const re = binding('reexport', 'R');
    const imp = binding('import', 'I');
    expect(pythonMergeBindings([ns, re, imp])).toHaveLength(3);
  });
});

// ─── importOwningScope ─────────────────────────────────────────────────────

describe('pythonImportOwningScope', () => {
  const named: ParsedImport = {
    kind: 'named',
    localName: 'X',
    importedName: 'X',
    targetRaw: 'm',
  };

  it('attaches function-local imports to the function scope', () => {
    const fn = fnScope({}, 'Function');
    expect(pythonImportOwningScope(named, fn, {} as never)).toBe(fn.id);
  });

  it('attaches class-body imports to the class scope', () => {
    const cls = fnScope({}, 'Class');
    expect(pythonImportOwningScope(named, cls, {} as never)).toBe(cls.id);
  });

  it('returns null (delegate to default) for module-level imports', () => {
    const mod = fnScope({}, 'Module');
    expect(pythonImportOwningScope(named, mod, {} as never)).toBeNull();
  });
});

// ─── bindingScopeFor — defensive ──────────────────────────────────────────

describe('pythonBindingScopeFor', () => {
  it('delegates to default for every input', () => {
    expect(pythonBindingScopeFor({}, fnScope(), {} as never)).toBeNull();
  });
});

// ─── resolveImportTarget ──────────────────────────────────────────────────

describe('resolvePythonImportTarget', () => {
  const ws = (fromFile: string, files: string[]): WorkspaceIndex =>
    ({ fromFile, allFilePaths: new Set(files) }) as unknown as WorkspaceIndex;

  it('resolves a relative import via PEP-328 to a concrete file', () => {
    const imp: ParsedImport = {
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: '.models',
    };
    const result = resolvePythonImportTarget(
      imp,
      ws('app/main.py', ['app/main.py', 'app/models.py']),
    );
    expect(result).toBe('app/models.py');
  });

  it('returns null for dynamic-unresolved imports', () => {
    const imp: ParsedImport = {
      kind: 'dynamic-unresolved',
      localName: '',
      targetRaw: 'mystery',
    };
    expect(resolvePythonImportTarget(imp, ws('a.py', ['a.py']))).toBeNull();
  });

  it('returns null when the workspace context is malformed', () => {
    const imp: ParsedImport = {
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: 'm',
    };
    expect(resolvePythonImportTarget(imp, undefined)).toBeNull();
    expect(resolvePythonImportTarget(imp, {} as never)).toBeNull();
  });

  it('returns null when targetRaw is empty/null', () => {
    const imp: ParsedImport = {
      kind: 'wildcard',
      targetRaw: '',
    };
    expect(resolvePythonImportTarget(imp, ws('a.py', ['a.py']))).toBeNull();
  });
});
