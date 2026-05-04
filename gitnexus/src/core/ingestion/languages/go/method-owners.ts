import type { ParsedFile } from 'gitnexus-shared';
import { isClassLike, populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';

/**
 * Populate `ownerId` on Go Method defs by matching receiver types
 * extracted from `@type-binding.self` captures against struct defs in
 * the module scope.
 *
 * Go method declarations are top-level (`func (r *T) M()`), not nested
 * inside a struct body. The generic `populateClassOwnedMembers` requires
 * the method's parent scope to be a `Class` scope, which never matches
 * Go. This pass bridges the gap by reading the self typeBinding that
 * `synthesizeGoReceiverBinding` creates, locating the matching struct
 * def, and stamping `ownerId` onto the Method def.
 */
export function populateGoOwners(parsed: ParsedFile): void {
  // 1. Standard nested-class pass — stamps ownerId on Property/Method defs
  //    inside Class scopes. With Class scopes now created for Go
  //    struct/interface declarations, this handles struct field ownership.
  populateClassOwnedMembers(parsed);

  populateGoOwnersInPackage([parsed]);
}

export function populateGoWorkspaceOwners(
  parsedFiles: readonly ParsedFile[],
  ctx: { readonly fileContents: ReadonlyMap<string, string> },
): void {
  const filesByPackage = new Map<string, ParsedFile[]>();
  for (const parsed of parsedFiles) {
    const pkgName = inferPackageName(ctx.fileContents.get(parsed.filePath) ?? '');
    if (pkgName === null) continue;
    const key = `${packageDir(parsed.filePath)}\0${pkgName}`;
    const bucket = filesByPackage.get(key) ?? [];
    bucket.push(parsed);
    filesByPackage.set(key, bucket);
  }

  for (const bucket of filesByPackage.values()) {
    populateGoOwnersInPackage(bucket);
  }
}

function populateGoOwnersInPackage(parsedFiles: readonly ParsedFile[]): void {
  // Build struct name → def map from ALL scopes' ownedDefs (struct defs
  // live in Class scopes now, not Module scope).
  const structByQualifiedName = new Map<string, string>(); // qname → nodeId
  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      for (const def of scope.ownedDefs) {
        if (isClassLike(def.type) && def.qualifiedName) {
          structByQualifiedName.set(def.qualifiedName, def.nodeId);
        }
      }
    }
  }

  // 2. Go-specific method owner: each Method def lives in a Function
  //    scope whose typeBindings carry the self entry (kept there by
  //    goBindingScopeFor). Match the self rawName against struct defs.
  if (structByQualifiedName.size > 0) {
    for (const parsed of parsedFiles) {
      for (const scope of parsed.scopes) {
        if (scope.kind !== 'Function') continue;
        const methodDefs = scope.ownedDefs.filter(
          (d) => d.type === 'Method' && d.ownerId === undefined,
        );
        if (methodDefs.length === 0) continue;

        // Find the self typeBinding in this Function scope.
        let receiverType: string | undefined;
        for (const [, tb] of scope.typeBindings) {
          if (tb.source === 'self') {
            receiverType = tb.rawName;
            break;
          }
        }
        if (receiverType === undefined) continue;

        let ownerId = structByQualifiedName.get(receiverType);
        if (ownerId === undefined) {
          for (const [qname, nodeId] of structByQualifiedName) {
            if (qname.endsWith('.' + receiverType)) {
              ownerId = nodeId;
              break;
            }
          }
        }
        if (ownerId !== undefined) {
          for (const def of methodDefs) {
            (def as { ownerId?: string }).ownerId = ownerId;
          }
        }
      }
    }
  }
}

function inferPackageName(sourceText: string): string | null {
  const match = sourceText.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m);
  return match?.[1] ?? null;
}

function packageDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
}
