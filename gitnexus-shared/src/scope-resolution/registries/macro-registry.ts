/**
 * `MacroRegistry` — scope-aware lookup for macro definitions
 * (`macro_rules!` in Rust; `#define` in C/C++) referenced from a macro
 * invocation site.
 *
 * Thin wrapper over `lookupCore`, specialized for the macro namespace:
 *
 *   - `acceptedKinds` = `MACRO_KINDS` (`['Macro']` only). Crucially this
 *     does NOT include `Function`/`Method`, so a `log!(…)` invocation can
 *     never resolve to a same-named free function `fn log` — macros and
 *     functions are disjoint namespaces (the false-`CALLS`-edge class the
 *     #1934 review flagged).
 *   - `useReceiverTypeBinding` is **false** — a macro invocation has no
 *     receiver; resolution is name-through-the-lexical-chain + the global
 *     qualified fallback, exactly like `ClassRegistry`.
 *   - Arity is not applied — macros are variadic by nature.
 */

import type { Resolution, ScopeId } from '../types.js';
import { lookupCore, type CoreLookupParams } from './lookup-core.js';
import { MACRO_KINDS, type RegistryContext } from './context.js';

export interface MacroRegistry {
  /**
   * Look up a macro definition by simple or scoped name anchored at
   * `scope`. Returns a confidence-ranked `Resolution[]`; consume `[0]`
   * for the best answer.
   */
  lookup(name: string, scope: ScopeId): readonly Resolution[];
}

export function buildMacroRegistry(ctx: RegistryContext): MacroRegistry {
  const params: CoreLookupParams = {
    acceptedKinds: MACRO_KINDS,
    useReceiverTypeBinding: false,
    ownerScopedContributor: null,
  };
  return {
    lookup(name: string, scope: ScopeId) {
      return lookupCore(name, scope, params, ctx);
    },
  };
}
