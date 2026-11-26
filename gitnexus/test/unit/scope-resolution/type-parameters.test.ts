/**
 * `parseTypeParameterList` — the shared reader behind
 * `SymbolDefinition.typeParameters` (#2833).
 *
 * ── WHAT THIS FILE PINS ───────────────────────────────────────────────────────
 *
 * The DECLARED type-parameter list was captured nowhere before this. Three
 * separate defects traced back to that one absence, and the first block below
 * pins the parse that supplies it while the second pins the fact it unblocks.
 *
 * The parser is deliberately language-NEUTRAL (AGENTS.md R6): it recognizes
 * tokens, not languages, and every token it recognizes it recognizes for all
 * input. So the spellings are asserted together, in one table, rather than
 * per-language — a rule that only fires for one language's spelling would be a
 * language name in shared code wearing a disguise.
 *
 * ── THE C++ SPECIALIZATION DISCRIMINATOR (Gap A) ──────────────────────────────
 *
 * The second block pins the fact rather than an algorithm. Before this work a
 * full specialization `template <> struct Vec<T*>` and a partial
 * `template <class T> struct Vec<T*>` were BYTE-IDENTICAL to the resolver —
 * both carried `templateArguments: ['T*']` and nothing else — so no partial
 * specialization rule could be written at all, correct or otherwise. They are
 * now three distinguishable shapes. Partial ORDERING ("most specialized wins"
 * across several partials) is a real algorithm and is deliberately NOT
 * implemented here; this pins the input it would need, so that whoever writes it
 * finds the discriminator already load-bearing and gets a failure rather than a
 * silent regression if a capture change takes it away again.
 */
import { describe, it, expect } from 'vitest';
import { parseTypeParameterList } from '../../../src/core/ingestion/utils/type-parameters.js';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { cppProvider } from '../../../src/core/ingestion/languages/c-cpp.js';
import type { SymbolDefinition } from 'gitnexus-shared';

describe('parseTypeParameterList', () => {
  it.each([
    // spelling                              expected
    ['<T>', [{ name: 'T' }]],
    ['<T, U>', [{ name: 'T' }, { name: 'U' }]],
    // `extends` (TypeScript, Java) and `:` (Kotlin, Rust) both introduce a bound.
    ['<T extends Repo>', [{ name: 'T', bound: 'Repo' }]],
    ['<T : Repo>', [{ name: 'T', bound: 'Repo' }]],
    // The name is the LAST identifier before the bound, which is what makes a
    // keyword prefix, a variance annotation and a bare name one rule.
    ['<class T>', [{ name: 'T' }]],
    ['<typename T>', [{ name: 'T' }]],
    ['<out T>', [{ name: 'T' }]],
    ['<in T>', [{ name: 'T' }]],
    ['<reified T : Repo>', [{ name: 'T', bound: 'Repo' }]],
    ['<class... Ts>', [{ name: 'Ts' }]],
    // A default is neither name nor bound.
    ['<class T = int>', [{ name: 'T' }]],
    ['<T extends Repo = DefaultRepo>', [{ name: 'T', bound: 'Repo' }]],
    // Commas inside a bound are not entry separators.
    ['<T extends Map<K, V>, K>', [{ name: 'T', bound: 'Map<K, V>' }, { name: 'K' }]],
    // An intersection bound is kept VERBATIM — splitting it is the consumer's
    // decision, and `soleBoundBaseName` declines on it rather than guessing.
    ['<T extends Repo & Closeable>', [{ name: 'T', bound: 'Repo & Closeable' }]],
    // A capture that spans the `template` keyword parses like a bare list.
    ['template <class T>', [{ name: 'T' }]],
  ])('parses %s', (text, expected) => {
    expect(parseTypeParameterList(text)).toEqual(expected);
  });

  it.each([
    ['a non-generic declaration has no list', 'Plain'],
    ['an EMPTY list is not a parameter list — this is a C++ FULL specialization', '<>'],
    ['an unbalanced list yields nothing rather than a partial read', '<T'],
    // Go declares parameters in SQUARE brackets and is served by its own
    // main-thread reader; accepting `[…]` here would read `int[]` as a list.
    ['square brackets are deliberately not a parameter list', '[T any]'],
  ])('returns undefined when %s', (_why, text) => {
    expect(parseTypeParameterList(text)).toBeUndefined();
  });

  it('declines a Rust lifetime rather than inventing a name for it', () => {
    // `'a` declares nothing a member lookup can be performed on. The sibling
    // type parameter in the same list still parses.
    expect(parseTypeParameterList("<'a, T: Repo>")).toEqual([{ name: 'T', bound: 'Repo' }]);
  });
});

describe('C++ specialization discriminator (#2833 Gap A input)', () => {
  const SOURCE = `template <class T> struct Vec { T* data; };
template <> struct Vec<bool> { int bits; };
template <class T> struct Vec<T*> { T* p; };
`;

  /** The distinct `Vec` shapes, deduped by def id — the C++ query matches a
   *  templated struct through both its standalone and its `template_declaration`
   *  pattern, so each declaration mints two defs under one id. */
  function vecShapes(): { templateArguments?: string[]; typeParameters?: unknown }[] {
    const parsed = extractParsedFile(cppProvider, SOURCE, 'vec.cpp');
    expect(parsed).toBeDefined();
    const byId = new Map<string, SymbolDefinition>();
    for (const def of parsed!.localDefs) {
      if (def.qualifiedName === 'Vec' && !byId.has(def.nodeId)) byId.set(def.nodeId, def);
    }
    return [...byId.values()].map((def) => ({
      templateArguments: def.templateArguments,
      typeParameters: def.typeParameters,
    }));
  }

  it('tells the primary, the full specialization and the partial apart', () => {
    expect(vecShapes()).toEqual([
      // PRIMARY — written against its parameters, pins no arguments.
      { templateArguments: undefined, typeParameters: [{ name: 'T' }] },
      // FULL specialization — pins arguments, declares NO parameters (`template <>`).
      { templateArguments: ['bool'], typeParameters: undefined },
      // PARTIAL specialization — pins arguments AND declares a parameter. This
      // row is the one that did not exist before #2833: without
      // `typeParameters` it was byte-identical to the full specialization.
      { templateArguments: ['T*'], typeParameters: [{ name: 'T' }] },
    ]);
  });

  it('gives both twins of one declaration the same parameters, whichever wins', () => {
    // `buildDefIndex` is first-write-wins, so if only the `template_declaration`
    // twin carried the parameters, match ORDER would decide whether a templated
    // struct remembers them. The extractor backfills across the twins precisely
    // so this assertion cannot depend on that order.
    const parsed = extractParsedFile(cppProvider, SOURCE, 'vec.cpp');
    const primaries = parsed!.localDefs.filter(
      (def) => def.qualifiedName === 'Vec' && def.templateArguments === undefined,
    );
    expect(primaries.length).toBeGreaterThan(1);
    for (const twin of primaries) expect(twin.typeParameters).toEqual([{ name: 'T' }]);
  });
});
