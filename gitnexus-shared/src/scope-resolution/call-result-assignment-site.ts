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
}
