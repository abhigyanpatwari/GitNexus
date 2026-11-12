/**
 * An AWAITED call-result binding (`final x = await fetch()`, `TypeRef.awaited`)
 * takes what the followed return type yields under `await`, through the
 * language's `elementTypeOf` route `{ kind: 'await' }` — at both chain follows:
 * the scope extractor's (`followChainedRef`, same file) and the post-finalize
 * one (`followChainPostFinalize`, cross-file / namespace callee).
 *
 * Two halves, each with its control:
 *   - a provider that ANSWERS the route: `x` → `C`, and the flag is cleared;
 *   - a provider WITHOUT the route (or one that answers `undefined`): the
 *     follow is byte-for-byte what it was — `x` keeps the callee's return type
 *     `Future<C>` and keeps its flag for a later follow to answer.
 *   - a binding that is NOT awaited never consults the route, even when the
 *     provider has one.
 *
 * Only the first followed step is the await hop (callee → awaited result), so
 * a chain that continues past it is not unwrapped twice.
 */
import { describe, it, expect } from 'vitest';
import type {
  Capture,
  CaptureMatch,
  ParsedTypeBinding,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import type { ScopeExtractorHooks } from '../../../src/core/ingestion/scope-extractor.js';
import {
  followChainPostFinalize,
  qualifiedYieldAt,
} from '../../../src/core/ingestion/scope-resolution/passes/imported-return-types.js';
import {
  followedStep,
  type AwaitedFollow,
} from '../../../src/core/ingestion/utils/type-ref-chain.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { ElementAccessRoute } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';

/** A stub language whose only container is `Future<T>`, awaitable to `T`. */
const awaitRoute = (containerType: string, via: ElementAccessRoute): string | undefined => {
  if (via.kind !== 'await') return undefined;
  const m = /^Future<(.+)>$/.exec(containerType.trim());
  return m === null ? undefined : m[1]!.trim();
};

// ── followedStep ────────────────────────────────────────────────────────────

const awaitedTypeOf = (t: string): string | undefined => awaitRoute(t, { kind: 'await' });
const awaited: AwaitedFollow = { yields: awaitedTypeOf };
const ref = (rawName: string, extra: Partial<TypeRef> = {}): TypeRef =>
  ({
    rawName,
    declaredAtScope: 'scope:m' as ScopeId,
    source: 'constructor-inferred',
    ...extra,
  }) as TypeRef;

describe('followedStep — the await hop of an awaited binding', () => {
  it('takes what the reached type yields under await and clears the flag', () => {
    const out = followedStep(ref('make', { awaited: true }), ref('Future<C>'), awaited);
    expect(out.rawName).toBe('C');
    expect(out.awaited).toBeUndefined();
    expect(out.declaredSpelling).toBeUndefined();
  });

  it('keeps the plain step and the flag when the language declines (non-awaitable)', () => {
    const out = followedStep(ref('make', { awaited: true }), ref('User'), awaited);
    expect(out.rawName).toBe('User');
    expect(out.awaited).toBe(true);
  });

  it('does not step at all without a route — the callee stays for a later follow', () => {
    const start = ref('make', { awaited: true });
    expect(followedStep(start, ref('Future<C>'))).toBe(start);
  });

  it('a QUALIFIED yield is taken only through the producer-scope resolver, re-anchored', () => {
    const resolveQualified = (spelling: string, producerScope: ScopeId) =>
      spelling === 'models.User' && producerScope === ('scope:producer' as ScopeId)
        ? { rawName: 'User', declaredAtScope: 'scope:models' as ScopeId }
        : undefined;
    const out = followedStep(
      ref('fetch', { awaited: true }),
      ref('Future<models.User>', { declaredAtScope: 'scope:producer' as ScopeId }),
      { yields: awaitedTypeOf, resolveQualified },
    );
    expect(out.rawName).toBe('User');
    expect(out.declaredAtScope).toBe('scope:models');
    expect(out.awaited).toBeUndefined();
  });

  it('a QUALIFIED yield with no resolver (the extractor) or a declining one leaves the binding untouched', () => {
    // Stepping onto `Future<models.User>` would lose the callee the
    // post-finalize follow needs to redo the hop with the producer's import.
    for (const follow of [awaited, { yields: awaitedTypeOf, resolveQualified: () => undefined }]) {
      const start = ref('fetch', { awaited: true });
      expect(followedStep(start, ref('Future<models.User>'), follow)).toBe(start);
    }
  });

  it('never consults the route for a binding that is not awaited', () => {
    const out = followedStep(ref('make'), ref('Future<C>'), { yields: () => 'WRONG' });
    expect(out.rawName).toBe('Future<C>');
  });
});

// ── post-finalize follow (cross-file / namespace callee) ────────────────────

const MODULE = 'scope:m:module' as ScopeId;
function indexes(moduleTypeBindings: Map<string, TypeRef>): ScopeResolutionIndexes {
  const moduleScope = {
    id: MODULE,
    kind: 'Module',
    parent: null,
    filePath: 'm.dart',
    range: { startLine: 1, startColumn: 0, endLine: 99, endColumn: 0 },
    bindings: new Map(),
    imports: [],
    ownedDefs: [],
    typeBindings: moduleTypeBindings,
  } as unknown as Scope;
  return {
    scopeTree: {
      getScope: (id: ScopeId) => (id === MODULE ? moduleScope : undefined),
    } as unknown as ScopeTree,
    bindings: new Map(),
    imports: new Map(),
    bindingAugmentations: new Map(),
    workspaceFqnBindings: new Map(),
    workspaceTypeBindings: new Map(),
    namespaceFqnBindings: new Map(),
    namespaceTypeBindings: new Map(),
    accessibleNamespacesByScope: new Map(),
  } as unknown as ScopeResolutionIndexes;
}
const moduleRef = (rawName: string, extra: Partial<TypeRef> = {}): TypeRef =>
  ({ rawName, declaredAtScope: MODULE, source: 'return-annotation', ...extra }) as TypeRef;

describe('followChainPostFinalize — awaited binding', () => {
  const returns = () => indexes(new Map([['make', moduleRef('Future<C>')]]));

  it('unwraps the followed return type when the provider answers the await route', () => {
    const out = followChainPostFinalize(
      moduleRef('make', { awaited: true, source: 'constructor-inferred' }),
      MODULE,
      returns(),
      undefined,
      awaited,
    );
    expect(out.rawName).toBe('C');
    expect(out.awaited).toBeUndefined();
  });

  it('leaves an awaited binding on its callee for a provider without the route', () => {
    const start = moduleRef('make', { awaited: true, source: 'constructor-inferred' });
    expect(followChainPostFinalize(start, MODULE, returns())).toBe(start);
  });

  it('declines a qualified yield whose prefix the producer scope cannot resolve', () => {
    // No namespace import binds `models` anywhere in these indexes, so the
    // resolver answers nothing and the follow leaves the wrapper in place.
    const idx = indexes(new Map([['fetch', moduleRef('Future<models.User>')]]));
    expect(qualifiedYieldAt('models.User', MODULE, idx)).toBeUndefined();
    const out = followChainPostFinalize(
      moduleRef('fetch', { awaited: true, source: 'constructor-inferred' }),
      MODULE,
      idx,
      undefined,
      {
        yields: awaitedTypeOf,
        resolveQualified: (spelling, scope) => qualifiedYieldAt(spelling, scope, idx),
      },
    );
    expect(out.rawName).toBe('fetch');
    expect(out.awaited).toBe(true);
  });

  it('is unchanged for a binding that is not awaited', () => {
    const out = followChainPostFinalize(
      moduleRef('make', { source: 'constructor-inferred' }),
      MODULE,
      returns(),
      undefined,
      awaited,
    );
    expect(out.rawName).toBe('Future<C>');
  });
});

// ── extractor follow (same-file callee), through hand-built captures ────────

const cap = (
  name: string,
  line: number,
  startCol: number,
  endCol: number,
  text: string,
  endLine = line,
): Capture => ({ name, range: { startLine: line, startCol, endLine, endCol }, text });

/** `Future<C> make() {…}` on line 1; `final x = await make();` on line 2. */
const CAPTURES: readonly CaptureMatch[] = [
  { '@scope.module': cap('@scope.module', 1, 0, 0, '', 4) },
  {
    '@type-binding.return': cap('@type-binding.return', 1, 0, 30, ''),
    '@type-binding.name': cap('@type-binding.name', 1, 10, 14, 'make'),
    '@type-binding.type': cap('@type-binding.type', 1, 0, 9, 'Future<C>'),
  },
  {
    '@type-binding.constructor': cap('@type-binding.constructor', 2, 0, 24, ''),
    '@type-binding.awaited': cap('@type-binding.awaited', 2, 0, 24, 'true'),
    '@type-binding.name': cap('@type-binding.name', 2, 6, 7, 'x'),
    '@type-binding.type': cap('@type-binding.type', 2, 16, 20, 'make'),
  },
];

const interpretTypeBinding = (match: CaptureMatch): ParsedTypeBinding | null => {
  const name = match['@type-binding.name'];
  const type = match['@type-binding.type'];
  if (name === undefined || type === undefined) return null;
  return {
    boundName: name.text,
    rawTypeName: type.text,
    source:
      match['@type-binding.return'] !== undefined ? 'return-annotation' : 'constructor-inferred',
  };
};

function xBinding(hooks: ScopeExtractorHooks): TypeRef | undefined {
  const parsed = extract(CAPTURES, 'lib/a.x', hooks);
  const module = parsed.scopes.find((scope) => scope.kind === 'Module');
  return module?.typeBindings.get('x');
}

describe('scope extractor chain follow — awaited binding', () => {
  it('types the awaited result through the provider route', () => {
    const x = xBinding({ interpretTypeBinding, elementTypeOf: awaitRoute });
    expect(x?.rawName).toBe('C');
    expect(x?.awaited).toBeUndefined();
  });

  it('leaves the binding on its callee for a provider without the route (flag kept)', () => {
    const x = xBinding({ interpretTypeBinding });
    expect(x?.rawName).toBe('make');
    expect(x?.awaited).toBe(true);
  });
});
