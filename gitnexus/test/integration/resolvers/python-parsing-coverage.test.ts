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

// The legacy heritage-capture leg was removed in #942; the registry-primary
// scope-resolution path now synthesizes @reference.inherits captures (full base
// node) plus @reference.name (the bare normalized lookup name) for each
// superclass. preEmitInheritanceEdges turns these into EXTENDS edges downstream.
describe('F57 — Python heritage (qualified / subscripted bases)', () => {
  it('bare identifier base class emits @reference.inherits', () => {
    const src = `
class Base:
    pass

class Child(Base):
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const inheritsMatches = matches.filter((m) => m['@reference.inherits']);
    expect(inheritsMatches.length).toBe(1);
    expect(inheritsMatches[0]['@reference.inherits'].text).toBe('Base');
    expect(inheritsMatches[0]['@reference.name'].text).toBe('Base');
  });

  it('qualified base (mod.Class) emits @reference.inherits with normalized name', () => {
    const src = `
class A(mod.Base):
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const inheritsMatches = matches.filter((m) => m['@reference.inherits']);
    expect(inheritsMatches.length).toBe(1);
    expect(inheritsMatches[0]['@reference.inherits'].text).toBe('mod.Base');
    expect(inheritsMatches[0]['@reference.name'].text).toBe('Base');
  });

  it('subscripted base (Generic[T]) emits @reference.inherits with normalized name', () => {
    const src = `
from typing import Generic, TypeVar
T = TypeVar('T')

class B(Generic[T]):
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const inheritsMatches = matches.filter((m) => m['@reference.inherits']);
    expect(inheritsMatches.length).toBe(1);
    expect(inheritsMatches[0]['@reference.inherits'].text).toBe('Generic[T]');
    expect(inheritsMatches[0]['@reference.name'].text).toBe('Generic');
  });

  it('qualified base (types.Type) emits @reference.inherits with normalized name', () => {
    const src = `
class C(types.Type):
    pass
`;
    const matches = emitPythonScopeCaptures(src, 'test.py') as CaptureMatch[];
    const inheritsMatches = matches.filter((m) => m['@reference.inherits']);
    expect(inheritsMatches.length).toBe(1);
    expect(inheritsMatches[0]['@reference.inherits'].text).toBe('types.Type');
    expect(inheritsMatches[0]['@reference.name'].text).toBe('Type');
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
