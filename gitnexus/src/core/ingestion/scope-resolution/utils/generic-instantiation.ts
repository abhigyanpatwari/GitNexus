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
  /**
   * The name is a TYPE PARAMETER of a declaration enclosing where it was
   * written — the `T` of `void Run<T>(IValidator<T> v)` at the call site, or of
   * an outer class around a nested one's heritage clause.
   *
   * It stands for a different type at every instantiation, so it cannot be
   * compared with anything, and it must be recognised SEPARATELY from
   * ungrounded: a bounded `T extends User` grounds to its bound's declaration,
   * and comparing that bound against a concrete argument would prune every
   * implementor of a call written through `IValidator<T>`.
   */
  readonly typeVariable?: boolean;
}

/** Resolve a written type argument from the scope it was written in. */
type TypeArgumentResolver = (name: string) => GroundedTypeArgument;

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

/**
 * Records one heritage edge's instantiation, from whichever pass emitted that
 * edge — the generic inheritance pre-pass, or a language's own
 * `ScopeResolver.emitHeritageEdges` for heritage the pre-pass cannot express
 * (Rust `impl Trait for S`, Dart's `implements` markers).
 *
 * The ids MUST be the same pair the emitted edge carries, because the dispatch
 * walk looks the instantiation up by the edge it is crossing. Recording nothing
 * is always safe: absence reads as "unknown" and keeps every target.
 */
export type HeritageTypeArgumentSink = (
  subtypeGraphId: string,
  supertypeGraphId: string,
  typeArguments: readonly string[],
) => void;

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

interface HeritageInstantiationResult {
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

/** Stand-in for a language that declares no `normalizeTypeArgument`. Module
 *  level so the 15 that do not are not charged a closure per hop. */
const identity = (name: string): string => name;

/** A resolved declaration, or a name the language calls built in. Anything else
 *  might be a type variable nobody captured. */
function grounded(type: GroundedTypeArgument): boolean {
  return type.definitionId !== undefined || type.builtIn;
}

/**
 * Does this spelling name a SET of types rather than one — a Java wildcard
 * (`?`, `? extends User`, `? super User`), a Kotlin star projection (`*`) or
 * use-site variance (`out User`, `in User`)?
 *
 * Nullable decoration (`User?`, `string?`) matches the `?` test too. Keeping it
 * in is deliberate: an argument that may or may not be null is still the same
 * type for dispatch purposes, so the only cost is declining to prune a position
 * that could have been pruned — the direction every other uncertainty here
 * takes.
 */
function isWildcard(name: string): boolean {
  return WILDCARD_MARK.test(name) || USE_SITE_VARIANCE.test(name);
}

const WILDCARD_MARK = /[?*]/;
/** Leading whitespace is matched rather than trimmed off, so a spelling that
 *  carries none — the overwhelming majority — costs no allocation. */
const USE_SITE_VARIANCE = /^\s*(?:out|in)\s/;

/** Drop insignificant whitespace so two spellings of one instantiation compare
 *  equal: `Map<string, User>` and `Map<string,User>` are the same type, and
 *  which one a capture produced depends on how the source was written. */
function compact(name: string): string {
  return name.replace(INSIGNIFICANT_WHITESPACE, '');
}

const INSIGNIFICANT_WHITESPACE = /\s+/g;

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

  const normalize = step.normalize ?? identity;
  const bindings = new Map<string, string>();
  for (let i = 0; i < heritageArguments.length; i++) {
    const written = heritageArguments[i] as string;
    const actual = supertypeArguments[i] as string;
    // A type VARIABLE of the subtype binds rather than compares: `Wrapper<T> :
    // IValidator<T>` under an `IValidator<string>` receiver means T = string.
    if (subtypeParameters?.some((p) => p.name === written) === true) {
      const previous = bindings.get(written);
      if (previous !== undefined) {
        // The SAME variable in a second position must receive the same type:
        // `class C<T> : Pair<T, T>` cannot be a `Pair<string, int>`, and
        // overwriting the first binding would both accept that and hand the
        // next hop a substitution the subtype never had. Unify instead — but
        // prune only on the evidence the concrete path below demands, since two
        // spellings that differ are not yet two types.
        const first = step.resolveSupertypeArgument(previous);
        const second = step.resolveSupertypeArgument(actual);
        if (
          isWildcard(previous) ||
          isWildcard(actual) ||
          first.typeVariable === true ||
          second.typeVariable === true
        ) {
          return UNKNOWN;
        }
        if (compact(normalize(previous)) === compact(normalize(actual))) continue;
        if (first.definitionId !== undefined && second.definitionId !== undefined) {
          if (first.definitionId === second.definitionId) continue;
          return { compatible: false, subtypeArguments: undefined };
        }
        if (grounded(first) && grounded(second)) {
          return { compatible: false, subtypeArguments: undefined };
        }
        // One side names something this pipeline cannot see. The position is
        // undecided, and so is the binding it would have carried onward.
        return UNKNOWN;
      }
      bindings.set(written, actual);
      continue;
    }
    // A WILDCARD names a set of types, not one: `Repo<? extends User>` holds a
    // `Repo<User>` perfectly well, and Kotlin's `Repo<*>` or `Repo<out User>`
    // say the same thing in their own spelling. Comparing one against a
    // concrete argument answers a question neither spelling asked, so the
    // position is simply unknown. Nullable decoration (`User?`, `string?`) trips
    // the same test, which costs a little precision in the safe direction.
    if (isWildcard(written) || isWildcard(actual)) continue;
    // Normalized once and reused by the simple-name compare below, so both
    // comparisons are visibly made on the same normalization.
    const writtenKey = compact(normalize(written));
    const actualKey = compact(normalize(actual));
    if (writtenKey === actualKey) continue;
    // Differing spellings, which is not yet a difference of TYPE. Resolve both
    // where each was written and compare what they bound to: an imported `User`
    // and a `Models.User` are one declaration, and a declaration is what the
    // instantiation is actually about.
    const heritageType = step.resolveHeritageArgument(written);
    const supertypeType = step.resolveSupertypeArgument(actual);
    // A type PARAMETER in scope where it was written stands for a different type
    // at every instantiation, so it is not comparable with anything — and
    // `subtypeParametersComplete` says nothing about it, because that flag is
    // evidence about the SUBTYPE's parameter list while this `T` belongs to the
    // enclosing generic method or class at the other end. Without this branch a
    // call written `void Run<T>(IValidator<T> v) { v.Check(x); }` prunes every
    // implementor: `T` is unbounded, so it grounds to nothing, and a bounded one
    // grounds to its BOUND and compares unequal to the concrete argument.
    if (heritageType.typeVariable === true || supertypeType.typeVariable === true) return UNKNOWN;
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
    if (simpleName(writtenKey) === simpleName(actualKey)) continue;
    // The one thing a spelling difference must not be read as: a TYPE VARIABLE
    // this pipeline never captured. Where the subtype's parameter list is not
    // known to be complete, only a pair of grounded names — resolved or built
    // in — is safe to prune on. A variable that IS captured never reaches here:
    // the subtype's own bind above, and any other declaration's through the
    // `typeVariable` test, which is why that test has to be reliable — see the
    // type-parameter captures on generic METHODS.
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
