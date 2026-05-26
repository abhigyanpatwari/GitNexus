/**
 * COBOL scope-resolution public API barrel.
 *
 * Consumers should import from this file rather than the individual
 * modules — that keeps the per-hook organization an implementation
 * detail we can refactor without touching the provider wiring.
 *
 * Module layout:
 *
 *   - `captures.ts`   — `emitCobolScopeCaptures` (wraps the regex tagger)
 *   - `interpret.ts`  — import/type-binding/receiver hooks
 */

export { emitCobolScopeCaptures } from './captures.js';
export {
  interpretCobolImport,
  interpretCobolTypeBinding,
  cobolImportOwningScope,
  cobolReceiverBinding,
} from './interpret.js';
