/**
 * Unit tests for the generic-instantiation matcher behind interface-dispatch
 * fan-out (#2912) and for the spelling reader that feeds it.
 *
 * The integration suite proves the filter reaches real graphs; these pin the
 * decisions the filter is MADE of, and above all the fail-open ones — an
 * unknown that starts pruning is a silently missing edge, which is the failure
 * mode this design is built to avoid.
 */
import { describe, it, expect } from 'vitest';
import {
  heritageTypeArgumentsKey,
  stepHeritageInstantiation,
  type HeritageInstantiationStep,
} from '../../../src/core/ingestion/scope-resolution/utils/generic-instantiation.js';
import { typeApplicationArguments } from '../../../src/core/ingestion/utils/template-arguments.js';
import { csharpScopeResolver } from '../../../src/core/ingestion/languages/csharp/scope-resolver.js';

/** A step with everything unresolvable and no parameters — the pessimistic
 *  baseline each test overrides only what it is about. */
function step(overrides: Partial<HeritageInstantiationStep>): HeritageInstantiationStep {
  return {
    supertypeArguments: undefined,
    heritageArguments: undefined,
    subtypeParameters: undefined,
    subtypeParametersComplete: true,
    resolveSupertypeArgument: () => ({ builtIn: false }),
    resolveHeritageArgument: () => ({ builtIn: false }),
    ...overrides,
  };
}

describe('stepHeritageInstantiation — pruning on positive evidence', () => {
  it('prunes an implementor of a different instantiation', () => {
    const result = stepHeritageInstantiation(
      step({ supertypeArguments: ['string'], heritageArguments: ['int'] }),
    );
    expect(result.compatible).toBe(false);
  });

  it('keeps an implementor of the same instantiation', () => {
    const result = stepHeritageInstantiation(
      step({ supertypeArguments: ['string'], heritageArguments: ['string'] }),
    );
    expect(result.compatible).toBe(true);
  });

  it('prunes on a difference in any position, not just the first', () => {
    const result = stepHeritageInstantiation(
      step({ supertypeArguments: ['string', 'User'], heritageArguments: ['string', 'Admin'] }),
    );
    expect(result.compatible).toBe(false);
  });

  it('compares what the names RESOLVED to, so a qualifier is not a difference', () => {
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['User'],
        heritageArguments: ['Models.User'],
        resolveSupertypeArgument: () => ({ definitionId: 'def:User', builtIn: false }),
        resolveHeritageArgument: () => ({ definitionId: 'def:User', builtIn: false }),
      }),
    );
    expect(result.compatible).toBe(true);
  });

  it('prunes two names that resolved to different declarations', () => {
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['User'],
        heritageArguments: ['Admin'],
        resolveSupertypeArgument: () => ({ definitionId: 'def:User', builtIn: false }),
        resolveHeritageArgument: () => ({ definitionId: 'def:Admin', builtIn: false }),
      }),
    );
    expect(result.compatible).toBe(false);
  });

  it('applies the language normalizer to both sides before comparing', () => {
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['string'],
        heritageArguments: ['String'],
        normalize: (name) => (name === 'string' ? 'String' : name),
      }),
    );
    expect(result.compatible).toBe(true);
  });

  it('keeps an unresolved qualified spelling of the same simple name', () => {
    const result = stepHeritageInstantiation(
      step({ supertypeArguments: ['String'], heritageArguments: ['java.lang.String'] }),
    );
    expect(result.compatible).toBe(true);
  });
});

describe('stepHeritageInstantiation — substitution', () => {
  it('binds a type variable instead of comparing it', () => {
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['string'],
        heritageArguments: ['T'],
        subtypeParameters: [{ name: 'T' }],
      }),
    );
    expect(result.compatible).toBe(true);
    expect(result.subtypeArguments).toEqual(['string']);
  });

  it('carries the binding in the subtype’s own parameter order', () => {
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['string', 'int'],
        heritageArguments: ['V', 'K'],
        subtypeParameters: [{ name: 'K' }, { name: 'V' }],
      }),
    );
    expect(result.subtypeArguments).toEqual(['int', 'string']);
  });

  it('reports an unknown instantiation when a parameter stayed unbound', () => {
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['string'],
        heritageArguments: ['T'],
        subtypeParameters: [{ name: 'T' }, { name: 'U' }],
      }),
    );
    expect(result.compatible).toBe(true);
    expect(result.subtypeArguments).toBeUndefined();
  });

  it('prunes a repeated variable the two positions disagree about', () => {
    // `class C<T> : Pair<T, T>` is not a `Pair<string, int>` at any
    // instantiation; the second position must not overwrite the first.
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['string', 'int'],
        heritageArguments: ['T', 'T'],
        subtypeParameters: [{ name: 'T' }],
        resolveSupertypeArgument: () => ({ builtIn: true }),
      }),
    );
    expect(result.compatible).toBe(false);
  });

  it('keeps a repeated variable both positions agree about', () => {
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['string', 'string'],
        heritageArguments: ['T', 'T'],
        subtypeParameters: [{ name: 'T' }],
      }),
    );
    expect(result.compatible).toBe(true);
    expect(result.subtypeArguments).toEqual(['string']);
  });

  it('keeps, without a binding, when a repeated variable cannot be decided', () => {
    // `ExternalA` and `ExternalB` are both unresolvable, so the disagreement is
    // not proven — and the binding the next hop would inherit is not either.
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['ExternalA', 'ExternalB'],
        heritageArguments: ['T', 'T'],
        subtypeParameters: [{ name: 'T' }],
      }),
    );
    expect(result.compatible).toBe(true);
    expect(result.subtypeArguments).toBeUndefined();
  });
});

describe('stepHeritageInstantiation — every uncertainty keeps the target', () => {
  it('keeps when the receiver instantiation is unknown', () => {
    const result = stepHeritageInstantiation(step({ heritageArguments: ['int'] }));
    expect(result.compatible).toBe(true);
  });

  it('keeps when the heritage clause recorded no arguments', () => {
    const result = stepHeritageInstantiation(step({ supertypeArguments: ['string'] }));
    expect(result.compatible).toBe(true);
  });

  it('keeps when the two argument lists have different lengths', () => {
    const result = stepHeritageInstantiation(
      step({ supertypeArguments: ['string'], heritageArguments: ['string', 'int'] }),
    );
    expect(result.compatible).toBe(true);
  });

  it('keeps a wildcard receiver argument, which names a SET of types', () => {
    // `Repo<? extends User>` genuinely holds a `Repo<User>`; so do Kotlin's
    // `Repo<*>` and `Repo<out User>`.
    for (const wildcard of ['? extends User', '?', '* ', 'out User', 'in User']) {
      const result = stepHeritageInstantiation(
        step({
          supertypeArguments: [wildcard],
          heritageArguments: ['User'],
          resolveSupertypeArgument: () => ({ builtIn: true }),
          resolveHeritageArgument: () => ({ definitionId: 'def:User', builtIn: false }),
        }),
      );
      expect(result.compatible).toBe(true);
    }
  });

  it('keeps a nullable spelling of the same argument', () => {
    const result = stepHeritageInstantiation(
      step({ supertypeArguments: ['User?'], heritageArguments: ['User'] }),
    );
    expect(result.compatible).toBe(true);
  });

  it('ignores whitespace when comparing nested spellings', () => {
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['Map<string, User>'],
        heritageArguments: ['Map<string,User>'],
      }),
    );
    expect(result.compatible).toBe(true);
  });

  it('keeps every implementor for a receiver typed with a CALLER type variable', () => {
    // `void Run<T>(IValidator<T> v) { v.Check(x); }`. `T` belongs to the calling
    // method, not to the subtype, so `subtypeParametersComplete` — which is
    // evidence about the SUBTYPE's list — says nothing about it. An unbounded
    // `T` grounds to nothing and a bounded one grounds to its BOUND; both would
    // otherwise compare unequal to the implementor's concrete argument.
    for (const receiverType of [
      { builtIn: false, typeVariable: true },
      { definitionId: 'def:User', builtIn: false, typeVariable: true },
    ]) {
      const result = stepHeritageInstantiation(
        step({
          supertypeArguments: ['T'],
          heritageArguments: ['Admin'],
          subtypeParametersComplete: true,
          resolveSupertypeArgument: () => receiverType,
          resolveHeritageArgument: () => ({ definitionId: 'def:Admin', builtIn: false }),
        }),
      );
      expect(result.compatible).toBe(true);
    }
  });

  it('keeps a heritage argument that is a type variable of an ENCLOSING declaration', () => {
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['string'],
        heritageArguments: ['T'],
        subtypeParametersComplete: true,
        resolveSupertypeArgument: () => ({ builtIn: true }),
        resolveHeritageArgument: () => ({ builtIn: false, typeVariable: true }),
      }),
    );
    expect(result.compatible).toBe(true);
  });

  it('keeps an unresolvable argument when the parameter list may be incomplete', () => {
    // The `T` of `class Box<T> : IValidator<T>` in a language that captures no
    // type parameters: indistinguishable from a concrete type named T, so it
    // must not be pruned on.
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['string'],
        heritageArguments: ['T'],
        subtypeParametersComplete: false,
      }),
    );
    expect(result.compatible).toBe(true);
  });

  it('prunes the same pair once BOTH names are grounded', () => {
    const result = stepHeritageInstantiation(
      step({
        supertypeArguments: ['string'],
        heritageArguments: ['int'],
        subtypeParametersComplete: false,
        resolveSupertypeArgument: () => ({ builtIn: true }),
        resolveHeritageArgument: () => ({ builtIn: true }),
      }),
    );
    expect(result.compatible).toBe(false);
  });
});

describe('heritageTypeArgumentsKey', () => {
  it('keeps a pair distinct from the same ids in the other order', () => {
    expect(heritageTypeArgumentsKey('a', 'b')).not.toBe(heritageTypeArgumentsKey('b', 'a'));
  });

  it('separates on a character a file path cannot contain', () => {
    // `Class:a b.cs:A` + `Class:c.cs:C` must not be spellable two ways.
    expect(heritageTypeArgumentsKey('Class:a b.cs:A', 'Class:c.cs:C')).not.toBe(
      heritageTypeArgumentsKey('Class:a', 'b.cs:A Class:c.cs:C'),
    );
  });
});

describe('typeApplicationArguments', () => {
  it('reads angle-bracket arguments', () => {
    expect(typeApplicationArguments('IValidator<string>')).toEqual(['string']);
  });

  it('reads bracket arguments (Go embedding, Python bases)', () => {
    expect(typeApplicationArguments('Base[User]')).toEqual(['User']);
  });

  it('splits only at top level', () => {
    expect(typeApplicationArguments('Map<string, List<int>>')).toEqual(['string', 'List<int>']);
    expect(typeApplicationArguments('Cache<Dict[str, int], bool>')).toEqual([
      'Dict[str, int]',
      'bool',
    ]);
  });

  it('declines a plain name, an array spelling, and a constructor call', () => {
    expect(typeApplicationArguments('Repository')).toBeUndefined();
    expect(typeApplicationArguments('User[]')).toBeUndefined();
    expect(typeApplicationArguments('Base(args)')).toBeUndefined();
  });

  it('declines a list that does not close at the end', () => {
    expect(typeApplicationArguments('Repo<User> by delegate')).toBeUndefined();
    expect(typeApplicationArguments('(Int) -> Unit')).toBeUndefined();
  });

  it('declines brackets that cross families', () => {
    // A one-family counter never sees the `]`, reaches the final `>` at depth
    // zero and reports `Bar]` as a balanced argument list.
    expect(typeApplicationArguments('Foo<Bar]>')).toBeUndefined();
    expect(typeApplicationArguments('Foo[Bar>]')).toBeUndefined();
    expect(typeApplicationArguments('Map<Dict[a, b>]')).toBeUndefined();
    // The well-formed mixed nesting it must NOT start declining.
    expect(typeApplicationArguments('List<Dict[a, b]>')).toEqual(['Dict[a, b]']);
  });
});

describe('C# normalizeTypeArgument', () => {
  const normalize = csharpScopeResolver.normalizeTypeArgument as (name: string) => string;

  it('makes every spelling of a predefined type one name', () => {
    // Including the `global::` alias qualifier, which this repository already
    // unwraps when decomposing imports.
    for (const spelling of ['string', 'String', 'System.String', 'global::System.String']) {
      expect(normalize(spelling)).toBe('String');
    }
    expect(normalize('int')).toBe('Int32');
  });

  it('leaves an unrelated qualified name as written', () => {
    expect(normalize('Foo.String')).toBe('Foo.String');
    expect(normalize('Models.User')).toBe('Models.User');
  });

  it('keeps the qualifier on an ordinary type that merely lives in System', () => {
    // Stripping `System.` unconditionally would answer `Custom` here, equating
    // this with an unrelated `Custom` elsewhere in the workspace. Only a
    // spelling that reduces to a PREDEFINED type earns the strip.
    expect(normalize('System.Custom')).toBe('System.Custom');
    expect(normalize('global::System.Custom')).toBe('global::System.Custom');
    expect(normalize('System.Collections.Generic.List')).toBe('System.Collections.Generic.List');
  });
});
