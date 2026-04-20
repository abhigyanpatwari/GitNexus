/**
 * `ORIGIN_PRIORITY` — RFC Appendix B (authoritative values).
 *
 * Tie-break ordering applied inside `Registry.lookup` Step 7 when
 * `|Δconfidence| < 0.001` between two `Resolution` candidates. Lower number
 * = stronger (wins the tie).
 *
 * Full tie-break order (§4.2 Step 7):
 *   confidence DESC → scope depth ASC → MRO depth ASC → ORIGIN_PRIORITY ASC
 *   → DefId.localeCompare
 */

export type OriginForTieBreak =
  | 'local'
  | 'import'
  | 'reexport'
  | 'namespace'
  | 'wildcard'
  | 'global-qualified'
  | 'global-name';

export const ORIGIN_PRIORITY: Readonly<Record<OriginForTieBreak, number>> = {
  local: 0,
  import: 1,
  reexport: 2,
  namespace: 3,
  wildcard: 4,
  'global-qualified': 5,
  'global-name': 6,
};
