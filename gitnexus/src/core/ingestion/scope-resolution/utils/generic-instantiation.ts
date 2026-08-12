/**
 * Generic-instantiation compatibility for interface-dispatch fan-out (#2912).
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 *
 * Heritage edges are stored between DECLARATIONS, and a declaration answers for
 * every instantiation of itself: `class UserValidator : IValidator<string>` and
 * `class IntValidator : IValidator<int>` both land in `IValidator`'s subtype
 * list, indistinguishable once the arguments are erased. A call through an
 * `IValidator<string>` receiver then fans out to `IntValidator.Check(int)` — a
 * target no runtime dispatch can produce, because the two instantiations are
 * unrelated types.
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────
 *
 * The subtype closure is walked carrying a SUBSTITUTION, exactly as a type
 * checker would. Each hop takes the arguments the supertype is currently known
 * to be instantiated with and the arguments the subtype WROTE on that supertype,
 * and unifies them positionally:
 *
 *   receiver `IValidator<string>`                        → super args ['string']
 *     `UserValidator : IValidator<string>`  ['string'] ≡ ['string']  → keep
 *     `IntValidator  : IValidator<int>`     ['int']     ✗             → prune
 *     `Wrapper<T>    : IValidator<T>`       ['T'] binds T = string   → keep,
 *          and the next hop sees `Wrapper` instantiated with ['string'], so
 *          `IntWrapper : Wrapper<int>` prunes and `StrWrapper : Wrapper<string>`
 *          survives.
 *
 * ── WHY EVERY UNCERTAINTY FAILS OPEN ─────────────────────────────────────────
 *
 * Dispatch fan-out is an over-approximation by design: a missing edge is a
 * silently wrong answer to "what can this call reach", while a surplus edge is
 * the pre-existing, documented imprecision. So this only ever prunes on POSITIVE
 * evidence that two instantiations differ, and returns `compatible` for every
 * shape it cannot decide — unknown arguments on either side, an arity it cannot
 * line up, or an argument that might be a type variable this pipeline did not
 * capture. `SymbolDefinition.typeParameters` and `ReferenceSite.typeArguments`
 * are both absent for languages whose captures do not populate them, and absence
 * means "unknown", never "not generic"; a language that captures neither is
 * therefore left with exactly the pre-#2912 fan-out.
 *
 * That is also why the arguments are RESOLVED rather than string-compared. Two
 * spellings that differ are only certainly different types when both bind to
 * something this pipeline can see — an imported `User` and a `Models.User` are
 * one type, and a lone `T` may be a type variable the capture layer never
 * recorded. The caller supplies the evidence (scope lookup + built-in names);
 * anything it cannot ground keeps the target.
 */

import type { TypeParameter } from 'gitnexus-shared';

/**
 * What a written type argument turned out to name, as far as the pipeline can
 * tell from where it was written.
 *
 * A spelling is GROUNDED when either field answers: it bound to a declaration,
 * or the language calls the name built in. Two grounded arguments that are not
 * the same type are the only evidence that licenses a prune. An ungrounded
 * spelling is `unknown` — it may be an external type, but it may equally be a
 * TYPE VARIABLE in a language whose captures do not record type parameters, and
 * pruning on that would delete `class Box<T> : IValidator<T>` from every
 * instantiation's fan-out.
 */
export interface GroundedTypeArgument {
  /** Identity of the declaration this spelling bound to, when it bound to one.
   *  Comparing identities rather than spellings is what makes `Models.User` and
   *  an imported `User` one type. */
  readonly definitionId?: string;
  /** The language declares this name built in (`string`, `int`). */
  readonly builtIn: boolean;
}

/** Resolve a written type argument from the scope it was written in. */
export type TypeArgumentResolver = (name: string) => GroundedTypeArgument;

/**
 * Generic arguments written on a heritage clause, keyed by the GRAPH-ID pair of
 * the edge they were written on — see {@link heritageTypeArgumentsKey}.
 *
 * Graph ids rather than def ids because that is the identity the heritage edge
 * itself carries, and because same-file partial declarations share one node: a
 * base listed on any part is the base of the whole type. Absent for every
 * non-generic base, for every language whose captures do not record arguments,
 * and for heritage that never passes through the inheritance pre-pass (Ruby's
 * `include`, Go's structural implements) — all of which read as "unknown".
 */
export type HeritageTypeArguments = ReadonlyMap<string, readonly string[]>;

/** Key for {@link HeritageTypeArguments}. NUL-separated because a graph id
 *  embeds a file path, and a path may legally contain every other separator a
 *  reader would reach for first — `:`, `|`, even a space. */
export function heritageTypeArgumentsKey(subtypeGraphId: string, supertypeGraphId: string): string {
  return `${subtypeGraphId}\u0000${supertypeGraphId}`;
}

/** One hop of the subtype closure, expressed as a substitution problem. */
export interface HeritageInstantiationStep {
  /**
   * Arguments the SUPERTYPE is currently known to be instantiated with, in
   * declaration order — `['string']` for a receiver typed `IValidator<string>`.
   * `undefined` when the instantiation is unknown, which keeps every subtype.
   */
  readonly supertypeArguments: readonly string[] | undefined;
  /**
   * Arguments the SUBTYPE wrote on the supertype in its own heritage clause —
   * `['string']` for `: IValidator<string>`, `['T']` for `: IValidator<T>`.
   * `undefined` when the subtype named the supertype without arguments, or when
   * the language's captures did not record them.
   */
  readonly heritageArguments: readonly string[] | undefined;
  /** The SUBTYPE's own declared type parameters, in declaration order. */
  readonly subtypeParameters: readonly TypeParameter[] | undefined;
  /**
   * Does an EMPTY `subtypeParameters` mean "this declaration is not generic"?
   *
   * The distinction decides whether an unresolvable argument may be pruned on.
   * `SymbolDefinition.typeParameters` is absent both for a plain `class C :
   * IValidator<string>` and for every declaration in a language whose captures
   * record no parameters at all — and the two demand opposite answers, because
   * in the second case the `T` of `class Box<T> : IValidator<T>` is also absent
   * and would be read as a concrete type named "T".
   *
   * True when the caller has evidence the parameters ARE recorded: this
   * declaration itself lists some, or some declaration in the same language run
   * does. False leaves an unresolvable argument unusable as evidence, which is
   * the pre-#2912 fan-out for that language.
   */
  readonly subtypeParametersComplete: boolean;
  /** Ground a supertype argument — resolved from the RECEIVER's scope. */
  readonly resolveSupertypeArgument: TypeArgumentResolver;
  /** Ground a heritage argument — resolved from where the HERITAGE was written,
   *  a different scope from the call site and usually a different file. */
  readonly resolveHeritageArgument: TypeArgumentResolver;
  /** Optional language normalization applied to both sides before they are
   *  compared, for aliases that denote one type (C# `string` / `String`). */
  readonly normalize?: (name: string) => string;
}

export interface HeritageInstantiationResult {
  /** False ONLY when the two instantiations are provably different types. */
  readonly compatible: boolean;
  /**
   * What the SUBTYPE is instantiated with, for the next hop of the walk:
   * its own type parameters resolved through this step's bindings. `undefined`
   * whenever any parameter stayed unbound — a partially known list would have to
   * be tracked per slot, and the whole-list unknown is the fail-open reading.
   */
  readonly subtypeArguments: readonly string[] | undefined;
}

const UNKNOWN: HeritageInstantiationResult = { compatible: true, subtypeArguments: undefined };

/** A resolved declaration, or a name the language calls built in. Anything else
 *  might be a type variable nobody captured. */
function grounded(type: GroundedTypeArgument): boolean {
  return type.definitionId !== undefined || type.builtIn;
}

/** Last segment of a qualified spelling: `java.lang.String` → `String`,
 *  `System::Text::Encoding` → `Encoding`. Used only when a name did not
 *  resolve, so the qualifier is exactly the part nothing can check. */
function simpleName(name: string): string {
  const cut = Math.max(name.lastIndexOf('.'), name.lastIndexOf(':'));
  return cut === -1 ? name : name.slice(cut + 1);
}

/**
 * Unify one heritage hop and carry the substitution to the subtype.
 *
 * Pure and total: no lookups of its own, no throwing, and every branch it cannot
 * decide answers {@link UNKNOWN} — compatible, with an unknown instantiation.
 */
export function stepHeritageInstantiation(
  step: HeritageInstantiationStep,
): HeritageInstantiationResult {
  const { supertypeArguments, heritageArguments, subtypeParameters } = step;
  if (supertypeArguments === undefined || heritageArguments === undefined) return UNKNOWN;
  // An arity that does not line up means one of the two lists is not what this
  // code thinks it is (a spelling the argument splitter read differently, a
  // partial specialization, a variadic parameter pack). Nothing positive can be
  // concluded from a mismatched pairing, so nothing is.
  if (supertypeArguments.length !== heritageArguments.length) return UNKNOWN;

  const normalize = step.normalize ?? ((name: string) => name);
  const bindings = new Map<string, string>();
  for (let i = 0; i < heritageArguments.length; i++) {
    const written = heritageArguments[i] as string;
    const actual = supertypeArguments[i] as string;
    // A type VARIABLE of the subtype binds rather than compares: `Wrapper<T> :
    // IValidator<T>` under an `IValidator<string>` receiver means T = string.
    if (subtypeParameters?.some((p) => p.name === written) === true) {
      bindings.set(written, actual);
      continue;
    }
    if (normalize(written) === normalize(actual)) continue;
    // Differing spellings, which is not yet a difference of TYPE. Resolve both
    // where each was written and compare what they bound to: an imported `User`
    // and a `Models.User` are one declaration, and a declaration is what the
    // instantiation is actually about.
    const heritageType = step.resolveHeritageArgument(written);
    const supertypeType = step.resolveSupertypeArgument(actual);
    if (heritageType.definitionId !== undefined && supertypeType.definitionId !== undefined) {
      if (heritageType.definitionId === supertypeType.definitionId) continue;
      return { compatible: false, subtypeArguments: undefined };
    }
    // At least one side names something outside this workspace — `String`,
    // `HttpClient`, a generated type. That is the COMMON case for a generic
    // argument, so refusing to decide here would make the whole filter inert;
    // what is compared instead is the simple name, which cannot tell
    // `a.User` from `b.User` (kept, the over-approximating direction) but does
    // tell `String` from `Integer`.
    if (simpleName(normalize(written)) === simpleName(normalize(actual))) continue;
    // The one thing a spelling difference must not be read as: a TYPE VARIABLE
    // this pipeline never captured. Where the subtype's parameter list is not
    // known to be complete, only a pair of grounded names — resolved or built
    // in — is safe to prune on.
    if (!step.subtypeParametersComplete && !(grounded(heritageType) && grounded(supertypeType))) {
      return UNKNOWN;
    }
    return { compatible: false, subtypeArguments: undefined };
  }

  if (subtypeParameters === undefined || subtypeParameters.length === 0) return UNKNOWN;
  const subtypeArguments: string[] = [];
  for (const parameter of subtypeParameters) {
    const bound = bindings.get(parameter.name);
    if (bound === undefined) return UNKNOWN;
    subtypeArguments.push(bound);
  }
  return { compatible: true, subtypeArguments };
}
