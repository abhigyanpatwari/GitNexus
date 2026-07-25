/**
 * #2687 — unit coverage for `buildNonValueDefinitionNameKeys`, the pre-scan that
 * makes the parse-worker's duplicate suppression order-independent.
 *
 * The parse-worker consults these keys from its value-label branch, so what this
 * pre-scan registers decides which `Const`/`Static`/`Variable` nodes get dropped.
 * The two guards that matter most: keys are name-qualified (a multi-name
 * declaration shares one definition node), and a match resolving to a value label
 * registers nothing (so a match can never suppress itself).
 */
import { describe, expect, it } from 'vitest';
import type { LanguageProvider } from '../../../src/core/ingestion/language-provider.js';
import {
  buildDefinitionPreScan,
  type SyntaxNode,
} from '../../../src/core/ingestion/utils/ast-helpers.js';

/** Minimal stub — the pre-scan only reads `startIndex` and `text`. */
const node = (startIndex: number, text: string): SyntaxNode =>
  ({ startIndex, text }) as unknown as SyntaxNode;

const match = (captures: Record<string, SyntaxNode>) => ({
  captures: Object.entries(captures).map(([name, syntaxNode]) => ({ name, node: syntaxNode })),
});

/** `getLabelFromCaptures` only reaches for `labelOverride`; nothing else. */
const PROVIDER = {} as unknown as LanguageProvider;

/** The non-value claim set — what `Const`/`Static`/`Variable` consult. */
const nonValueOf = (
  matches: Parameters<typeof buildDefinitionPreScan>[0],
  provider: LanguageProvider,
): ReadonlySet<string> => buildDefinitionPreScan(matches, provider).nonValue;

describe('buildDefinitionPreScan', () => {
  it('registers a function capture under its startIndex and name', () => {
    const keys = nonValueOf(
      [match({ 'definition.function': node(0, 'const Bare = () => 1;'), name: node(6, 'Bare') })],
      PROVIDER,
    );

    expect([...keys]).toEqual(['0:Bare']);
  });

  it('registers nothing for a value capture', () => {
    const keys = nonValueOf(
      [match({ 'definition.const': node(0, 'const CONFIG = {};'), name: node(6, 'CONFIG') })],
      PROVIDER,
    );

    expect([...keys]).toEqual([]);
  });

  it('registers nothing for a match with no name capture', () => {
    const keys = nonValueOf([match({ 'definition.function': node(0, '() => 1') })], PROVIDER);

    expect([...keys]).toEqual([]);
  });

  it('registers nothing for a match with no definition capture', () => {
    const keys = nonValueOf([match({ name: node(0, 'orphan') })], PROVIDER);

    expect([...keys]).toEqual([]);
  });

  it('keys by name so a shared definition node does not over-suppress', () => {
    // `const a = 1, b = () => {}` — both declarators share ONE definition node,
    // so only `b`'s name may be claimed.
    const declaration = node(0, 'const a = 1, b = () => {}');
    const keys = nonValueOf(
      [
        match({ 'definition.const': declaration, name: node(6, 'a') }),
        match({ 'definition.function': declaration, name: node(13, 'b') }),
      ],
      PROVIDER,
    );

    expect([...keys]).toEqual(['0:b']);
  });

  it('registers nothing when a provider reclassifies a function capture to a value label', () => {
    // Guards against self-suppression: if the pre-scan keyed off capture names
    // rather than the resolved label, this match would register a key and then
    // the main loop's value branch would drop its own node.
    const provider = {
      labelOverride: () => 'Const',
    } as unknown as LanguageProvider;

    const keys = nonValueOf(
      [match({ 'definition.function': node(0, 'val x = {}'), name: node(4, 'x') })],
      provider,
    );

    expect([...keys]).toEqual([]);
  });

  it('returns an empty set for no matches', () => {
    expect([...nonValueOf([], PROVIDER)]).toEqual([]);
  });

  it('ranks a property claim as non-value but NOT callable', () => {
    // The rank split is what keeps an annotated Python attribute ahead of its
    // bare-assignment `Variable` twin while still letting a callable collapse a
    // Kotlin/Swift closure property. A property in `callable` would make a
    // property suppress itself.
    const claims = buildDefinitionPreScan(
      [match({ 'definition.property': node(0, 'name: str = "x"'), name: node(0, 'name') })],
      PROVIDER,
    );

    expect({ nonValue: [...claims.nonValue], callable: [...claims.callable] }).toEqual({
      nonValue: ['0:name'],
      callable: [],
    });
  });

  it('ranks a callable claim into both sets', () => {
    const claims = buildDefinitionPreScan(
      [match({ 'definition.function': node(0, 'val f = { }'), name: node(4, 'f') })],
      PROVIDER,
    );

    expect({ nonValue: [...claims.nonValue], callable: [...claims.callable] }).toEqual({
      nonValue: ['0:f'],
      callable: ['0:f'],
    });
  });
});
