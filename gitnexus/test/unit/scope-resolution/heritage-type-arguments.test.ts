/**
 * Heritage generic ARGUMENTS reach resolution, across languages (#2912).
 *
 * Three routes exist, and every language uses exactly one of them:
 *
 *   1. The `@reference.inherits` ANCHOR already spans the whole base, so the
 *      spelling is read straight off it and no query changed (C#, Java,
 *      TypeScript, Kotlin, Go, Python, Swift).
 *   2. The anchor is the bare NAME node — widening it would move the site's
 *      range, which is part of every inheritance edge's id — so the arguments
 *      arrive through the `@reference.type-arguments` sub-tag (Rust, Dart
 *      `extends`).
 *   3. The clause never becomes a reference site at all, and rides a heritage
 *      MARKER payload instead (Dart `implements` / `with`).
 *
 * Each is pinned here because instantiation filtering degrades SILENTLY to the
 * pre-#2912 fan-out when a capture stops arriving: no error, no failing edge
 * count, just an interface reaching implementors of the wrong instantiation
 * again.
 */
import { describe, it, expect } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import type { LanguageProvider } from '../../../src/core/ingestion/language-provider.js';
import { csharpProvider } from '../../../src/core/ingestion/languages/csharp.js';
import { javaProvider } from '../../../src/core/ingestion/languages/java.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { kotlinProvider } from '../../../src/core/ingestion/languages/kotlin.js';
import { goProvider } from '../../../src/core/ingestion/languages/go.js';
import { pythonProvider } from '../../../src/core/ingestion/languages/python.js';
import { swiftProvider } from '../../../src/core/ingestion/languages/swift.js';
import { rustProvider } from '../../../src/core/ingestion/languages/rust.js';
import { dartProvider } from '../../../src/core/ingestion/languages/dart.js';
import { decodeMarker } from '../../../src/core/ingestion/utils/heritage-marker.js';

function inheritsSites(
  provider: LanguageProvider,
  source: string,
  filePath: string,
): Array<{ name: string; typeArguments?: readonly string[] }> {
  const parsed: ParsedFile | null = extractParsedFile(provider, source, filePath);
  return (parsed?.referenceSites ?? [])
    .filter((site) => site.kind === 'inherits')
    .map((site) => ({ name: site.name, typeArguments: site.typeArguments }));
}

describe('heritage type arguments are captured', () => {
  it('C# base list', () => {
    expect(
      inheritsSites(
        csharpProvider,
        'namespace P;\npublic record V : IValidator<string> { }',
        'V.cs',
      ),
    ).toEqual([{ name: 'IValidator', typeArguments: ['string'] }]);
  });

  it('C# record with a primary-constructor base', () => {
    // `Base<int>(x)` writes a CALL in the heritage position; the call is not
    // part of the type and must not stop the arguments being read.
    expect(
      inheritsSites(
        csharpProvider,
        'namespace P;\npublic record R(int x) : Base<int>(x) { }',
        'R.cs',
      ),
    ).toEqual([{ name: 'Base', typeArguments: ['int'] }]);
  });

  it('Java implements clause', () => {
    expect(
      inheritsSites(
        javaProvider,
        'package p;\npublic class V implements Validator<String> { }',
        'V.java',
      ),
    ).toEqual([{ name: 'Validator', typeArguments: ['String'] }]);
  });

  it('TypeScript implements clause', () => {
    expect(
      inheritsSites(typescriptProvider, 'export class V implements Validator<string> { }', 'v.ts'),
    ).toEqual([{ name: 'Validator', typeArguments: ['string'] }]);
  });

  it('Kotlin delegation specifier, with and without a constructor call', () => {
    expect(inheritsSites(kotlinProvider, 'class V : Validator<String>() { }', 'v.kt')).toEqual([
      { name: 'Validator', typeArguments: ['String'] },
    ]);
    expect(inheritsSites(kotlinProvider, 'class V : Validator<String> { }', 'v2.kt')).toEqual([
      { name: 'Validator', typeArguments: ['String'] },
    ]);
  });

  it('Go generic struct embedding (bracket application)', () => {
    expect(inheritsSites(goProvider, 'package p\ntype S struct { Base[int] }', 's.go')).toEqual([
      { name: 'Base', typeArguments: ['int'] },
    ]);
  });

  it('Python subscripted base (bracket application)', () => {
    expect(inheritsSites(pythonProvider, 'class Repo(Base[User]):\n    pass\n', 'r.py')).toEqual([
      { name: 'Base', typeArguments: ['User'] },
    ]);
  });

  it('Swift inheritance clause', () => {
    expect(inheritsSites(swiftProvider, 'class Repo: Base<User> { }', 'r.swift')).toEqual([
      { name: 'Base', typeArguments: ['User'] },
    ]);
  });
});

describe('emitters whose anchor is the bare name use the explicit sub-tag', () => {
  it('Rust trait impl', () => {
    // The anchor is the trait NAME node inside a `generic_type`, and its range
    // is part of the inheritance edge's id — so the arguments arrive through
    // `@reference.type-arguments` rather than by widening the anchor.
    expect(inheritsSites(rustProvider, 'impl Validator<String> for V { }', 'v.rs')).toEqual([
      { name: 'Validator', typeArguments: ['String'] },
    ]);
  });

  it('Rust trait impl without arguments records none', () => {
    expect(inheritsSites(rustProvider, 'impl Validator for V { }', 'v2.rs')).toEqual([
      { name: 'Validator', typeArguments: undefined },
    ]);
  });

  it('Dart extends clause', () => {
    expect(inheritsSites(dartProvider, 'class Repo extends Base<User> { }', 'r.dart')).toEqual([
      { name: 'Base', typeArguments: ['User'] },
    ]);
  });
});

describe('heritage that never becomes a reference site', () => {
  // Dart's `implements` / `with` travel as heritage MARKERS on parsed imports,
  // not as `inherits` sites: `emitDartHeritageEdges` reads the marker and emits
  // the edge, so the instantiation has to ride the payload to reach the same
  // sink the generic pre-pass writes to (#2912).
  function heritageMarkers(source: string, filePath: string): Array<string[]> {
    const parsed = extractParsedFile(dartProvider, source, filePath);
    return (parsed?.parsedImports ?? [])
      .map((imported) => decodeMarker(String(imported.targetRaw)))
      .filter(
        (marker): marker is { kind: 'heritage'; fields: string[] } => marker?.kind === 'heritage',
      )
      .map((marker) => marker.fields);
  }

  it('carries the arguments of a Dart `implements` clause', () => {
    expect(heritageMarkers('class V implements Validator<String> { }', 'v.dart')).toEqual([
      ['implements', 'Validator', 'V', '<String>'],
    ]);
  });

  it('carries the arguments of a Dart `with` clause', () => {
    expect(heritageMarkers('class V extends Base with M<int> { }', 'v2.dart')).toEqual([
      ['with', 'M', 'V', '<int>'],
    ]);
  });

  it('omits the field for a non-generic clause, so old payloads stay readable', () => {
    expect(heritageMarkers('class V implements Validator { }', 'v3.dart')).toEqual([
      ['implements', 'Validator', 'V'],
    ]);
  });
});

describe('non-generic heritage stays byte-identical', () => {
  it('records no arguments for a plain base', () => {
    expect(
      inheritsSites(csharpProvider, 'namespace P;\npublic class C : Base { }', 'C.cs'),
    ).toEqual([{ name: 'Base', typeArguments: undefined }]);
  });
});
