/**
 * Regression tests for Dart scope-resolution / structure coverage gaps
 * (issue #1919). Mirrors python-parsing-coverage.test.ts: the F28 scope-capture
 * assertions exercise emitDartScopeCaptures directly, and a pipeline check
 * verifies the TypeAlias symbol exists end-to-end.
 *
 * F28 — old-style function typedef (`typedef int Cmp(int a, int b);`) was never
 * captured: DART_SCOPE_QUERY had no type_alias rule, and DART_QUERIES only
 * captured the new-style (`=`-anchored) form. Both forms must now surface as a
 * type-alias declaration / TypeAlias symbol.
 *
 * #1919 review CF2 — the GENERIC forms (`typedef int Cmp2<T>(T a, T b);` and
 * `typedef Mapper<T> = T Function(T);`) were still dropped: a generic
 * type_parameters node sits between the alias name and the next anchor, so the
 * non-generic adjacency patterns never matched. Standalone generic patterns now
 * capture them too.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';
import { FIXTURES, getNodesByLabel, runPipelineFromRepo, type PipelineResult } from './helpers.js';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import type { CaptureMatch } from 'gitnexus-shared';

let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

const TYPEDEFS = `typedef int Cmp(int a, int b);
typedef int Cmp2<T>(T a, T b);
typedef Pred = bool Function(int);
typedef Mapper<T> = T Function(T);
typedef int _Internal(int);`;

/** All @declaration.type_alias matches, as (name) tuples. */
function typeAliasNames(src: string): string[] {
  const matches = emitDartScopeCaptures(src, 'test.dart') as CaptureMatch[];
  return matches
    .filter((m) => m['@declaration.type_alias'] !== undefined)
    .map((m) => m['@declaration.name']?.text)
    .filter((n): n is string => Boolean(n));
}

// ---------------------------------------------------------------------------
// F28 — typedef capture (scope layer)
// ---------------------------------------------------------------------------

describe.skipIf(!dartAvailable)('F28 — Dart typedef capture (scope layer)', () => {
  it('captures the old-style function typedef as a type-alias declaration', () => {
    const names = typeAliasNames(TYPEDEFS);
    expect(names).toContain('Cmp');
  });

  it('still captures the new-style typedef (regression)', () => {
    const names = typeAliasNames(TYPEDEFS);
    expect(names).toContain('Pred');
  });

  it('captures a private old-style typedef', () => {
    const names = typeAliasNames(TYPEDEFS);
    expect(names).toContain('_Internal');
  });

  it('captures the generic old-style typedef (CF2)', () => {
    const names = typeAliasNames(TYPEDEFS);
    expect(names).toContain('Cmp2');
  });

  it('captures the generic new-style typedef (CF2)', () => {
    const names = typeAliasNames(TYPEDEFS);
    expect(names).toContain('Mapper');
  });

  it('emits exactly one declaration per typedef (no double-match)', () => {
    const names = typeAliasNames(TYPEDEFS);
    expect(names.sort()).toEqual(['Cmp', 'Cmp2', 'Pred', 'Mapper', '_Internal'].sort());
  });
});

// ---------------------------------------------------------------------------
// F28 — typedef symbols exist end-to-end (structure phase)
// ---------------------------------------------------------------------------

describe.skipIf(!dartAvailable)('F28 — Dart typedef symbols (end-to-end)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-coverage'), () => {});
  }, 60000);

  it('creates TypeAlias nodes for old-style, new-style, generic, and private typedefs', () => {
    const aliases = getNodesByLabel(result, 'TypeAlias');
    expect(aliases).toContain('Cmp'); // old-style (covers F28)
    expect(aliases).toContain('Cmp2'); // generic old-style (covers CF2)
    expect(aliases).toContain('Pred'); // new-style (regression)
    expect(aliases).toContain('Mapper'); // generic new-style (covers CF2)
    expect(aliases).toContain('_Internal'); // private old-style
  });

  it('emits exactly one TypeAlias per typedef (no duplicates)', () => {
    const aliases = getNodesByLabel(result, 'TypeAlias');
    const fromFixture = aliases.filter((n) =>
      ['Cmp', 'Cmp2', 'Pred', 'Mapper', '_Internal'].includes(n),
    );
    expect(fromFixture.sort()).toEqual(['Cmp', 'Cmp2', 'Mapper', 'Pred', '_Internal'].sort());
  });
});
