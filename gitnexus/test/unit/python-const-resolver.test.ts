/**
 * Unit tests for the PURE half of the Python constant resolver (#2391):
 * {@link resolveConstant} / {@link resolveOperands} / {@link resolveImportToFileKey}.
 *
 * These operate on a hand-built {@link RepoConstants} map, so no tree-sitter is
 * involved — the tree → ModuleConstants extraction is covered separately in the
 * U2 section of this file. The scenarios mirror the plan's U1 test list: same-file
 * literals/concat, single- and multi-hop imports, the issue's chained repro,
 * aliasing, inline operands, the relative-import collision (KTD4), cycles, the
 * depth cap, and non-foldable / unknown / package-`__init__` cases → null.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveConstant,
  resolveOperands,
  resolveImportToFileKey,
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

describe('resolveImportToFileKey', () => {
  const keys = new Set(['a/constants.py', 'b/constants.py', 'app/pkg/mod.py', 'app/routes.py']);

  it('resolves a relative import against the importing file package', () => {
    expect(resolveImportToFileKey('a/routes.py', '.constants', keys)).toBe('a/constants.py');
  });

  it('walks up one level per extra leading dot', () => {
    expect(resolveImportToFileKey('app/pkg/routes.py', '..routes', keys)).toBe('app/routes.py');
  });

  it('returns null for an ambiguous absolute suffix', () => {
    expect(resolveImportToFileKey('a/routes.py', 'constants', keys)).toBeNull();
  });

  it('resolves an unambiguous absolute multi-segment import', () => {
    expect(resolveImportToFileKey('a/routes.py', 'app.pkg.mod', keys)).toBe('app/pkg/mod.py');
  });

  it('returns null when the target file does not exist', () => {
    expect(resolveImportToFileKey('a/routes.py', '.missing', keys)).toBeNull();
  });
});
