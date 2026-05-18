/**
 * Owner-keyed member lookup for Step 2 (RFC #909 / PR #1656).
 *
 * Merges MethodRegistry + FieldRegistry hits for `(ownerDefId, memberName)`
 * in O(1) map time per registry — no `defs.byId` scan. Callers that omit
 * this helper and leave `ownedMembersByOwner` unset fall back to an O(|defs|)
 * compatibility scan inside `lookupCore.collectOwnedMembers`.
 */

import type { DefId, SymbolDefinition } from 'gitnexus-shared';
import type { SemanticModel } from './semantic-model.js';

const EMPTY: readonly SymbolDefinition[] = Object.freeze([]);

/**
 * Production hook for `RegistryContext.ownedMembersByOwner`.
 * Returns `[]` on miss (authoritative indexed empty) — never `undefined`.
 *
 * Merges hits from all three owner-keyed registries (methods, fields,
 * nested types) under the same `(ownerDefId, memberName)` key. The
 * caller's `acceptedKinds` filter in `lookupCore` picks the right subset.
 */
export function lookupOwnedMembersByOwner(
  model: Pick<SemanticModel, 'methods' | 'fields' | 'types'>,
  ownerDefId: DefId,
  memberName: string,
): readonly SymbolDefinition[] {
  const methods = model.methods.lookupAllByOwner(ownerDefId, memberName);
  const fields = model.fields.lookupAllByOwner(ownerDefId, memberName);
  const nestedTypes = model.types.lookupAllByOwner(ownerDefId, memberName);
  const methodCount = methods.length;
  const fieldCount = fields.length;
  const typeCount = nestedTypes.length;
  const total = methodCount + fieldCount + typeCount;
  if (total === 0) return EMPTY;
  if (methodCount === total) return methods;
  if (fieldCount === total) return fields;
  if (typeCount === total) return nestedTypes;
  const merged = new Array<SymbolDefinition>(total);
  let i = 0;
  for (let j = 0; j < methodCount; j++) merged[i++] = methods[j]!;
  for (let j = 0; j < fieldCount; j++) merged[i++] = fields[j]!;
  for (let j = 0; j < typeCount; j++) merged[i++] = nestedTypes[j]!;
  return merged;
}
