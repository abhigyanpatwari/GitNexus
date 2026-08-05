import type { ParsedFile } from 'gitnexus-shared';
import { logger } from '../../../logger.js';
import { isClassLike, populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';

import { goPackageDir, inferGoPackageName } from './package-clause.js';

/** Bound on the sample of no-package-clause paths named in the warning. */
const SKIPPED_SAMPLE_CAP = 5;

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
  // A file with no resolvable package clause is dropped from ownership
  // resolution entirely — its methods never attach to a struct declared in a
  // sibling file. That used to be a bare `continue` with no trace, which is the
  // same false-safe silence #2813 was filed about. Report it once, bounded
  // (mirrors the fan-out-cap warning in scope-resolution/pipeline/run.ts).
  const skipped: string[] = [];
  for (const parsed of parsedFiles) {
    const pkgName = inferGoPackageName(ctx.fileContents.get(parsed.filePath) ?? '');
    if (pkgName === null) {
      skipped.push(parsed.filePath);
      continue;
    }
    const key = `${goPackageDir(parsed.filePath)}\0${pkgName}`;
    const bucket = filesByPackage.get(key) ?? [];
    bucket.push(parsed);
    filesByPackage.set(key, bucket);
  }
  if (skipped.length > 0) {
    logger.warn(
      { skippedFiles: skipped.length, sample: skipped.slice(0, SKIPPED_SAMPLE_CAP) },
      'go: files with no resolvable package clause were excluded from method-owner ' +
        'resolution (their methods cannot attach to structs declared in sibling files)',
    );
  }

  for (const bucket of filesByPackage.values()) {
    populateGoOwnersInPackage(bucket);
  }
}

function populateGoOwnersInPackage(parsedFiles: readonly ParsedFile[]): void {
  // Build struct name → def map from ALL scopes' ownedDefs (struct defs
  // live in Class scopes now, not Module scope).
  const structByQualifiedName = new Map<string, { nodeId: string; qualifiedName: string }>();
  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      for (const def of scope.ownedDefs) {
        if (isClassLike(def.type) && def.qualifiedName) {
          structByQualifiedName.set(def.qualifiedName, {
            nodeId: def.nodeId,
            qualifiedName: def.qualifiedName,
          });
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
        let receiverKind: 'value' | 'pointer' = 'value';
        for (const [, tb] of scope.typeBindings) {
          if (tb.source === 'self') {
            receiverType = tb.rawName;
            receiverKind = tb.rawName.trim().startsWith('*') ? 'pointer' : 'value';
            break;
          }
        }
        if (receiverType === undefined) continue;
        receiverType = receiverType.replace(/^\*+/, '').trim();

        let owner = structByQualifiedName.get(receiverType);
        if (owner === undefined) {
          for (const [qname, candidate] of structByQualifiedName) {
            if (qname.endsWith('.' + receiverType)) {
              owner = candidate;
              break;
            }
          }
        }
        if (owner !== undefined) {
          for (const def of methodDefs) {
            (def as { ownerId?: string }).ownerId = owner.nodeId;
            (def as { goReceiverKind?: 'value' | 'pointer' }).goReceiverKind = receiverKind;
            const simpleName = def.qualifiedName?.split('.').pop() ?? def.qualifiedName;
            if (simpleName !== undefined && !def.qualifiedName?.includes('.')) {
              (def as { qualifiedName?: string }).qualifiedName =
                `${owner.qualifiedName}.${simpleName}`;
            }
          }
        }
      }
    }
  }
}
