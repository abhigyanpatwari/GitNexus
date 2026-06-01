/**
 * Regression tests for Python scope-resolution coverage gaps (issue #1932).
 *
 * Each fixture FAILS on main and PASSES on the fix branch.
 */
import { describe, it, expect } from 'vitest';
import { emitPythonScopeCaptures } from '../../../src/core/ingestion/languages/python/index.js';
import type { CaptureMatch } from 'gitnexus-shared';

/**
 * Count matches whose capture-key set satisfies `predicate`.
 * `predicate` receives the list of tag names (e.g. ['@scope.function', '@declaration.name'])
 * for each match.
 */
function countCaptures(src: string, predicate: (tags: string[]) => boolean): number {
  const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
  return matches.filter((m) => predicate(Object.keys(m))).length;
}

// ---------------------------------------------------------------------------
// F57 — Heritage: qualified/subscripted bases
// ---------------------------------------------------------------------------

describe('F57 — Python heritage (qualified / subscripted bases)', () => {
  it('bare identifier base class emits @heritage.class + @heritage.extends', () => {
    const src = `
class Base:
    pass

class Child(Base):
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const heritageMatches = matches.filter((m) => m['@heritage.class']);
    expect(heritageMatches.length).toBe(1);
    expect(heritageMatches[0]['@heritage.class'].text).toBe('Child');
    expect(heritageMatches[0]['@heritage.extends'].text).toBe('Base');
  });

  it('qualified base (mod.Class) emits @heritage.extends for attribute', () => {
    const src = `
class A(mod.Base):
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const heritageMatches = matches.filter((m) => m['@heritage.class']);
    expect(heritageMatches.length).toBe(1);
    expect(heritageMatches[0]['@heritage.class'].text).toBe('A');
    expect(heritageMatches[0]['@heritage.extends'].text).toBe('mod.Base');
  });

  it('subscripted base (Generic[T]) emits @heritage.extends for subscript', () => {
    const src = `
from typing import Generic, TypeVar
T = TypeVar('T')

class B(Generic[T]):
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const heritageMatches = matches.filter((m) => m['@heritage.class']);
    expect(heritageMatches.length).toBe(1);
    expect(heritageMatches[0]['@heritage.class'].text).toBe('B');
    expect(heritageMatches[0]['@heritage.extends'].text).toBe('Generic[T]');
  });

  it('multiple patterns coexist with bare-identifier heritage', () => {
    const src = `
class C(types.Type):
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const heritageMatches = matches.filter((m) => m['@heritage.class']);
    expect(heritageMatches.length).toBe(1);
    expect(heritageMatches[0]['@heritage.class'].text).toBe('C');
    expect(heritageMatches[0]['@heritage.extends'].text).toBe('types.Type');
  });
});

// ---------------------------------------------------------------------------
// F58 — Decorator captures
// ---------------------------------------------------------------------------

describe('F58 — Python decorator captures', () => {
  it('simple @app.route decorator captures @reference.name', () => {
    const src = `
@app.route("/")
def index():
    return "ok"
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const decoratorMatches = matches.filter((m) => m['@reference.decorator.call']);
    expect(decoratorMatches.length).toBeGreaterThanOrEqual(1);
    const decoratorNames = decoratorMatches.map((m) => m['@reference.name']?.text);
    expect(decoratorNames).toContain('route');
  });

  it('nested attribute decorator @api.v1.endpoint captures @reference.name', () => {
    const src = `
@api.v1.endpoint
def handler():
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const decoratorMatches = matches.filter((m) => m['@reference.decorator.call']);
    expect(decoratorMatches.length).toBeGreaterThanOrEqual(1);
    const name = decoratorMatches[0]['@reference.name']?.text;
    expect(name).toBe('endpoint');
  });

  it('simple @decorator (bare identifier) captures @reference.name', () => {
    const src = `
@login_required
def protected_view():
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const decoratorMatches = matches.filter((m) => m['@reference.decorator.call']);
    expect(decoratorMatches.length).toBeGreaterThanOrEqual(1);
    const name = decoratorMatches[0]['@reference.name']?.text;
    expect(name).toBe('login_required');
  });
});

// ---------------------------------------------------------------------------
// F61 — Lambda scope
// ---------------------------------------------------------------------------

describe('F61 — Python lambda scope', () => {
  it('bare lambda emits @scope.function', () => {
    const src = `handler = lambda x: x + 1\n`;
    const scopeFnCount = countCaptures(src, (tags) => tags.includes('@scope.function'));
    // 1 for lambda
    expect(scopeFnCount).toBe(1);
  });

  it('multiple lambdas each get their own @scope.function', () => {
    const src = `double = lambda x: x * 2\ntriple = lambda x: x * 3\n`;
    const scopeFnCount = countCaptures(src, (tags) => tags.includes('@scope.function'));
    expect(scopeFnCount).toBe(2);
  });

  it('lambda coexists with function_definition scopes', () => {
    const src = `
def normal(x):
    return x + 1

handler = lambda x: x * 2
`;
    const scopeFnCount = countCaptures(src, (tags) => tags.includes('@scope.function'));
    // 1 normal function + 1 lambda = 2
    expect(scopeFnCount).toBe(2);
  });
});
