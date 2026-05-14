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
 * using a workspace-wide registry, building the per-class set the
 * `isCppDependentBaseMember` predicate consumes.
 *
 * Cross-file resolution: `Base<T>` may be declared in a different header
 * than `Derived<T>`. `populateCppDependentBases` therefore runs as a
 * workspace-wide pass (`populateWorkspaceOwners` hook) after every file
 * has had `populateOwners` applied, so all class defs are reachable.
 *
 * Namespace disambiguation: when multiple classes share a simple name
 * (e.g., `Box` in two namespaces), the resolver prefers the candidate
 * whose qualified-name prefix (namespace path) matches the deriving
 * class's prefix. If no namespace match is found, a unique simple-name
 * match is accepted; ambiguous matches (multiple candidates, no
 * namespace winner) are skipped conservatively.
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
 * Resolve recorded dependent-base simple names to class nodeIds using a
 * workspace-wide index. Run as `populateWorkspaceOwners` after every
 * file has had `populateOwners` applied, so class defs from ALL files
 * are reachable.
 *
 * Disambiguation strategy (multiple classes sharing a simple name):
 *  1. Prefer the candidate whose qualified-name namespace prefix matches
 *     the deriving class's namespace prefix (same-namespace bias).
 *  2. Fall back to accepting a unique simple-name match.
 *  3. Skip when multiple candidates exist and no namespace match is
 *     found (conservative: avoids false associations).
 */
export function populateCppDependentBases(parsedFiles: readonly ParsedFile[]): void {
  if (dependentBasesByFile.size === 0) return;

  // Build workspace-wide index: simpleName → {nodeId, nsPrefix}[]
  // nsPrefix is the dot-joined namespace path (qualifiedName without the
  // last segment). Classes at global scope have nsPrefix = ''.
  const classesBySimpleName = new Map<string, { nodeId: string; nsPrefix: string }[]>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (def.type !== 'Class' && def.type !== 'Struct' && def.type !== 'Interface') continue;
      const qn = def.qualifiedName ?? '';
      const lastDot = qn.lastIndexOf('.');
      const simple = lastDot >= 0 ? qn.slice(lastDot + 1) : qn;
      if (simple === '') continue;
      const nsPrefix = lastDot >= 0 ? qn.slice(0, lastDot) : '';
      let entries = classesBySimpleName.get(simple);
      if (entries === undefined) {
        entries = [];
        classesBySimpleName.set(simple, entries);
      }
      entries.push({ nodeId: def.nodeId, nsPrefix });
    }
  }

  // Build a filePath → ParsedFile lookup for fast per-file access.
  const parsedByFile = new Map<string, ParsedFile>();
  for (const parsed of parsedFiles) parsedByFile.set(parsed.filePath, parsed);

  for (const [filePath, perFile] of dependentBasesByFile) {
    const parsed = parsedByFile.get(filePath);
    if (parsed === undefined) continue;

    // Build a simple-name → {nodeId, nsPrefix} map for THIS file's
    // class-like defs so we can identify each template class precisely
    // (avoids cross-file name collisions for the deriving class itself).
    const localClassByName = new Map<string, { nodeId: string; nsPrefix: string }>();
    for (const def of parsed.localDefs) {
      if (def.type !== 'Class' && def.type !== 'Struct' && def.type !== 'Interface') continue;
      const qn = def.qualifiedName ?? '';
      const lastDot = qn.lastIndexOf('.');
      const simple = lastDot >= 0 ? qn.slice(lastDot + 1) : qn;
      if (simple === '') continue;
      const nsPrefix = lastDot >= 0 ? qn.slice(0, lastDot) : '';
      localClassByName.set(simple, { nodeId: def.nodeId, nsPrefix });
    }

    for (const [className, baseNames] of perFile) {
      const classEntry = localClassByName.get(className);
      if (classEntry === undefined) continue;

      let bases = dependentBaseNodeIds.get(classEntry.nodeId);
      if (bases === undefined) {
        bases = new Set();
        dependentBaseNodeIds.set(classEntry.nodeId, bases);
      }

      for (const baseName of baseNames) {
        const candidates = classesBySimpleName.get(baseName);
        if (candidates === undefined || candidates.length === 0) continue;

        if (candidates.length === 1) {
          // Unique simple-name match — accept regardless of namespace.
          bases.add(candidates[0].nodeId);
          continue;
        }

        // Multiple classes share the same simple name — prefer the one
        // whose namespace matches the deriving class's namespace.
        // V1: exact dot-prefix match only. Cross-namespace inheritance
        // (e.g., `ns::outer::Derived` extending bare `Inner` defined in
        // `ns::outer::inner`) and inline-namespace cases are deferred to
        // V2; the conservative skip-on-ambiguity below avoids false
        // associations in those edge cases.
        const nsMatch = candidates.find((c) => c.nsPrefix === classEntry.nsPrefix);
        if (nsMatch !== undefined) {
          bases.add(nsMatch.nodeId);
        }
        // else: ambiguous (multiple candidates, no namespace match) → skip.
      }
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
