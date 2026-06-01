/**
 * Focused capture-synthesis test for the Swift qualified-base fix (#1951 review).
 *
 * `class Derived: Outer.Inner` inherits from the NESTED base `Inner`, not the
 * qualifier `Outer`. `swiftBaseTypeIdentifier` previously returned the FIRST
 * `type_identifier` of the flat `user_type` (`Outer`); it now returns the LAST
 * (`Inner`). This asserts the synthesized `@reference.inherits` site carries the
 * trailing segment, directly at the changed path — independent of downstream
 * resolution (a bare nested-type name does not resolve to an edge in the current
 * model, so the integration resolver test cannot observe it).
 */
import { describe, it, expect } from 'vitest';
import { emitSwiftScopeCaptures } from '../../../../src/core/ingestion/languages/swift/index.js';
import { isLanguageAvailable } from '../../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../../src/config/supported-languages.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

function inheritedBaseNames(src: string): string[] {
  return emitSwiftScopeCaptures(src, 'Probe.swift')
    .filter((m) => m['@reference.inherits'] !== undefined)
    .map((m) => m['@reference.name']?.text ?? '');
}

describe.skipIf(!swiftAvailable)('Swift qualified-base capture synthesis (#1951)', () => {
  it('extracts the trailing segment Inner from a qualified base Outer.Inner', () => {
    expect(inheritedBaseNames('class Derived: Outer.Inner {}\n')).toEqual(['Inner']);
  });

  it('extracts the trailing segment from a qualified generic base Outer.Inner<T>', () => {
    expect(inheritedBaseNames('class Derived: Outer.Inner<String> {}\n')).toEqual(['Inner']);
  });

  it('leaves a non-qualified base unchanged (no regression)', () => {
    expect(inheritedBaseNames('class Child: Parent {}\n')).toEqual(['Parent']);
  });

  it('leaves a non-qualified generic base unchanged (Box<Int> -> Box)', () => {
    expect(inheritedBaseNames('class Boxed: Box<Int> {}\n')).toEqual(['Box']);
  });
});
