/**
 * `RegistryContext` — the injected state required by the scope-aware
 * registry lookups (RFC §4; Ring 2 SHARED #917).
 *
 * Bundles every Ring 2 index + every provider hook the 7-step algorithm
 * might consult. Threaded through `lookupCore` and the three public
 * registries unchanged; construction is the caller's responsibility
 * (typically once per workspace-indexing pass in Ring 2 PKG).
 *
 * The design intent is **pure-logic in `gitnexus-shared`, data + hooks
 * supplied by the caller**. Nothing here loads files, parses AST, or
 * reaches into the CLI package.
 */

import type { NodeLabel } from '../../graph/types.js';
import type { SymbolDefinition } from '../symbol-definition.js';
import type { Callsite, DefId } from '../types.js';
import type { DefIndex } from '../def-index.js';
import type { QualifiedNameIndex } from '../qualified-name-index.js';
import type { ModuleScopeIndex } from '../module-scope-index.js';
import type { ScopeTree } from '../scope-tree.js';
import type { MethodDispatchIndex } from '../method-dispatch-index.js';

// ─── Provider hooks consumed by the registries ─────────────────────────────

export interface RegistryProviders {
  /**
   * Language-specific arity compatibility between a callsite and a candidate
   * `def`. Mirrors `LanguageProvider.arityCompatibility` from #911. Optional:
   * when absent, every candidate receives `'unknown'` (neutral signal).
   */
  arityCompatibility?(callsite: Callsite, def: SymbolDefinition): ArityVerdict;
}

export type ArityVerdict = 'compatible' | 'unknown' | 'incompatible';

// ─── Owner-scoped contributor (concrete shape for `RegistryContributor`) ────

/**
 * Per-owner membership view plugged into `LookupParams.ownerScopedContributor`.
 *
 * When the caller knows a receiver is of type `Owner` (e.g., after
 * resolving an explicit receiver or via `self`), it can supply the
 * `Owner`'s own member bucket here. `lookupCore` treats hits from this
 * contributor as `origin: 'local'` inside the owner's body scope —
 * strongest-visibility evidence, unaffected by the scope-chain hop
 * deduction that punishes outer-scope hits.
 *
 * Ring 1's `RegistryContributor = unknown` opaque placeholder is narrowed
 * to this concrete shape here in Ring 2 SHARED (#917).
 */
export interface OwnerScopedContributor {
  /** The owner (class/struct/trait/interface) that bounds this view. */
  readonly ownerDefId: DefId;
  /**
   * Methods / fields directly declared on the owner, keyed by simple name.
   * Return empty array on miss; implementations should NOT walk the MRO —
   * that's `MethodDispatchIndex`'s job, handled in the type-binding step.
   */
  byName(name: string): readonly SymbolDefinition[];
}

// ─── Top-level context threaded through every lookup ───────────────────────

export interface RegistryContext {
  readonly scopes: ScopeTree;
  readonly defs: DefIndex;
  readonly qualifiedNames: QualifiedNameIndex;
  readonly moduleScopes: ModuleScopeIndex;
  /**
   * Method-dispatch index; required for method/field registries that
   * honor `useReceiverTypeBinding`. Omit for class-only lookups.
   */
  readonly methodDispatch?: MethodDispatchIndex;
  readonly providers: RegistryProviders;
}

// ─── Per-kind default `acceptedKinds` sets ─────────────────────────────────
//
// Exported so the three public registries stay declarative (each one just
// points at the right constant + passes it to `lookupCore`).

export const CLASS_KINDS: readonly NodeLabel[] = Object.freeze([
  'Class',
  'Interface',
  'Enum',
  'Struct',
  'Union',
  'Trait',
  'TypeAlias',
  'Typedef',
  'Record',
  'Delegate',
  'Annotation',
  'Template',
  'Namespace',
]);

export const METHOD_KINDS: readonly NodeLabel[] = Object.freeze([
  'Method',
  'Function',
  'Constructor',
]);

export const FIELD_KINDS: readonly NodeLabel[] = Object.freeze([
  'Variable',
  'Property',
  'Const',
  'Static',
]);
