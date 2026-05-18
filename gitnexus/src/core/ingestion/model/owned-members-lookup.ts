/**
 * Owner-keyed member lookup for Step 2 (RFC #909 / PR #1656).
 *
 * Merges MethodRegistry + FieldRegistry hits for `(ownerDefId, memberName)`
 * in O(1) map time per registry — no `defs.byId` scan. Callers that omit
 * this helper and leave `ownedMembersByOwner` unset fall back to an O(|defs|)
 * compatibility scan inside `lookupCore.collectOwnedMembers`.
 */

import type { SymbolDefinition } from 'gitnexus-shared';
import type { SemanticModel } from './semantic-model.js';

const EMPTY: readonly SymbolDefinition[] = Object.freeze([]);

/**
 * Production hook for `RegistryContext.ownedMembersByOwner`.
 * Returns `[]` on miss (authoritative indexed empty) — never `undefined`.
 */
export function lookupOwnedMembersByOwner(
  model: Pick<SemanticModel, 'methods' | 'fields'>,
  ownerDefId: string,
  memberName: string,
): readonly SymbolDefinition[] {
  const methods = model.methods.lookupAllByOwner(ownerDefId, memberName);
  const fields = model.fields.lookupAllByOwner(ownerDefId, memberName);
  const methodCount = methods.length;
  const fieldCount = fields.length;
  if (fieldCount === 0) return methodCount === 0 ? EMPTY : methods;
  if (methodCount === 0) return fields;
  const merged = new Array<SymbolDefinition>(methodCount + fieldCount);
  for (let i = 0; i < methodCount; i++) merged[i] = methods[i]!;
  for (let i = 0; i < fieldCount; i++) merged[methodCount + i] = fields[i]!;
  return merged;
}
