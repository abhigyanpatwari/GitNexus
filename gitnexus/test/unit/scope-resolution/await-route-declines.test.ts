/**
 * The `await` route of `elementTypeOf` is answered by exactly one language.
 *
 * The receiver fold's `await` step and the two chain follows consult the
 * route FIRST (`compound-receiver.ts`, `type-ref-chain.ts`), and
 * `classOfDeclaredType` / the simple-binding owner lookup refuse to bind a
 * spelling the route can unwrap (an awaitable wrapper never names an owner).
 * Every other language strips its wrapper at capture time (TypeScript
 * `Promise<X>`, C# `Task<X>`), so for them the route must decline on every
 * spelling, which keeps the fold's identity behaviour and the owner lookups
 * byte-for-byte what they were. This pins that decline on both sides of the
 * contract — the parse-side `LanguageProvider` and the `ScopeResolver` — so a
 * provider that later answers the route does so on purpose, with its own
 * whole-wrapper bindings and tests, not by accident of a shared helper.
 */
import { describe, it, expect } from 'vitest';
import { providers } from '../../../src/core/ingestion/languages/index.js';
import { SCOPE_RESOLVERS } from '../../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const WRAPPER_SPELLINGS = [
  'Future<User>',
  'FutureOr<User>',
  'Promise<User>',
  'Task<User>',
  'User',
  'List<User>',
  'models.User',
] as const;

describe('elementTypeOf await route: only Dart answers it', () => {
  it('Dart unwraps Future<T> / FutureOr<T> on both the provider and the resolver', () => {
    const provider = providers[SupportedLanguages.Dart];
    const resolver = SCOPE_RESOLVERS.get(SupportedLanguages.Dart);
    expect(provider.elementTypeOf?.('Future<User>', { kind: 'await' })).toBe('User');
    expect(resolver?.elementTypeOf?.('FutureOr<User>', { kind: 'await' })).toBe('User');
    expect(resolver?.elementTypeOf?.('User', { kind: 'await' })).toBeUndefined();
    expect(resolver?.elementTypeOf?.('List<User>', { kind: 'await' })).toBeUndefined();
  });

  const others = (Object.keys(providers) as SupportedLanguages[]).filter(
    (lang) => lang !== SupportedLanguages.Dart,
  );

  it.each(others)('%s provider declines the await route on every spelling', (lang) => {
    const provider = providers[lang];
    for (const spelling of WRAPPER_SPELLINGS) {
      expect(provider.elementTypeOf?.(spelling, { kind: 'await' }), spelling).toBeUndefined();
    }
  });

  it.each([...SCOPE_RESOLVERS.keys()].filter((lang) => lang !== SupportedLanguages.Dart))(
    '%s scope resolver declines the await route on every spelling',
    (lang) => {
      const resolver = SCOPE_RESOLVERS.get(lang);
      for (const spelling of WRAPPER_SPELLINGS) {
        expect(resolver?.elementTypeOf?.(spelling, { kind: 'await' }), spelling).toBeUndefined();
      }
    },
  );
});
