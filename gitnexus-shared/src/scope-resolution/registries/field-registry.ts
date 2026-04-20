/**
 * `FieldRegistry` — scope-aware lookup for field / property / variable
 * access (RFC §4.4; Ring 2 SHARED #917).
 *
 * Thin wrapper over `lookupCore`, specialized for data-member kinds:
 *
 *   - `acceptedKinds` = Variable / Property / Const / Static.
 *   - `useReceiverTypeBinding` is **true** — fields are resolved against
 *     the receiver type's MRO first, then via the lexical chain for
 *     free variables.
 *   - `callsite` is not meaningful for field access (no arity), but the
 *     `explicitReceiver` and `ownerScopedContributor` knobs are.
 */

import type { Resolution, ScopeId } from '../types.js';
import { lookupCore, type CoreLookupParams } from './lookup-core.js';
import type { OwnerScopedContributor, RegistryContext } from './context.js';
import { FIELD_KINDS } from './context.js';

export interface FieldLookupOptions {
  readonly explicitReceiver?: { readonly name: string };
  readonly ownerScopedContributor?: OwnerScopedContributor;
}

export interface FieldRegistry {
  lookup(name: string, scope: ScopeId, options?: FieldLookupOptions): readonly Resolution[];
}

export function buildFieldRegistry(ctx: RegistryContext): FieldRegistry {
  return {
    lookup(name: string, scope: ScopeId, options: FieldLookupOptions = {}) {
      const params: CoreLookupParams = {
        acceptedKinds: FIELD_KINDS,
        useReceiverTypeBinding: true,
        ownerScopedContributor: options.ownerScopedContributor ?? null,
        ...(options.explicitReceiver !== undefined
          ? { explicitReceiver: options.explicitReceiver }
          : {}),
      };
      return lookupCore(name, scope, params, ctx);
    },
  };
}
