/**
 * Unit tests for the PURE half of the Python constant resolver (#2391):
 * {@link resolveConstant} / {@link resolveOperands} / {@link resolvePythonImport}.
 *
 * These operate on a hand-built {@link RepoConstants} map, so no tree-sitter is
 * involved — the tree → ModuleConstants extraction is covered separately in the
 * U2 section of this file. The scenarios mirror the plan's U1 test list: same-file
 * literals/concat, single- and multi-hop imports, the issue's chained repro,
 * aliasing, inline operands, the relative-import collision (KTD4), cycles, the
 * depth cap, and non-foldable / unknown / package-`__init__` cases → null.
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import {
  resolveConstant,
  resolveOperands,
  resolvePythonImport,
  extractPythonModuleConstants,
  type ModuleConstants,
  type Operand,
  type ImportBinding,
  type RepoConstants,
} from '../../src/core/ingestion/route-extractors/python-const-resolver.js';

const lit = (value: string): Operand => ({ kind: 'literal', value });
const ref = (name: string): Operand => ({ kind: 'ref', name });

function mc(parts: {
  literals?: Record<string, string>;
  exprs?: Record<string, Operand[]>;
  imports?: Record<string, ImportBinding>;
}): ModuleConstants {
  return {
    literals: new Map(Object.entries(parts.literals ?? {})),
    exprs: new Map(Object.entries(parts.exprs ?? {})),
    imports: new Map(Object.entries(parts.imports ?? {})),
  };
}

const repo = (entries: Record<string, ModuleConstants>): RepoConstants =>
  new Map(Object.entries(entries));

describe('resolveConstant — same file', () => {
  it('resolves a bare literal', () => {
    const r = repo({ 'm.py': mc({ literals: { X: '/a' } }) });
    expect(resolveConstant('m.py', 'X', r)).toBe('/a');
  });

  it('folds a concat of two literals', () => {
    const r = repo({ 'm.py': mc({ exprs: { X: [lit('/a'), lit('/b')] } }) });
    expect(resolveConstant('m.py', 'X', r)).toBe('/a/b');
  });

  it('folds a concat referencing another same-file const', () => {
    const r = repo({ 'm.py': mc({ literals: { A: '/a' }, exprs: { X: [ref('A'), lit('/b')] } }) });
    expect(resolveConstant('m.py', 'X', r)).toBe('/a/b');
  });
});

describe('resolveConstant — across imports', () => {
  it('resolves a single import hop', () => {
    const r = repo({
      'app/constants.py': mc({ literals: { X: '/a' } }),
      'app/routes.py': mc({ imports: { X: { module: '.constants', originalName: 'X' } } }),
    });
    expect(resolveConstant('app/routes.py', 'X', r)).toBe('/a');
  });

  it('resolves the issue repro: chained in-module concat behind an import', () => {
    const r = repo({
      'app/constants.py': mc({
        literals: { API_V1: '/api/v1' },
        exprs: {
          API_V1_WIDGETS: [ref('API_V1'), lit('/widgets')],
          API_V1_WIDGETS_GET: [ref('API_V1_WIDGETS'), lit('/get')],
        },
      }),
      'app/routes.py': mc({
        imports: {
          API_V1_WIDGETS_GET: { module: '.constants', originalName: 'API_V1_WIDGETS_GET' },
        },
      }),
    });
    expect(resolveConstant('app/routes.py', 'API_V1_WIDGETS_GET', r)).toBe('/api/v1/widgets/get');
  });

  it('resolves a multi-module chain (base -> constants -> routes)', () => {
    const r = repo({
      'app/base.py': mc({ literals: { API_V1: '/api/v1' } }),
      'app/constants.py': mc({
        imports: { API_V1: { module: '.base', originalName: 'API_V1' } },
        exprs: { WIDGETS: [ref('API_V1'), lit('/widgets')] },
      }),
      'app/routes.py': mc({
        imports: { WIDGETS: { module: '.constants', originalName: 'WIDGETS' } },
      }),
    });
    expect(resolveConstant('app/routes.py', 'WIDGETS', r)).toBe('/api/v1/widgets');
  });

  it('resolves an aliased import via the original name', () => {
    const r = repo({
      'app/constants.py': mc({ literals: { X: '/a' } }),
      'app/routes.py': mc({ imports: { Y: { module: '.constants', originalName: 'X' } } }),
    });
    expect(resolveConstant('app/routes.py', 'Y', r)).toBe('/a');
  });
});

describe('resolveOperands — inline decorator expression', () => {
  it('folds an inline operand list with a const ref', () => {
    const r = repo({ 'app/routes.py': mc({ literals: { API_V1: '/api/v1' } }) });
    expect(resolveOperands('app/routes.py', [ref('API_V1'), lit('/widgets')], r)).toBe(
      '/api/v1/widgets',
    );
  });
});

describe('resolveConstant — relative-import collision (KTD4)', () => {
  const r = repo({
    'a/constants.py': mc({ literals: { API_PREFIX: '/a' } }),
    'b/constants.py': mc({ literals: { API_PREFIX: '/b' } }),
    'a/routes.py': mc({
      imports: { API_PREFIX: { module: '.constants', originalName: 'API_PREFIX' } },
    }),
    'b/routes.py': mc({
      imports: { API_PREFIX: { module: '.constants', originalName: 'API_PREFIX' } },
    }),
    'c/routes.py': mc({
      imports: { API_PREFIX: { module: 'constants', originalName: 'API_PREFIX' } },
    }),
  });

  it('resolves each package against its own constants.py', () => {
    expect(resolveConstant('a/routes.py', 'API_PREFIX', r)).toBe('/a');
    expect(resolveConstant('b/routes.py', 'API_PREFIX', r)).toBe('/b');
  });

  it('returns null for an ambiguous absolute import (two matching files)', () => {
    expect(resolveConstant('c/routes.py', 'API_PREFIX', r)).toBeNull();
  });
});

describe('resolveConstant — unresolvable → null', () => {
  it('breaks a cycle', () => {
    const r = repo({ 'm.py': mc({ exprs: { A: [ref('B')], B: [ref('A')] } }) });
    expect(resolveConstant('m.py', 'A', r)).toBeNull();
  });

  it('returns null past the depth cap', () => {
    const exprs: Record<string, Operand[]> = {};
    for (let i = 0; i < 20; i++) exprs[`A${i}`] = [ref(`A${i + 1}`)];
    const r = repo({ 'm.py': mc({ exprs, literals: { A20: '/end' } }) });
    expect(resolveConstant('m.py', 'A0', r)).toBeNull();
  });

  it('returns null on an unknown operand name', () => {
    const r = repo({ 'm.py': mc({ exprs: { X: [lit('/a'), ref('MISSING')] } }) });
    expect(resolveConstant('m.py', 'X', r)).toBeNull();
  });

  it('returns null for an unknown name', () => {
    const r = repo({ 'm.py': mc({ literals: { X: '/a' } }) });
    expect(resolveConstant('m.py', 'NOPE', r)).toBeNull();
  });

  it('returns null when a package __init__ re-export hop is not a .py module', () => {
    const r = repo({
      'app/constants/__init__.py': mc({ literals: { X: '/a' } }),
      'app/routes.py': mc({ imports: { X: { module: '.constants', originalName: 'X' } } }),
    });
    // `.constants` resolves to `app/constants.py`, which does not exist (it is a
    // package dir). Package __init__ re-exports are deferred (#2391 scope).
    expect(resolveConstant('app/routes.py', 'X', r)).toBeNull();
  });
});

describe('resolvePythonImport', () => {
  const keys = new Set(['a/constants.py', 'b/constants.py', 'app/pkg/mod.py', 'app/routes.py']);

  it('resolves a relative import against the importing file package', () => {
    expect(resolvePythonImport('a/routes.py', '.constants', keys)).toBe('a/constants.py');
  });

  it('walks up one level per extra leading dot', () => {
    expect(resolvePythonImport('app/pkg/routes.py', '..routes', keys)).toBe('app/routes.py');
  });

  it('returns null for an ambiguous absolute suffix', () => {
    expect(resolvePythonImport('a/routes.py', 'constants', keys)).toBeNull();
  });

  it('resolves an unambiguous absolute multi-segment import', () => {
    expect(resolvePythonImport('a/routes.py', 'app.pkg.mod', keys)).toBe('app/pkg/mod.py');
  });

  it('returns null when the target file does not exist', () => {
    expect(resolvePythonImport('a/routes.py', '.missing', keys)).toBeNull();
  });

  it('resolves `from . import` to the package __init__.py, not a sibling <dir>.py (#2393)', () => {
    const k = new Set(['pkg/__init__.py', 'pkg/routes.py']);
    expect(resolvePythonImport('pkg/routes.py', '.', k)).toBe('pkg/__init__.py');
  });

  it('returns null for `from . import` when the package __init__.py is absent (#2393)', () => {
    expect(resolvePythonImport('pkg/routes.py', '.', new Set(['pkg/routes.py']))).toBeNull();
  });

  it('returns null for an over-deep relative import even if the clamped target exists (#2393)', () => {
    // `from ...constants` from a repo-root file climbs two levels above the root.
    // Without the guard it would clamp to a bare `constants.py`; it must return null.
    const k = new Set(['constants.py', 'routes.py']);
    expect(resolvePythonImport('routes.py', '...constants', k)).toBeNull();
  });
});

// ─── U2: tree → ModuleConstants extraction (real parse) ──────────────────────

const parser = new Parser();
parser.setLanguage(Python);
const extract = (src: string): ModuleConstants => extractPythonModuleConstants(parser.parse(src));
const repoFrom = (files: Record<string, string>): RepoConstants =>
  new Map(Object.entries(files).map(([k, src]) => [k, extract(src)]));

describe('extractPythonModuleConstants', () => {
  it('extracts a bare string literal', () => {
    const mcs = extract('X = "/a"\n');
    expect(mcs.literals.get('X')).toBe('/a');
  });

  it('extracts a + concat as an ordered operand list', () => {
    const mcs = extract('X = A + "/b"\n');
    expect(mcs.exprs.get('X')).toEqual([
      { kind: 'ref', name: 'A' },
      { kind: 'literal', value: '/b' },
    ]);
  });

  it('caps recursion on a pathological deep + chain — null, not a throw (#2393)', () => {
    const chain = Array.from({ length: 100 }, (_, i) => `A${i}`).join(' + ');
    const mcs = extract(`X = ${chain}\n`); // depth > 64 → parseConstOperands floors to null
    expect(mcs.exprs.has('X')).toBe(false);
    expect(mcs.literals.has('X')).toBe(false);
  });

  it('folds an augmented assignment (X += "/b")', () => {
    const r = new Map([['m.py', extract('X = "/a"\nX += "/b"\n')]]);
    expect(resolveConstant('m.py', 'X', r)).toBe('/a/b');
  });

  it('applies last-wins rebind and drops a non-string rebind', () => {
    const r1 = new Map([['m.py', extract('X = "/a"\nX = "/b"\n')]]);
    expect(resolveConstant('m.py', 'X', r1)).toBe('/b');
    const r2 = new Map([['m.py', extract('X = "/a"\nX = build()\n')]]);
    expect(resolveConstant('m.py', 'X', r2)).toBeNull();
  });

  it('extracts from-import bindings, including aliases and relative paths', () => {
    const mcs = extract('from .constants import X\nfrom pkg.mod import Y as Z\n');
    expect(mcs.imports.get('X')).toEqual({ module: '.constants', originalName: 'X' });
    expect(mcs.imports.get('Z')).toEqual({ module: 'pkg.mod', originalName: 'Y' });
  });

  it('ignores non-string assignments', () => {
    const mcs = extract('N = 5\ncfg = Settings()\nP = "/p"\n');
    expect(mcs.literals.has('N')).toBe(false);
    expect(mcs.exprs.has('cfg')).toBe(false);
    expect(mcs.literals.get('P')).toBe('/p');
  });

  it('resolves the full issue repro end-to-end (extractor → resolver)', () => {
    const r = repoFrom({
      'app/constants.py': [
        'API_V1 = "/api/v1"',
        'API_V1_WIDGETS = API_V1 + "/widgets"',
        'API_V1_WIDGETS_GET = API_V1_WIDGETS + "/get"',
      ].join('\n'),
      'app/routes.py': 'from .constants import API_V1_WIDGETS_GET\n',
    });
    expect(resolveConstant('app/routes.py', 'API_V1_WIDGETS_GET', r)).toBe('/api/v1/widgets/get');
  });

  it('survives a structured-clone round-trip (worker/cache boundary)', () => {
    const cloned = structuredClone(extract('X = "/a"\nfrom .c import Y\n'));
    const r = new Map([['m.py', cloned]]);
    expect(resolveConstant('m.py', 'X', r)).toBe('/a');
    expect(cloned.imports.get('Y')).toEqual({ module: '.c', originalName: 'Y' });
  });
});

describe('extractPythonModuleConstants — binding mutual-exclusivity (#2393)', () => {
  it('drops an imported name that is then rebound to a dynamic value (never the stale import)', () => {
    // Python: ROUTE's live value is the getenv result → unknowable → must DROP,
    // not resolve to the stale import (the skip-floor / wrong-path invariant).
    const mcs = extract('from .constants import ROUTE\nROUTE = os.getenv("X")\n');
    expect(mcs.imports.has('ROUTE')).toBe(false);
    expect(mcs.literals.has('ROUTE')).toBe(false);
    expect(mcs.exprs.has('ROUTE')).toBe(false);
    const r = repoFrom({
      'app/constants.py': 'ROUTE = "/imported"\n',
      'app/routes.py': 'from .constants import ROUTE\nROUTE = os.getenv("X")\n',
    });
    expect(resolveConstant('app/routes.py', 'ROUTE', r)).toBeNull();
  });

  it('uses the local literal when a later assignment shadows an import', () => {
    const r = repoFrom({
      'app/constants.py': 'ROUTE = "/imported"\n',
      'app/routes.py': 'from .constants import ROUTE\nROUTE = "/local"\n',
    });
    expect(resolveConstant('app/routes.py', 'ROUTE', r)).toBe('/local');
  });

  it('uses the import when it shadows an earlier local assignment (source order)', () => {
    const r = repoFrom({
      'app/constants.py': 'ROUTE = "/imported"\n',
      'app/routes.py': 'ROUTE = "/local"\nfrom .constants import ROUTE\n',
    });
    expect(resolveConstant('app/routes.py', 'ROUTE', r)).toBe('/imported');
  });

  it('folds an augmented assignment onto an imported base (#2393)', () => {
    const r = repoFrom({
      'app/constants.py': 'BASE = "/api"\n',
      'app/routes.py': 'from .constants import BASE\nBASE += "/v1"\n',
    });
    expect(resolveConstant('app/routes.py', 'BASE', r)).toBe('/api/v1');
  });

  it('folds a chain of += onto an imported base (#2393)', () => {
    const r = repoFrom({
      'app/constants.py': 'BASE = "/api"\n',
      'app/routes.py': 'from .constants import BASE\nBASE += "/a"\nBASE += "/b"\n',
    });
    expect(resolveConstant('app/routes.py', 'BASE', r)).toBe('/api/a/b');
  });

  it('drops a += onto an imported base that itself cannot be resolved (skip floor holds)', () => {
    const r = repoFrom({
      // `.missing` does not exist → the imported base is unresolvable → drop, never
      // a wrong path.
      'app/routes.py': 'from .missing import BASE\nBASE += "/v1"\n',
    });
    expect(resolveConstant('app/routes.py', 'BASE', r)).toBeNull();
  });
});

describe('extractPythonModuleConstants — source-order snapshot (#2393)', () => {
  it('snapshots an aliased imported base before a later += (no wrong path)', () => {
    // Python: ROUTE captures BASE's value at the `ROUTE =` line ("/api"); the later
    // `BASE += "/v1"` must NOT retroactively change ROUTE.
    const r = repoFrom({
      'app/constants.py': 'BASE = "/api"\n',
      'app/routes.py': 'from .constants import BASE\nROUTE = BASE\nBASE += "/v1"\n',
    });
    expect(resolveConstant('app/routes.py', 'ROUTE', r)).toBe('/api');
    expect(resolveConstant('app/routes.py', 'BASE', r)).toBe('/api/v1');
  });

  it('snapshots an aliased local constant before a later += (no wrong path)', () => {
    const r = repoFrom({ 'm.py': 'API = "/api"\nROUTE = API\nAPI += "/x"\n' });
    expect(resolveConstant('m.py', 'ROUTE', r)).toBe('/api');
    expect(resolveConstant('m.py', 'API', r)).toBe('/api/x');
  });

  it('snapshots an aliased local constant before a later plain rebind (no wrong path)', () => {
    const r = repoFrom({ 'm.py': 'API = "/api"\nROUTE = API\nAPI = "/other"\n' });
    expect(resolveConstant('m.py', 'ROUTE', r)).toBe('/api');
    expect(resolveConstant('m.py', 'API', r)).toBe('/other');
  });

  it('still folds a normal same-file reference chain (snapshot inlines bound refs)', () => {
    const r = repoFrom({ 'm.py': 'A = "/a"\nB = A + "/b"\nC = B + "/c"\n' });
    expect(resolveConstant('m.py', 'C', r)).toBe('/a/b/c');
  });
});
