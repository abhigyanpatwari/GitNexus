/**
 * Lean 4 standalone tagger + import-target unit tests.
 *
 * Exercises the regex scope-capture emitter and the dotted-path →
 * file-path resolver without a pipeline run (no tree-sitter, no DB).
 */
import { describe, it, expect } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { leanProvider } from '../../src/core/ingestion/languages/lean.js';
import {
  emitLeanScopeCaptures,
  extractLeanDeclsWithRegex,
} from '../../src/core/ingestion/languages/lean/captures.js';
import { interpretLeanImport } from '../../src/core/ingestion/languages/lean/interpret.js';
import { resolveLeanImportTarget } from '../../src/core/ingestion/languages/lean/scope-resolver.js';
import { getProviderForFile } from '../../src/core/ingestion/languages/index.js';

const SRC = `import Mathlib.Analysis.Calculus.Deriv.MeanValue
open Set

namespace Foo
@[simp] theorem bar_baz (x : Nat) : x = x := rfl

private def helper : Nat := 1
end Foo

instance : Inhabited Nat := ⟨0⟩
`;

describe('lean provider registration', () => {
  it('registers under SupportedLanguages.Lean as standalone', () => {
    expect(leanProvider.id).toBe(SupportedLanguages.Lean);
    expect(leanProvider.parseStrategy).toBe('standalone');
    expect(leanProvider.treeSitterQueries).toBe('');
  });

  it('routes .lean files to the lean provider', () => {
    expect(getProviderForFile('Mathlib/Analysis/Calculus/Deriv/MeanValue.lean')?.id).toBe(
      SupportedLanguages.Lean,
    );
  });
});

describe('lean declaration extraction', () => {
  it('tags module + decls + imports', () => {
    const caps = emitLeanScopeCaptures(SRC, 'Mathlib/Test.lean');
    const names = caps.flatMap((m) => Object.keys(m));
    expect(names).toContain('@scope.module');
    expect(names).toContain('@scope.function');
    expect(names).toContain('@declaration.function');
    expect(names).toContain('@import.statement');
    expect(names).toContain('@import.name');
  });

  it('recovers declaration names incl. attributes and anonymous instance', () => {
    const { decls, imports } = extractLeanDeclsWithRegex(SRC);
    const byLine = new Map(decls.map((d) => [d.line, d]));
    expect(byLine.get(5)?.name).toBe('bar_baz');
    expect(byLine.get(5)?.qualified).toBe('Foo.bar_baz');
    expect(byLine.get(7)?.name).toBe('helper');
    // `instance : Inhabited Nat` is anonymous: no explicit name to steal.
    expect(byLine.get(10)?.name).toMatch(/^instance_L10$/);
    expect(imports.map((i) => i.target)).toContain(
      'Mathlib.Analysis.Calculus.Deriv.MeanValue',
    );
    expect(imports.find((i) => i.target === 'Set')?.isOpen).toBe(true);
  });

  it('interprets import captures as named ParsedImports', () => {
    const caps = emitLeanScopeCaptures(SRC, 'Mathlib/Test.lean');
    const imp = caps.find((m) => m['@import.name'] !== undefined)!;
    const parsed = interpretLeanImport(imp);
    expect(parsed?.kind).toBe('named');
    expect(parsed?.targetRaw).toBe(imp['@import.name']!.text);
  });
});

describe('lean import target resolution', () => {
  const files = new Set(['Mathlib/Analysis/Calculus/Deriv/MeanValue.lean']);

  it('maps dotted paths to repo-relative .lean files', () => {
    expect(
      resolveLeanImportTarget(
        'Mathlib.Analysis.Calculus.Deriv.MeanValue',
        'A.lean',
        files,
      ),
    ).toBe('Mathlib/Analysis/Calculus/Deriv/MeanValue.lean');
  });

  it('returns null for unresolvable targets', () => {
    expect(resolveLeanImportTarget('Nope.Missing', 'A.lean', files)).toBeNull();
  });
});
