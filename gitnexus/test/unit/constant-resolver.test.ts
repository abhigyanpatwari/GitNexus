/**
 * The language-agnostic constant-fold core (#2391). The exhaustive Python fold
 * behavior is pinned in `python-const-resolver.test.ts`; this file proves the
 * core is genuinely language-neutral by driving it with a NON-Python (Java-style)
 * {@link ImportResolver}, so a future Spring/Kotlin/C# binding can reuse the fold,
 * cycle guard, and depth cap by supplying only its own import resolver + extractor.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveConstant,
  resolveOperands,
  type ImportResolver,
  type ModuleConstants,
  type Operand,
  type RepoConstants,
} from '../../src/core/ingestion/route-extractors/constant-resolver.js';

const lit = (value: string): Operand => ({ kind: 'literal', value });
const ref = (name: string): Operand => ({ kind: 'ref', name });
const mc = (parts: {
  literals?: Record<string, string>;
  exprs?: Record<string, Operand[]>;
  imports?: Record<string, { module: string; originalName: string }>;
}): ModuleConstants => ({
  literals: new Map(Object.entries(parts.literals ?? {})),
  exprs: new Map(Object.entries(parts.exprs ?? {})),
  imports: new Map(Object.entries(parts.imports ?? {})),
});

// A deliberately non-Python resolver: JVM-style `com.app.Paths` → `com/app/Paths.java`.
const javaImport: ImportResolver = (_importingFileKey, moduleSpec, repoKeys) => {
  const candidate = moduleSpec.replace(/\./g, '/') + '.java';
  return repoKeys.has(candidate) ? candidate : null;
};

describe('constant-resolver — language-agnostic core', () => {
  it('folds a named constant across a Java-style import chain', () => {
    const repo: RepoConstants = new Map([
      [
        'com/app/Paths.java',
        mc({ literals: { API: '/api' }, exprs: { WIDGETS: [ref('API'), lit('/widgets')] } }),
      ],
      [
        'com/app/Routes.java',
        mc({ imports: { WIDGETS: { module: 'com.app.Paths', originalName: 'WIDGETS' } } }),
      ],
    ]);
    expect(resolveConstant('com/app/Routes.java', 'WIDGETS', repo, javaImport)).toBe(
      '/api/widgets',
    );
  });

  it('folds an inline operand list through the injected resolver', () => {
    const repo: RepoConstants = new Map([
      ['com/app/Paths.java', mc({ literals: { API: '/api' } })],
      [
        'com/app/Routes.java',
        mc({ imports: { API: { module: 'com.app.Paths', originalName: 'API' } } }),
      ],
    ]);
    expect(
      resolveOperands('com/app/Routes.java', [ref('API'), lit('/widgets')], repo, javaImport),
    ).toBe('/api/widgets');
  });

  it('floors to null when the resolver cannot pin the import', () => {
    const repo: RepoConstants = new Map([
      [
        'com/app/Routes.java',
        mc({ imports: { X: { module: 'com.missing.Paths', originalName: 'X' } } }),
      ],
    ]);
    expect(resolveConstant('com/app/Routes.java', 'X', repo, javaImport)).toBeNull();
  });

  it('applies the cycle guard and depth cap independent of the resolver', () => {
    const cyclic: RepoConstants = new Map([['m', mc({ exprs: { A: [ref('B')], B: [ref('A')] } })]]);
    expect(resolveConstant('m', 'A', cyclic, javaImport)).toBeNull();

    const exprs: Record<string, Operand[]> = {};
    for (let i = 0; i < 20; i++) exprs[`A${i}`] = [ref(`A${i + 1}`)];
    const deep: RepoConstants = new Map([['m', mc({ exprs, literals: { A20: '/end' } })]]);
    expect(resolveConstant('m', 'A0', deep, javaImport)).toBeNull();
  });

  it('folds a constant referenced twice in one expression (not a false cycle) (#2393)', () => {
    const repo: RepoConstants = new Map([['m', mc({ literals: { A: '/a' } })]]);
    // `A + A` — the second reference must NOT be mistaken for a cycle.
    expect(resolveOperands('m', [ref('A'), ref('A')], repo, javaImport)).toBe('/a/a');
  });

  it('folds a reused separator constant (#2393)', () => {
    const repo: RepoConstants = new Map([['m', mc({ literals: { SLASH: '/', PATH: 'p' } })]]);
    expect(resolveOperands('m', [ref('SLASH'), ref('PATH'), ref('SLASH')], repo, javaImport)).toBe(
      '/p/',
    );
  });

  it('by-name and operand-list entry differ at the depth boundary (#2393 parity)', () => {
    // A hop chain that lands exactly at MAX_RESOLVE_DEPTH for the operand-list
    // entry (one depth deeper than the by-name entry). This is why the group side
    // must fold identifier args via resolveOperands([ref]) — the SAME entry the
    // ingestion side uses — not resolveConstant, which would resolve here and
    // break ingestion↔group parity at the boundary.
    const exprs: Record<string, Operand[]> = {};
    for (let i = 0; i < 4; i++) exprs[`A${i}`] = [ref(`A${i + 1}`)];
    const repo: RepoConstants = new Map([['m', mc({ exprs, literals: { A4: '/end' } })]]);
    expect(resolveOperands('m', [ref('A0')], repo, javaImport)).toBeNull();
    expect(resolveConstant('m', 'A0', repo, javaImport)).toBe('/end');
  });

  it('drops a pathological self-multiplying concat instead of exhausting memory (#2393)', () => {
    // Each level references the next 64×, so the true value is 64^4 chars — folding
    // it naively blows the heap (RangeError/OOM). The fold-length cap must floor it
    // to null (drop). This resolves ~instantly; without the cap it OOMs.
    const W = 64;
    const exprs: Record<string, Operand[]> = {};
    for (let i = 0; i < 4; i++) exprs[`L${i}`] = Array.from({ length: W }, () => ref(`L${i + 1}`));
    const repo: RepoConstants = new Map([['m', mc({ exprs, literals: { L4: '/leaf' } })]]);
    expect(resolveConstant('m', 'L0', repo, javaImport)).toBeNull();
  });

  it('folds a diamond where two operands share a common base (#2393)', () => {
    const repo: RepoConstants = new Map([
      [
        'm',
        mc({
          literals: { BASE: '/base' },
          exprs: {
            P: [ref('BASE'), lit('/p')],
            Q: [ref('BASE'), lit('/q')],
            X: [ref('P'), ref('Q')],
          },
        }),
      ],
    ]);
    // BASE is reached transitively via both P and Q within X's single fold.
    expect(resolveConstant('m', 'X', repo, javaImport)).toBe('/base/p/base/q');
  });
});
