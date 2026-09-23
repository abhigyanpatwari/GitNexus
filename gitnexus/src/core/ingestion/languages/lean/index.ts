/**
 * Lean 4 scope-resolution public API barrel.
 *
 * Module layout:
 *
 *   - `captures.ts`   — `emitLeanScopeCaptures` (regex tagger)
 *   - `interpret.ts`  — import/type-binding/receiver hooks
 */

export { emitLeanScopeCaptures } from './captures.js';
export {
  interpretLeanImport,
  interpretLeanTypeBinding,
  leanImportOwningScope,
  leanReceiverBinding,
} from './interpret.js';
