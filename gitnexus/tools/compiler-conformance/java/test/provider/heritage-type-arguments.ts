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
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../../src/core/ingestion/scope-extractor-bridge.js';
import type { LanguageProvider } from '../../../../../src/core/ingestion/language-provider.js';
import { javaProvider } from '../../../../../src/core/ingestion/languages/java.js';

function inheritsSites(
  provider: LanguageProvider,
  source: string,
  filePath: string,
): Array<{ name: string; typeArguments?: readonly string[] }> {
  const parsed: ParsedFile | undefined = extractParsedFile(provider, source, filePath);
  return (parsed?.referenceSites ?? [])
    .filter((site) => site.kind === 'inherits')
    .map((site) => ({ name: site.name, typeArguments: site.typeArguments }));
}

describe('heritage type arguments are captured', () => {
  it('Java implements clause', () => {
    assert.deepEqual(
      inheritsSites(
        javaProvider,
        'package p;\npublic class V implements Validator<String> { }',
        'V.java',
      ),
      [{ name: 'Validator', typeArguments: ['String'] }],
    );
  });
});
