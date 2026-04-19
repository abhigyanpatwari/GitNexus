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
  | 'import-use';

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
}
