/**
 * C++ two-phase template lookup support.
 *
 * Inside a class template body, names from a dependent base class are NOT
 * found by ordinary unqualified lookup. The standard requires the
 * `this->name` or `Base<T>::name` forms to make the lookup dependent.
 * GitNexus's global free-call fallback otherwise binds such names to the
 * dependent base's members, producing CALLS edges the compiler would
 * reject.
 *
 * This module records — during `emitCppScopeCaptures` — which template
 * class declarations have which dependent base class names (per file).
 * `populateCppDependentBases` then resolves those names to class nodeIds
 * using the workspace registry, building the per-class set the
 * `isDependentBaseMember` predicate consumes.
 *
 * NOTE: module-level state, single-process-single-repo use only.
 * `clearFileLocalNames()` clears this state alongside file-local linkage
 * (see `file-local-linkage.ts`).
 */

import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { findEnclosingClassDef } from '../../scope-resolution/scope/walkers.js';

/**
 * Capture-time record: for each template class declaration in a file,
 * the simple names of its dependent base classes.
 *
 * Key: filePath
 * Value: Map<className, Set<dependentBaseSimpleName>>
 */
const dependentBasesByFile = new Map<string, Map<string, Set<string>>>();

/**
 * Post-`populateOwners` resolution: per-class-nodeId, the set of
 * dependent-base-class nodeIds. Built by `populateCppDependentBases`
 * from `dependentBasesByFile` + the workspace registry.
 */
const dependentBaseNodeIds = new Map<string, Set<string>>();

/**
 * Record a dependent-base relationship discovered during scope-capture
 * emission. `className` is the simple name of the template class;
 * `baseName` is the simple name of the dependent base class.
 *
 * The capture-time recorder uses simple names because the registry
 * resolution that maps names → nodeIds runs later (in
 * `populateCppDependentBases`).
 */
export function markCppDependentBase(filePath: string, className: string, baseName: string): void {
  let perFile = dependentBasesByFile.get(filePath);
  if (perFile === undefined) {
    perFile = new Map();
    dependentBasesByFile.set(filePath, perFile);
  }
  let bases = perFile.get(className);
  if (bases === undefined) {
    bases = new Set();
    perFile.set(className, bases);
  }
  bases.add(baseName);
}

/** Clear two-phase-lookup state. Called from `clearFileLocalNames`. */
export function clearCppDependentBases(): void {
  dependentBasesByFile.clear();
  dependentBaseNodeIds.clear();
}

/**
 * Resolve recorded dependent-base simple names to class nodeIds using
 * the parsed file's localDefs. Run as part of `populateOwners` so the
 * resolved set is available before any resolution pass consults it.
 *
 * Matches by simple name within the same file (the template class and
 * its base are typically declared in the same TU; cross-file template
 * bases are an edge case deferred to V2).
 */
export function populateCppDependentBases(parsed: ParsedFile): void {
  const perFile = dependentBasesByFile.get(parsed.filePath);
  if (perFile === undefined) return;

  // Build simple-name → nodeId index for this file's class-like defs.
  const classByName = new Map<string, string>();
  for (const def of parsed.localDefs) {
    if (def.type !== 'Class' && def.type !== 'Struct' && def.type !== 'Interface') continue;
    const simple = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
    if (simple !== '') classByName.set(simple, def.nodeId);
  }

  for (const [className, baseNames] of perFile) {
    const classNodeId = classByName.get(className);
    if (classNodeId === undefined) continue;
    let bases = dependentBaseNodeIds.get(classNodeId);
    if (bases === undefined) {
      bases = new Set();
      dependentBaseNodeIds.set(classNodeId, bases);
    }
    for (const baseName of baseNames) {
      const baseNodeId = classByName.get(baseName);
      if (baseNodeId !== undefined) bases.add(baseNodeId);
    }
  }
}

/**
 * Two-phase lookup predicate: is the candidate def a member of a
 * dependent base of the caller's enclosing template class?
 *
 * Used as an additional reject-filter in `pickUniqueGlobalCallable` and
 * the receiver-bound member chain walk. ONLY apply for unqualified
 * call forms — `this->name` and `Base<T>::name` are dependent lookup
 * forms that the standard allows.
 *
 * Conservative bias: when the caller's enclosing class can't be
 * identified, return `false` (let normal resolution proceed). Over-
 * rejection is acceptable for the template case because the standard
 * itself requires `this->` or qualified forms for dependent base
 * access; missing edges here match the compiler's diagnostic shape.
 */
export function isCppDependentBaseMember(
  callerScopeId: ScopeId,
  candidateDef: SymbolDefinition,
  scopes: ScopeResolutionIndexes,
): boolean {
  if (candidateDef.ownerId === undefined) return false;
  const enclosing = findEnclosingClassDef(callerScopeId, scopes);
  if (enclosing === undefined) return false;
  const bases = dependentBaseNodeIds.get(enclosing.nodeId);
  if (bases === undefined) return false;
  return bases.has(candidateDef.ownerId);
}
