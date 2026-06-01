/**
 * Regression tests for Python scope-resolution coverage gaps (issue #1932).
 *
 * Each fixture FAILS on main and PASSES on the fix branch.
 */
import { describe, it, expect } from 'vitest';
import { emitPythonScopeCaptures } from '../../../src/core/ingestion/languages/python/index.js';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { pythonProvider } from '../../../src/core/ingestion/languages/python.js';
import type { CaptureMatch } from 'gitnexus-shared';

/**
 * Count matches whose capture-key set satisfies `predicate`.
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
  it('simple @app.route decorator emits @reference.call.member', () => {
    const src = `
@app.route("/")
def index():
    return "ok"
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const decoratorMatches = matches.filter((m) => m['@reference.call.member']);
    expect(decoratorMatches.length).toBe(1);
    expect(decoratorMatches[0]['@reference.name']?.text).toBe('route');
  });

  it('nested attribute decorator @api.v1.endpoint emits @reference.call.member', () => {
    const src = `
@api.v1.endpoint
def handler():
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const decoratorMatches = matches.filter((m) => m['@reference.call.member']);
    expect(decoratorMatches.length).toBe(1);
    expect(decoratorMatches[0]['@reference.name']?.text).toBe('endpoint');
  });

  it('simple @decorator (bare identifier) emits @reference.call.free', () => {
    const src = `
@login_required
def protected_view():
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const decoratorMatches = matches.filter((m) => m['@reference.call.free']);
    expect(decoratorMatches.length).toBe(1);
    expect(decoratorMatches[0]['@reference.name']?.text).toBe('login_required');
  });
});

// ---------------------------------------------------------------------------
// F58 — End-to-end: extractParsedFile produces referenceSites
// ---------------------------------------------------------------------------

describe('F58 — decorator produces referenceSites in extractParsedFile', () => {
  it('@login_required produces a referenceSite entry', () => {
    const src = `@login_required\ndef foo():\n    pass\n`;
    const parsedFile = extractParsedFile(pythonProvider, src, 'app.py', () => {});
    expect(parsedFile).not.toBeNull();
    expect(parsedFile!.referenceSites.length).toBeGreaterThanOrEqual(1);
    const hasLoginRef = parsedFile!.referenceSites.some((r) => r.name === 'login_required');
    expect(hasLoginRef).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F61 — Lambda scope
// ---------------------------------------------------------------------------

describe('F61 — Python lambda scope', () => {
  it('bare lambda emits @scope.function', () => {
    const src = `handler = lambda x: x + 1\n`;
    const scopeFnCount = countCaptures(src, (tags) => tags.includes('@scope.function'));
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
    expect(scopeFnCount).toBe(2);
  });
});
