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
import {
  FIXTURES,
  edgeSet,
  findDanglingEdges,
  getNodesByLabel,
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import type { CaptureMatch } from 'gitnexus-shared';
import { preprocessDartExtensionTypes } from '../../../src/core/ingestion/languages/dart/extension-type-preprocess.js';

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

const EXTENSION_TYPES = `class Identifiable {}

class SequenceLike<T> {}

class Comparator<A, B> {}

extension type const UserId(String value) implements Identifiable {
  String describe() => value;
}

extension type const EmptyId(String value) {}

extension type Celsius(double degrees) {
  double toFahrenheit() => degrees * 9 / 5 + 32;
}

extension type Box<T>(List<T> value) implements SequenceLike<T> {
  T first() => value.first;
}

extension type Pair(String value) implements Comparator<String, int> {
  String describePair() => value;
}

extension Fancy on String {
  int get doubledLength => length * 2;
  String shout() => toUpperCase();
}`;

/** All @declaration.type_alias matches, as (name) tuples. */
function typeAliasNames(src: string): string[] {
  const matches = emitDartScopeCaptures(src, 'test.dart') as CaptureMatch[];
  return matches
    .filter((m) => m['@declaration.type_alias'] !== undefined)
    .map((m) => m['@declaration.name']?.text)
    .filter((n): n is string => Boolean(n));
}

/** All class-like Dart declaration matches, as names. */
function classDeclarationNames(src: string): string[] {
  const matches = emitDartScopeCaptures(src, 'test.dart') as CaptureMatch[];
  return matches
    .filter((m) => m['@declaration.class'] !== undefined)
    .map((m) => m['@declaration.name']?.text)
    .filter((n): n is string => Boolean(n));
}

/** Synthetic Dart implements markers, as marker payloads. */
function heritageImports(src: string): string[] {
  const matches = emitDartScopeCaptures(src, 'test.dart') as CaptureMatch[];
  return matches.map((m) => m['@import.heritage']?.text).filter((n): n is string => Boolean(n));
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
// #2538 — extension type declarations (scope layer)
// ---------------------------------------------------------------------------

describe.skipIf(!dartAvailable)('Dart extension type declarations (scope layer)', () => {
  it('rewrites extension type headers without changing source length or line count', () => {
    const rewritten = preprocessDartExtensionTypes(EXTENSION_TYPES);
    expect(rewritten).toHaveLength(EXTENSION_TYPES.length);
    expect(rewritten.split('\n')).toHaveLength(EXTENSION_TYPES.split('\n').length);
    for (const name of ['UserId', 'EmptyId', 'Celsius', 'Box', 'Pair']) {
      expect(rewritten.indexOf(name)).toBe(EXTENSION_TYPES.indexOf(name));
    }
    expect(rewritten).toContain('UserId on String');
    expect(rewritten).toContain('EmptyId on String');
    expect(rewritten).toContain('Celsius on double');
    expect(rewritten).toContain('Box<T> on List<T>');
    expect(rewritten).toContain('Pair on String');
  });

  it('captures extension types as class-like declarations', () => {
    const names = classDeclarationNames(EXTENSION_TYPES);
    expect(names).toEqual(
      expect.arrayContaining(['UserId', 'EmptyId', 'Celsius', 'Box', 'Pair', 'Fancy']),
    );
  });

  it('captures implements clauses on extension types as heritage markers', () => {
    const imports = heritageImports(EXTENSION_TYPES);
    expect(imports).toEqual(
      expect.arrayContaining([
        '__heritage__:implements:Identifiable:UserId',
        '__heritage__:implements:SequenceLike:Box',
        '__heritage__:implements:Comparator:Pair',
      ]),
    );
    expect(imports).not.toContain('__heritage__:implements:int:Pair');
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

// ---------------------------------------------------------------------------
// #2538 — extension type symbols exist end-to-end (structure phase)
// ---------------------------------------------------------------------------

describe.skipIf(!dartAvailable)('Dart extension type symbols (end-to-end)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-extension-types'), () => {});
  }, 60000);

  it('creates Class nodes for extension type declarations', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toEqual(
      expect.arrayContaining(['UserId', 'EmptyId', 'Celsius', 'Box', 'Pair', 'Fancy']),
    );
  });

  it('emits IMPLEMENTS edges for extension type implements clauses', () => {
    const implementsEdges = edgeSet(getRelationships(result, 'IMPLEMENTS'));
    expect(implementsEdges).toEqual(
      expect.arrayContaining(['Box → SequenceLike', 'Pair → Comparator', 'UserId → Identifiable']),
    );
    expect(implementsEdges).not.toContain('Pair → int');
  });

  it('keeps extension type methods owned by their extension type symbol', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toEqual(
      expect.arrayContaining(['describe', 'toFahrenheit', 'first', 'describePair', 'shout']),
    );

    const hasMethod = edgeSet(getRelationships(result, 'HAS_METHOD'));
    expect(hasMethod).toEqual(
      expect.arrayContaining([
        'UserId → describe',
        'Celsius → toFahrenheit',
        'Box → first',
        'Pair → describePair',
        'Fancy → shout',
      ]),
    );
  });

  it('does not leave dangling method ownership edges', () => {
    expect(findDanglingEdges(result, ['HAS_METHOD', 'IMPLEMENTS'])).toEqual([]);
  });
});
