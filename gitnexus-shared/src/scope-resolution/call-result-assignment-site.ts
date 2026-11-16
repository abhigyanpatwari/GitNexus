import type { Range, ScopeId } from './types.js';

/**
 * Compact extraction-time identity for `lhs = callee()`.
 *
 * The call-site range uses the same call-expression anchor as reference
 * resolution, allowing downstream passes to join this fact to the exact
 * resolved callee id without relying on a possibly polluted type binding.
 */
export interface CallResultAssignmentSite {
  readonly callSite: Range;
  readonly inScope: ScopeId;
  readonly lhs: string;
  /**
   * Present when `lhs` holds an element reached from the call's result (for
   * example an iteration variable) instead of the result itself. The value is
   * a provider-defined route that only `ScopeResolver.callResultElementType`
   * interprets; without an answer from it the name stays unbound.
   */
  readonly element?: string;
}
