// Scenario-map controls fixture (Phase 1 U17), pair `numeric-boundary`. The limit comes from the
// constants-only module ./limits.ts; Stryker has no numeric-literal mutator.
import { PAGE_LIMIT } from './limits.js';

/** Clamps a requested page size to PAGE_LIMIT. */
export function clampPageSize(requested: number): number {
  if (requested > PAGE_LIMIT) {
    return PAGE_LIMIT;
  }
  return requested;
}
