/**
 * End-to-end fixture tests for the Python scope-resolution migration
 * (RFC #909 Ring 3, RFC §5.1 — first-rollout language).
 *
 * Each fixture:
 *   1. Drives `extractPythonScopeCaptures` on a real Python source string.
 *   2. Threads the captures through the central `ScopeExtractor` (via
 *      `extractParsedFile`) — exactly the path `parse-worker.ts`
 *      executes at ingest time.
 *   3. Asserts on the resulting `ParsedFile` (scopes / declarations /
 *      imports / type bindings / reference sites).
 *
 * Coverage matrix (≥30 cases, per Ring 3 deliverables):
 *
 *   * Module / function / class scope construction
 *   * No-block-scope semantics (if / for / while / with / try)
 *   * Class- and function-local declarations + variables
 *   * Imports: plain, aliased, multi-target, from, from-as, multi-from,
 *     wildcard, dotted-relative
 *   * Function-local imports
 *   * Receiver type binding: `self` for instance methods, `cls` for
 *     classmethods; no binding for `@staticmethod`; no binding for free
 *     functions
 *   * Parameter type annotations (typed_parameter / typed_default_parameter
 *     / forward-ref strings)
 *   * Call references: free vs member, with explicit-receiver capture
 *   * `global` / `nonlocal` no-op behaviour (documented gap)
 */

import { describe, it, expect } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { pythonProvider } from '../../../../src/core/ingestion/languages/python.js';

// ─── Test helper ───────────────────────────────────────────────────────────

function parse(src: string, filePath = 'test.py'): ParsedFile {
  const result = extractParsedFile(pythonProvider, src, filePath);
  if (result === undefined) {
    throw new Error(
      `extractParsedFile returned undefined for:\n${src}\n— check warnings or capture shape`,
    );
  }
  return result;
}

function scopesByKind(file: ParsedFile, kind: string) {
  return file.scopes.filter((s) => s.kind === kind);
}

function findDef(file: ParsedFile, name: string) {
  return file.localDefs.find((d) => d.qualifiedName === name);
}

// ─── Pass 1: scope tree ────────────────────────────────────────────────────

describe('Python scopes — module / class / function', () => {
  it('case 01: minimal module produces a single Module scope', () => {
    // Empty source produces a zero-range module node; the central
    // extractor treats zero-range scopes as malformed (and rightly so —
    // they collide with sibling-overlap detection on subsequent reparses).
    // Real Python files always have at least a newline.
    const f = parse('pass\n');
    expect(f.scopes).toHaveLength(1);
    expect(f.scopes[0]!.kind).toBe('Module');
  });

  it('case 02: module-level assignment produces a Variable declaration in Module scope', () => {
    const f = parse('x = 1\n');
    expect(scopesByKind(f, 'Module')).toHaveLength(1);
    expect(findDef(f, 'x')?.type).toBe('Variable');
  });

  it('case 03: top-level def produces a Function scope under Module', () => {
    const f = parse('def foo():\n    pass\n');
    const fn = scopesByKind(f, 'Function')[0]!;
    const mod = scopesByKind(f, 'Module')[0]!;
    expect(fn.parent).toBe(mod.id);
    expect(findDef(f, 'foo')?.type).toBe('Function');
  });

  it('case 04: top-level class produces a Class scope under Module', () => {
    const f = parse('class A:\n    pass\n');
    const cls = scopesByKind(f, 'Class')[0]!;
    const mod = scopesByKind(f, 'Module')[0]!;
    expect(cls.parent).toBe(mod.id);
    expect(findDef(f, 'A')?.type).toBe('Class');
  });

  it('case 05: method nests Function under Class under Module', () => {
    const f = parse('class A:\n    def m(self):\n        pass\n');
    const mod = scopesByKind(f, 'Module')[0]!;
    const cls = scopesByKind(f, 'Class')[0]!;
    const fn = scopesByKind(f, 'Function')[0]!;
    expect(cls.parent).toBe(mod.id);
    expect(fn.parent).toBe(cls.id);
  });

  it('case 06: nested function nests Function under Function', () => {
    const f = parse('def outer():\n    def inner():\n        pass\n');
    const fns = scopesByKind(f, 'Function');
    expect(fns).toHaveLength(2);
    const outer = fns.find((s) => s.range.startLine === 1)!;
    const inner = fns.find((s) => s.range.startLine === 2)!;
    expect(inner.parent).toBe(outer.id);
  });
});

// ─── Pass 1: no block scope ────────────────────────────────────────────────

describe('Python scopes — no block scope (PEP language reference)', () => {
  it('case 07: `if` body does NOT create a scope; declarations land in enclosing fn', () => {
    const f = parse('def f():\n    if True:\n        x = 1\n');
    expect(scopesByKind(f, 'Block')).toHaveLength(0);
    const fn = scopesByKind(f, 'Function')[0]!;
    expect(fn.bindings.has('x')).toBe(true);
  });

  it('case 08: `for` target binds in enclosing function scope, not in for body', () => {
    const f = parse('def f():\n    for i in range(10):\n        pass\n');
    expect(scopesByKind(f, 'Block')).toHaveLength(0);
    const fn = scopesByKind(f, 'Function')[0]!;
    expect(fn.bindings.has('i')).toBe(true);
  });

  it('case 09: `while`/`try`/`with` bodies do not produce Block scopes', () => {
    const f = parse(
      `def f():
    while True:
        a = 1
    try:
        b = 2
    except Exception:
        c = 3
    with open('x') as fh:
        d = 4
`,
    );
    expect(scopesByKind(f, 'Block')).toHaveLength(0);
    const fn = scopesByKind(f, 'Function')[0]!;
    for (const name of ['a', 'b', 'c', 'd']) expect(fn.bindings.has(name)).toBe(true);
  });
});

// ─── Pass 3: imports ──────────────────────────────────────────────────────

describe('Python imports — interpretImport', () => {
  it('case 10: `import numpy` → namespace import', () => {
    const f = parse('import numpy\n');
    expect(f.parsedImports).toEqual([
      { kind: 'namespace', localName: 'numpy', importedName: 'numpy', targetRaw: 'numpy' },
    ]);
  });

  it('case 11: `import numpy as np` → namespace import with rename', () => {
    const f = parse('import numpy as np\n');
    expect(f.parsedImports).toEqual([
      { kind: 'namespace', localName: 'np', importedName: 'numpy', targetRaw: 'numpy' },
    ]);
  });

  it('case 12: `import a.b.c` exposes the leading segment as the local name', () => {
    const f = parse('import a.b.c\n');
    expect(f.parsedImports).toEqual([
      { kind: 'namespace', localName: 'a', importedName: 'a.b.c', targetRaw: 'a.b.c' },
    ]);
  });

  it('case 13: `import a, b as c` decomposes into one ParsedImport per name', () => {
    const f = parse('import a, b as c\n');
    expect(f.parsedImports).toEqual([
      { kind: 'namespace', localName: 'a', importedName: 'a', targetRaw: 'a' },
      { kind: 'namespace', localName: 'c', importedName: 'b', targetRaw: 'b' },
    ]);
  });

  it('case 14: `from m import x` → named import', () => {
    const f = parse('from m import x\n');
    expect(f.parsedImports).toEqual([
      { kind: 'named', localName: 'x', importedName: 'x', targetRaw: 'm' },
    ]);
  });

  it('case 15: `from m import x as y` → alias import', () => {
    const f = parse('from m import x as y\n');
    expect(f.parsedImports).toEqual([
      { kind: 'alias', localName: 'y', importedName: 'x', alias: 'y', targetRaw: 'm' },
    ]);
  });

  it('case 16: `from m import x, y, z` decomposes into three ParsedImports', () => {
    const f = parse('from m import x, y, z\n');
    expect(f.parsedImports).toEqual([
      { kind: 'named', localName: 'x', importedName: 'x', targetRaw: 'm' },
      { kind: 'named', localName: 'y', importedName: 'y', targetRaw: 'm' },
      { kind: 'named', localName: 'z', importedName: 'z', targetRaw: 'm' },
    ]);
  });

  it('case 17: `from m import *` → wildcard', () => {
    const f = parse('from m import *\n');
    expect(f.parsedImports).toEqual([{ kind: 'wildcard', targetRaw: 'm' }]);
  });

  it('case 18: PEP-328 dotted relative import `from .pkg import x`', () => {
    const f = parse('from .pkg import x\n');
    expect(f.parsedImports).toEqual([
      { kind: 'named', localName: 'x', importedName: 'x', targetRaw: '.pkg' },
    ]);
  });

  it('case 19: PEP-328 parent-relative import `from ..pkg.sub import x`', () => {
    const f = parse('from ..pkg.sub import x\n');
    expect(f.parsedImports).toEqual([
      { kind: 'named', localName: 'x', importedName: 'x', targetRaw: '..pkg.sub' },
    ]);
  });
});

// ─── Imports inside functions ─────────────────────────────────────────────

describe('Python imports — function-local', () => {
  it('case 20: function-local `from x import Y` is captured (visible to importOwningScope)', () => {
    const f = parse('def loader():\n    from m import X\n');
    // Decomposed at parse time; finalize will route via importOwningScope.
    expect(f.parsedImports).toEqual([
      { kind: 'named', localName: 'X', importedName: 'X', targetRaw: 'm' },
    ]);
  });
});

// ─── Pass 4: type bindings ────────────────────────────────────────────────

describe('Python type bindings — parameter annotations + self/cls', () => {
  it('case 21: typed parameter `def f(x: User)` binds x → User on function scope', () => {
    const f = parse('def f(x: User):\n    pass\n');
    const fn = scopesByKind(f, 'Function')[0]!;
    const tb = fn.typeBindings.get('x');
    expect(tb).toBeDefined();
    expect(tb!.rawName).toBe('User');
    expect(tb!.source).toBe('parameter-annotation');
  });

  it('case 22: typed default parameter `def f(x: int = 0)` is captured', () => {
    const f = parse('def f(x: int = 0):\n    pass\n');
    const fn = scopesByKind(f, 'Function')[0]!;
    expect(fn.typeBindings.get('x')?.rawName).toBe('int');
  });

  it('case 23: forward-ref string `def f(x: "User")` is unquoted', () => {
    const f = parse('def f(x: "User"):\n    pass\n');
    const fn = scopesByKind(f, 'Function')[0]!;
    expect(fn.typeBindings.get('x')?.rawName).toBe('User');
  });

  it('case 24: instance method gets self → ClassName as `self` source', () => {
    const f = parse('class A:\n    def m(self):\n        pass\n');
    const fn = scopesByKind(f, 'Function')[0]!;
    const self = fn.typeBindings.get('self');
    expect(self).toBeDefined();
    expect(self!.rawName).toBe('A');
    expect(self!.source).toBe('self');
  });

  it('case 25: `@classmethod`-decorated method gets cls → ClassName', () => {
    const f = parse(
      `class A:
    @classmethod
    def make(cls):
        pass
`,
    );
    const fn = scopesByKind(f, 'Function')[0]!;
    expect(fn.typeBindings.get('cls')?.rawName).toBe('A');
    expect(fn.typeBindings.has('self')).toBe(false);
  });

  it('case 26: `@staticmethod`-decorated method gets NO implicit receiver', () => {
    const f = parse(
      `class A:
    @staticmethod
    def util(x):
        pass
`,
    );
    const fn = scopesByKind(f, 'Function')[0]!;
    expect(fn.typeBindings.has('self')).toBe(false);
    expect(fn.typeBindings.has('cls')).toBe(false);
  });

  it('case 27: free function gets NO `self`/`cls` binding', () => {
    const f = parse('def free(x):\n    pass\n');
    const fn = scopesByKind(f, 'Function')[0]!;
    expect(fn.typeBindings.has('self')).toBe(false);
    expect(fn.typeBindings.has('cls')).toBe(false);
  });

  it('case 28: nested function inside method does NOT inherit `self`', () => {
    const f = parse(
      `class A:
    def m(self):
        def inner():
            pass
`,
    );
    const inner = scopesByKind(f, 'Function').find((s) => s.range.startLine === 3)!;
    expect(inner.typeBindings.has('self')).toBe(false);
  });
});

// ─── Pass 5: reference sites ──────────────────────────────────────────────

describe('Python reference sites — calls', () => {
  it('case 29: free call `print(x)` records a call reference', () => {
    const f = parse('def f():\n    print(1)\n');
    const calls = f.referenceSites.filter((r) => r.kind === 'call');
    expect(calls.some((c) => c.name === 'print' && c.callForm === 'free')).toBe(true);
  });

  it('case 30: member call `obj.save()` records explicit receiver `obj`', () => {
    const f = parse('def f(obj):\n    obj.save()\n');
    const member = f.referenceSites.find((r) => r.kind === 'call' && r.name === 'save')!;
    expect(member.callForm).toBe('member');
    expect(member.explicitReceiver).toEqual({ name: 'obj' });
  });

  it('case 31: chained member call `a.b.c()` captures `c` with receiver `a.b`', () => {
    const f = parse('def f(a):\n    a.b.c()\n');
    const member = f.referenceSites.find((r) => r.kind === 'call' && r.name === 'c')!;
    expect(member.callForm).toBe('member');
    expect(member.explicitReceiver?.name).toBe('a.b');
  });
});

// ─── global / nonlocal — documented under-reporting ───────────────────────

describe('Python `global`/`nonlocal` — documented behavior', () => {
  it('case 32: `global x` inside a function does NOT promote the binding to module scope', () => {
    // Documented limitation: the assignment lexically lives in `f`, so
    // we attach `x` to f's scope. A future Ring may re-bind via
    // bindingScopeFor; for Ring 3 this is expected behavior.
    const f = parse(
      `x = 0
def f():
    global x
    x = 1
`,
    );
    const fn = scopesByKind(f, 'Function')[0]!;
    const mod = scopesByKind(f, 'Module')[0]!;
    expect(mod.bindings.has('x')).toBe(true); // module-level x = 0
    expect(fn.bindings.has('x')).toBe(true); // local x = 1 — under-reported as fn-local
  });

  it('case 33: `nonlocal x` inside a closure does NOT lift binding to enclosing fn', () => {
    const f = parse(
      `def outer():
    x = 0
    def inner():
        nonlocal x
        x = 1
`,
    );
    const inner = scopesByKind(f, 'Function').find((s) => s.range.startLine === 3)!;
    expect(inner.bindings.has('x')).toBe(true); // under-reported
  });
});
