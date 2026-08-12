/**
 * `ReferenceSite.typeArguments` on heritage sites, across languages (#2912).
 *
 * The arguments are read GENERICALLY, from the spelling each emitter already
 * anchors `@reference.inherits` on — no language query was changed, so what a
 * language gets depends only on how much of the base its anchor spans. These
 * tests pin that per language, in both directions:
 *
 *   - the languages that DO get them, because interface-dispatch instantiation
 *     filtering silently reverts to the old fan-out if a capture stops
 *     reaching the anchor text;
 *   - the languages that DON'T, because the absence is the fail-open contract
 *     ("unknown"), not a bug to be papered over with a guess.
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

describe('languages whose anchor is the bare name record nothing', () => {
  it('Rust trait impl', () => {
    // The `@reference.inherits` anchor is the trait NAME node, so there is no
    // spelling to read arguments from. Absent ⇒ unknown ⇒ unfiltered fan-out.
    expect(inheritsSites(rustProvider, 'impl Validator<String> for V { }', 'v.rs')).toEqual([
      { name: 'Validator', typeArguments: undefined },
    ]);
  });

  it('Dart extends clause', () => {
    expect(inheritsSites(dartProvider, 'class Repo extends Base<User> { }', 'r.dart')).toEqual([
      { name: 'Base', typeArguments: undefined },
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
