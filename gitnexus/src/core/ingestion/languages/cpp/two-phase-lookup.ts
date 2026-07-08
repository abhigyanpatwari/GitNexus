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
 * the simple names of its dependent base classes and their syntactic
 * qualifiers (e.g., `detail` for `detail::Inner<T>`).
 *
 * Key: filePath
 * Value: Map<className, Map<baseName, qualifier>>
 *   qualifier is '' when the base was unqualified.
 */
const dependentBasesByFile = new Map<string, Map<string, Map<string, Set<string>>>>();

/**
 * Class templates with pack-expanded bases (`struct Mix : Bases...`) have
 * an unknown set of base classes. Unqualified member lookup inside the class
 * cannot safely bind to class-owned methods outside the current class.
 */
const dependentPackBaseClassesByFile = new Map<string, Set<string>>();

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
 * `qualifier` is the syntactic namespace qualifier (e.g. `detail` for
 * `detail::Inner<T>`), or '' for unqualified bases.
 *
 * The capture-time recorder uses simple names because the registry
 * resolution that maps names → nodeIds runs later (in
 * `populateCppDependentBases`).
 */
export function markCppDependentBase(
  filePath: string,
  className: string,
  baseName: string,
  qualifier = '',
): void {
  let perFile = dependentBasesByFile.get(filePath);
  if (perFile === undefined) {
    perFile = new Map();
    dependentBasesByFile.set(filePath, perFile);
  }
  let bases = perFile.get(className);
  if (bases === undefined) {
    bases = new Map();
    perFile.set(className, bases);
  }
  let quals = bases.get(baseName);
  if (quals === undefined) {
    quals = new Set();
    bases.set(baseName, quals);
  }
  quals.add(qualifier);
}

export function markCppDependentPackBase(filePath: string, className: string): void {
  let perFile = dependentPackBaseClassesByFile.get(filePath);
  if (perFile === undefined) {
    perFile = new Set();
    dependentPackBaseClassesByFile.set(filePath, perFile);
  }
  perFile.add(className);
}

/**
 * Plain-data, JSON-serializable snapshot of the per-file capture-time
 * two-phase-lookup state. Carried on `ParsedFile.captureSideChannel` across the
 * worker→main boundary (#1983). The resolved `dependentBaseNodeIds` index is
 * rebuilt by `populateCppDependentBases` (workspace pass) after all files have
 * their `populateOwners` applied, so only the two capture-time maps cross.
 *
 * Nested `Map`/`Set` are flattened to arrays here so the snapshot stays plain
 * JSON (avoids relying on the parsedfile-store's Map/Set replacer for nested
 * structures): `dependentBases` is `[className, [baseName, qualifiers[]][]][]`.
 */
export interface CppTwoPhaseSideChannel {
  readonly dependentBases: readonly [string, readonly [string, readonly string[]][]][];
  readonly dependentPackBaseClasses: readonly string[];
}

/** Snapshot this file's two-phase-lookup capture state for the side-channel. */
export function collectCppTwoPhaseSideChannel(filePath: string): CppTwoPhaseSideChannel {
  const perFile = dependentBasesByFile.get(filePath);
  const dependentBases: [string, [string, string[]][]][] = [];
  if (perFile !== undefined) {
    for (const [className, bases] of perFile) {
      const baseEntries: [string, string[]][] = [];
      for (const [baseName, quals] of bases) {
        baseEntries.push([baseName, [...quals]]);
      }
      dependentBases.push([className, baseEntries]);
    }
  }
  const pack = dependentPackBaseClassesByFile.get(filePath);
  return {
    dependentBases,
    dependentPackBaseClasses: pack === undefined ? [] : [...pack],
  };
}

/** Restore this file's two-phase-lookup capture state from the side-channel. */
export function applyCppTwoPhaseSideChannel(filePath: string, data: CppTwoPhaseSideChannel): void {
  for (const [className, baseEntries] of data.dependentBases) {
    for (const [baseName, quals] of baseEntries) {
      for (const qualifier of quals) {
        markCppDependentBase(filePath, className, baseName, qualifier);
      }
    }
  }
  for (const className of data.dependentPackBaseClasses) {
    markCppDependentPackBase(filePath, className);
  }
}

/** Clear two-phase-lookup state. Called from `clearFileLocalNames`. */
export function clearCppDependentBases(): void {
  dependentBasesByFile.clear();
  dependentPackBaseClassesByFile.clear();
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
 *  2. When a syntactic qualifier is available (`detail` in
 *     `detail::Inner<T>`), target the exact namespace derived from it.
 *  3. Fall back to accepting a unique simple-name match.
 *  4. Skip when multiple candidates exist and no namespace match is
 *     found (conservative: avoids false associations).
 */
export function populateCppDependentBases(parsedFiles: readonly ParsedFile[]): void {
  if (dependentBasesByFile.size === 0 && dependentPackBaseClassesByFile.size === 0) return;

  // Build workspace-wide index: simpleName → {nodeId, nsPrefix}[]
  // nsPrefix is the dot-joined namespace path (qualifiedName without the
  // last segment). Classes at global scope have nsPrefix = ''.
  // Dedup by nodeId, keeping the LAST occurrence: parsed.localDefs may
  // list the same class def multiple times — the scope-extractor creates
  // a def with simple-name qualifiedName first, then the class extractor
  // replaces it with the correct fully-qualified qualifiedName. Keeping
  // the later entry ensures we capture the full namespace path.
  const classesBySimpleName = new Map<string, { nodeId: string; nsPrefix: string }[]>();
  const entryByNodeId = new Map<string, { nodeId: string; nsPrefix: string; simple: string }>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (def.type !== 'Class' && def.type !== 'Struct' && def.type !== 'Interface') continue;
      const qn = def.qualifiedName ?? '';
      const lastDot = qn.lastIndexOf('.');
      const simple = lastDot >= 0 ? qn.slice(lastDot + 1) : qn;
      if (simple === '') continue;
      const nsPrefix = lastDot >= 0 ? qn.slice(0, lastDot) : '';
      entryByNodeId.set(def.nodeId, { nodeId: def.nodeId, nsPrefix, simple });
    }
  }
  for (const entry of entryByNodeId.values()) {
    let entries = classesBySimpleName.get(entry.simple);
    if (entries === undefined) {
      entries = [];
      classesBySimpleName.set(entry.simple, entries);
    }
    entries.push({ nodeId: entry.nodeId, nsPrefix: entry.nsPrefix });
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

    const packBaseClasses = dependentPackBaseClassesByFile.get(filePath);
    if (packBaseClasses !== undefined) {
      for (const className of packBaseClasses) {
        const classEntry = localClassByName.get(className);
        if (classEntry !== undefined) {
          dependentBaseNodeIds.set(classEntry.nodeId, new Set(['*pack-expansion*']));
        }
      }
    }

    // V3: qualifier-based exact targeting. When the base specifier carries
    // a syntactic qualifier (e.g., `detail` in `detail::Inner<T>`), compute
    // the expected namespace prefix and use exact (===) match. Falls back to
    // the V2 prefix-contains heuristic when the qualifier isn't available or
    // the exact match fails (absolute qualifier edge cases like `::std`).
    for (const [className, baseEntries] of perFile) {
      const classEntry = localClassByName.get(className);
      if (classEntry === undefined) continue;

      let bases = dependentBaseNodeIds.get(classEntry.nodeId);
      if (bases === undefined) {
        bases = new Set();
        dependentBaseNodeIds.set(classEntry.nodeId, bases);
      }

      for (const [baseName, qualsSet] of baseEntries) {
        for (const baseQualifier of qualsSet) {
          const candidates = classesBySimpleName.get(baseName);
          if (candidates === undefined || candidates.length === 0) continue;

          // Compute the expected namespace prefix from the qualifier.
          // Relative qualifier (e.g. `inner`): prepend deriving class's prefix.
          // Absolute qualifiers (`::std`, `ns::other`) will fail the relative
          // lookup and fall through to the prefix-heuristic below.
          const normalizedQualifier = baseQualifier.replace(/::/g, '.');
          const expectedNs =
            baseQualifier && classEntry.nsPrefix
              ? classEntry.nsPrefix + '.' + normalizedQualifier
              : normalizedQualifier;

          if (candidates.length === 1) {
            // Unqualified base: accept unique match (pre-existing behavior).
            if (!baseQualifier) {
              bases.add(candidates[0].nodeId);
              continue;
            }
            // Qualified base: verify namespace before accepting.
            if (
              candidates[0].nsPrefix === expectedNs ||
              candidates[0].nsPrefix === normalizedQualifier
            ) {
              bases.add(candidates[0].nodeId);
            }
            // else: suppress — qualifier doesn't match. #1564 policy.
            continue;
          }

          // V3: qualifier-based exact targeting. When the base specifier
          // carries a syntactic qualifier, compute the expected namespace
          // prefix and attempt an exact (===) match using the deduplicated
          // nsPrefix. Dedup by nodeId removes broken entries from the
          // classesBySimpleName index, making the surviving nsPrefix reliable.
          if (baseQualifier) {
            const qualifierMatch = candidates.find(
              (c) => c.nsPrefix === expectedNs || c.nsPrefix === normalizedQualifier,
            );
            if (qualifierMatch !== undefined) {
              bases.add(qualifierMatch.nodeId);
              continue;
            }
            continue; // qualifier was explicit but no match — suppress, don't fall through to V2
          }

          // V2 fallback: filter by prefix-match capped at one level deeper,
          // then accept only if exactly one candidate survives.
          const nsMatches = candidates.filter((c) => {
            if (c.nsPrefix === classEntry.nsPrefix) return true;
            if (classEntry.nsPrefix === '') {
              return c.nsPrefix !== '' && !c.nsPrefix.includes('.');
            }
            if (c.nsPrefix.startsWith(classEntry.nsPrefix + '.')) {
              const suffix = c.nsPrefix.slice(classEntry.nsPrefix.length + 1);
              return !suffix.includes('.');
            }
            return false;
          });
          const nsMatch = nsMatches.length === 1 ? nsMatches[0] : undefined;
          if (nsMatch !== undefined) {
            bases.add(nsMatch.nodeId);
          }
          // else: ambiguous (multiple candidates, no namespace match) → skip.
        }
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
  const enclosing = findEnclosingClassDef(callerScopeId, scopes);
  if (enclosing === undefined) return false;
  const bases = dependentBaseNodeIds.get(enclosing.nodeId);
  if (bases === undefined) return false;
  if (bases.has('*pack-expansion*')) {
    if (candidateDef.ownerId !== undefined) return candidateDef.ownerId !== enclosing.nodeId;
    if (candidateDef.type !== 'Method' && candidateDef.type !== 'Constructor') return false;
    const ownerName = getQualifiedParentName(candidateDef.qualifiedName);
    const enclosingName = getQualifiedSimpleName(enclosing.qualifiedName);
    return ownerName !== undefined && ownerName !== enclosingName;
  }
  if (candidateDef.ownerId === undefined) return false;
  return bases.has(candidateDef.ownerId);
}

function getQualifiedParentName(qualifiedName: string | undefined): string | undefined {
  if (qualifiedName === undefined) return undefined;
  const lastDot = qualifiedName.lastIndexOf('.');
  if (lastDot < 0) return undefined;
  const parent = qualifiedName.slice(0, lastDot);
  return getQualifiedSimpleName(parent);
}

function getQualifiedSimpleName(qualifiedName: string | undefined): string | undefined {
  if (qualifiedName === undefined) return undefined;
  const lastDot = qualifiedName.lastIndexOf('.');
  return lastDot >= 0 ? qualifiedName.slice(lastDot + 1) : qualifiedName;
}
