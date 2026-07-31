/**
 * `ReferenceSite` — a pre-resolution usage fact collected by `ScopeExtractor`
 * (RFC §3.2 Phase 1; Ring 2 PKG #919).
 *
 * One record per `@reference.*` capture. The extractor records:
 *   - the name being referenced (method/field/class name),
 *   - the source range,
 *   - the innermost lexical scope containing the reference,
 *   - the reference kind (call, read, write, inherits, etc.),
 *   - optional call-form classification from `provider.classifyCallForm`,
 *   - optional explicit-receiver hint for dotted calls (`user.save()`),
 *   - optional arity for call sites.
 *
 * Reference sites are consumed by the resolution phase (RFC §3.2 Phase 4)
 * which routes each through `Registry.lookup` / `resolveTypeRef` and
 * emits the final `Reference` record into `ReferenceIndex`.
 *
 * **Pre-resolution only.** `ReferenceSite` intentionally carries no
 * `toDef`, `confidence`, or `evidence`. Those are populated by the
 * resolution step that reads this record and produces a `Reference`
 * (defined in `./types.ts`).
 */

import type { ParameterTypeClass } from './symbol-definition.js';
import type { Range, ScopeId } from './types.js';

/**
 * What kind of usage this reference represents — the graph-edge kind
 * emitted after resolution (`CALLS`, `READS`, `WRITES`, etc.).
 *
 * Matches the `kind` field on `Reference` in `./types.ts` so the
 * resolution phase can pass it through without re-classification.
 */
export type ReferenceKind =
  | 'call'
  | 'read'
  | 'write'
  | 'type-reference'
  | 'inherits'
  | 'import-use'
  // An identifier in object-literal property-value position
  // (`{ emitScopeCaptures: emitCppScopeCaptures }`, shorthand `{ hook }`).
  // Resolution is owned entirely by the post-finalize property-dispatch pass
  // (`emitPropertyDispatchCalls` via the callable-gated finalized-bindings
  // walker `findCallableBindingInScope`; `resolveReferenceSites` skips these
  // sites), so a non-function value never produces a reference. Emitted as a `USES`
  // reference edge — NOT `CALLS` (a registration is not an invocation;
  // Kythe `ref` / Joern `METHOD_REF` precedent). The invocation side is
  // recovered separately by the property-dispatch pass, which uses
  // `propertyKey` to synthesize CALLS at member-call sites (#2437).
  | 'value-ref'
  // A macro invocation (`log!(...)` / `vec![...]`). Resolved against
  // `Macro`-labeled definitions ONLY (see `MacroRegistry`) so a macro
  // never aliases a same-named free function — macros and functions are
  // disjoint namespaces. Emitted as a `USES` edge, not `CALLS`.
  | 'macro';

/**
 * How a call site binds its target. Informs `Registry.lookup` Step 2
 * (type-binding path):
 *   - `'free'`   — bare call (no receiver); resolution via lexical chain.
 *   - `'member'` — dotted call (`x.foo()`); resolution via receiver type.
 *   - `'constructor'` — `new Foo()`; receiver is the class itself.
 *   - `'index'`  — index expression (`arr[0]`); rare as a dispatch site.
 *
 * Only meaningful for `kind === 'call'`; ignored for reads/writes.
 */
export type CallForm = 'free' | 'member' | 'constructor' | 'index';

export interface ReferenceSite {
  /** The name being referenced (e.g., `'save'`, `'User'`, `'count'`). */
  readonly name: string;
  /**
   * Optional raw, qualified form of the referenced name when the source wrote
   * a qualified path (e.g. a C++ base `struct D : Other::Inner` yields
   * `'Other::Inner'`). `name` keeps the simple tail (`'Inner'`) for the existing
   * scope-chain contract; resolution normalizes this via `normalizeQualifiedName`
   * and resolves it against the full-path `QualifiedNameIndex` BEFORE the
   * simple-tail walk, so a same-tail nested base resolves to the correct
   * sibling instead of the first-inserted one (issue #1982). Populated only by
   * per-language captures that emit `@reference.qualified-name`; absent
   * otherwise, in which case resolution is unchanged.
   */
  readonly rawQualifiedName?: string;
  /** Source-text range of this reference. */
  readonly atRange: Range;
  /**
   * Innermost lexical scope that contains `atRange`. Resolved by the
   * extractor via position lookup and frozen here so the resolution
   * phase doesn't re-compute it per call.
   */
  readonly inScope: ScopeId;
  readonly kind: ReferenceKind;
  /** Set when `kind === 'call'`. */
  readonly callForm?: CallForm;
  /**
   * Explicit receiver for dotted calls (`user.save()` → `{ name: 'user' }`).
   * Passed through to `Registry.lookup.explicitReceiver`.
   */
  readonly explicitReceiver?: { readonly name: string };
  /** Argument count at the call site; used by `provider.arityCompatibility`. */
  readonly arity?: number;
  /**
   * Object-literal key under which a `value-ref` site registers its value
   * (`{ emitScopeCaptures: emitHook }` → `'emitScopeCaptures'`; shorthand
   * `{ emitHook }` → `'emitHook'`). Consumed by the property-dispatch pass
   * to connect member-call sites (`x.emitScopeCaptures()`) to registered
   * functions (#2437). Only set for `kind === 'value-ref'`.
   */
  readonly propertyKey?: string;
  /**
   * Inferred argument types at the call site, one per argument. An
   * empty-string entry means "unknown" — consumers narrowing overload
   * candidates treat unknown as any-match. Populated by languages
   * that can derive types from literals / constructor expressions
   * (C#: `42` → `'int'`, `"alice"` → `'string'`).
   */
  readonly argumentTypes?: readonly string[];
  /**
   * Optional per-argument type-shape sidecar for languages that need
   * cv/ref/pointer distinctions during constraint filtering. This is
   * intentionally separate from `argumentTypes`, which stays normalized
   * for existing overload narrowing and conversion-rank logic.
   */
  readonly argumentTypeClasses?: readonly ParameterTypeClass[];
  /**
   * Compact encoding of a receiver that is itself an expression, so resolution
   * can type it by folding over structure instead of re-parsing the receiver's
   * source text.
   *
   * Format and the reason it is a string rather than `MixedChainStep[]` live in
   * `receiver-chain-codec.ts` — briefly, the store's interning reviver re-shares
   * objects only when they carry `nodeId` + `filePath`, which a chain step does
   * not, so an object encoding would survive every warm load as fresh
   * allocations.
   *
   * Absent whenever the receiver is a bare name, which is the overwhelming
   * majority of sites — the field costs nothing where it is not needed.
   */
  readonly receiverChain?: string;
}

/**
 * One step in a mixed receiver chain — the decoded form of a receiver that is
 * itself an expression rather than a bare name.
 *
 * For `svc.getUser().address.save()`, the receiver of `save` decodes to
 * `[{ kind: 'call', name: 'getUser' }, { kind: 'field', name: 'address' }]`
 * over a base receiver of `svc`.
 *
 * Lives here rather than beside its producer because it is part of the
 * ScopeExtractor output contract that this package owns: the producer
 * (`extractMixedChain`) walks a tree-sitter AST and so must stay in the
 * analyzer, but the shape it yields crosses into resolution.
 */
/**
 * One hop in a receiver chain.
 *
 * `field` and `call` carry the member name they reach. `await` and `index` are
 * NAME-FREE: the call step already holds the method name for an awaited call,
 * and a subscript has no member name at all — an index expression's key is a
 * value, not an identifier the resolver could look up. The codec encodes them
 * as a bare sigil and rejects any trailing characters, so the encoder's
 * non-empty-name guard stays live for exactly the two kinds it was written for.
 */
export type MixedChainStep =
  | { kind: 'field' | 'call'; name: string }
  | { kind: 'await' | 'index'; name?: undefined };
