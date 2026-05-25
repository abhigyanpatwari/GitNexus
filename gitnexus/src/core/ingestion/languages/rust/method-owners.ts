import type { ParsedFile } from 'gitnexus-shared';
import { isClassLike, populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';

/**
 * Populate `ownerId` on Rust method defs.
 *
 * Rust methods are declared inside `impl TypeName { ... }` blocks, not
 * directly inside struct bodies. The tree-sitter query creates Class scopes
 * for impl blocks, and the generic `populateClassOwnedMembers` handles methods
 * that are structurally nested inside those Class scopes. But we also need to
 * bridge the impl block's methods to the actual struct def, since the impl
 * block is semantically "owned by" the struct.
 *
 * Strategy:
 * 1. Run the generic `populateClassOwnedMembers` (handles property fields in
 *    structs and methods in impl blocks).
 * 2. For each method in an impl block's Class scope whose ownerId points to
 *    the impl block, re-point ownerId to the struct def (if found in the
 *    same module).
 */
export function populateRustOwners(parsed: ParsedFile): void {
  populateClassOwnedMembers(parsed);
  populateRustImplOwners(parsed);
}

function populateRustImplOwners(parsed: ParsedFile): void {
  // Build a map of struct name → def nodeId from all scopes.
  const structByName = new Map<string, string>();
  for (const scope of parsed.scopes) {
    for (const def of scope.ownedDefs) {
      if (isClassLike(def.type) && def.qualifiedName) {
        structByName.set(def.qualifiedName, def.nodeId);
      }
    }
  }
  if (structByName.size === 0) return;

  const structBySuffix = new Map<string, string>();
  for (const [qname, nodeId] of structByName) {
    const dot = qname.lastIndexOf('.');
    const suffix = dot !== -1 ? qname.slice(dot + 1) : qname;
    structBySuffix.set(suffix, nodeId);
  }

  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Function') continue;
    const methodDefs = scope.ownedDefs.filter(
      (d) => d.type === 'Method' && d.ownerId === undefined,
    );
    if (methodDefs.length === 0) continue;

    let receiverType: string | undefined;
    for (const [, tb] of scope.typeBindings) {
      if (tb.source === 'self') {
        receiverType = tb.rawName;
        break;
      }
    }
    if (receiverType === undefined) continue;

    const ownerId = structByName.get(receiverType) ?? structBySuffix.get(receiverType);
    if (ownerId !== undefined) {
      for (const def of methodDefs) {
        (def as { ownerId?: string }).ownerId = ownerId;
      }
    }
  }
}
