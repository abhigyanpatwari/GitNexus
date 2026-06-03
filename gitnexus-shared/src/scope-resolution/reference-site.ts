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
}
