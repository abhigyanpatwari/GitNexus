/**
 * Build a `localName → targetFilePath` map over visible namespace imports.
 * Defaults to module scope; callers can opt into lexical scope traversal.
 *
 * Namespace imports (`import X`, `import X as Y`) bind a name that can
 * appear as a receiver in member calls (`X.foo()`, `Y.foo()`). Named
 * imports (`from X import foo`) bind `foo` directly and are a different
 * resolution path.
 *
 * Why not consult `scope.bindings` directly? For namespace imports
 * where the target module has no self-named def,
 * `finalize-algorithm.ts:540` skips binding creation entirely, so
 * `scope.bindings.get('X')` returns undefined. We iterate
 * `indexes.imports` to recover those targets.
 *
 * Next-consumer contract: any language with namespace-style imports
 * (TypeScript `import * as X`, Java static import, Ruby `require`)
 * uses this directly. The finalized `ImportEdge.kind === 'namespace'`
 * classification is authoritative; providers may produce it directly from
 * syntax or reclassify a named import after target resolution proves it names
 * a module.
 *
 * A namespace edge may be reachable under TWO receiver spellings: the name it
 * binds locally, and — for a language that opts in via
 * `ScopeResolver.namespaceReceiverIncludesImportPath` — the dotted module path
 * it was imported under (#2826). Python's `import a.b` binds only `a` while
 * the call site writes `a.b`, so both keys are needed. The opt-in exists
 * because the edge shape alone cannot tell that case from Swift's
 * `import Foo.Bar`, where the same pair means the opposite thing — see the
 * hook's contract note.
 *
 * Lexically scoped imports are collected from the reference's scope outward.
 * The nearest scope owning an import name wins; sibling imports are invisible.
 */

import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { ScopeResolver } from '../contract/scope-resolver.js';

export interface NamespaceTargetOptions {
  /** Reference scope for providers that bind imports lexically. */
  readonly inScope?: ScopeId;
  /** `ScopeResolver.namespaceReceiverPaths` for the file's language. Absent
   *  (or returning `undefined` per edge) keeps the local-name-only default:
   *  the extra spellings are opt-in, never inferred from the edge shape. */
  readonly receiverPaths?: ScopeResolver['namespaceReceiverPaths'];
  /** Whether a path is a module the workspace parsed. Lets a provider propose
   *  a prefix file and have it dropped when absent, instead of minting a key
   *  to a file that does not exist. Defaults to "nothing exists". */
  readonly moduleFileExists?: (filePath: string) => boolean;
}

export function collectNamespaceTargets(
  parsed: Pick<ParsedFile, 'moduleScope'>,
  scopes: ScopeResolutionIndexes,
  options?: NamespaceTargetOptions,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const scopeIds: ScopeId[] = [];
  let scopeId: ScopeId | null = options?.inScope ?? parsed.moduleScope;
  const visited = new Set<ScopeId>();
  while (scopeId !== null && !visited.has(scopeId)) {
    visited.add(scopeId);
    scopeIds.push(scopeId);
    if (scopeId === parsed.moduleScope) break;
    scopeId = scopes.scopeTree.getScope(scopeId)?.parent ?? null;
  }

  const addTarget = (key: string, targetFile: string): void => {
    let targets = out.get(key);
    if (targets === undefined) {
      targets = [];
      out.set(key, targets);
    }
    if (!targets.includes(targetFile)) targets.push(targetFile);
  };

  const moduleFileExists = options?.moduleFileExists ?? ((): boolean => false);

  const claimedNames = new Set<string>();
  for (const id of scopeIds) {
    const edges = scopes.imports.get(id) ?? [];
    const namesHere = new Set<string>();
    for (const edge of edges) {
      namesHere.add(edge.localName);
      if (claimedNames.has(edge.localName)) continue;
      if (edge.targetFile === null || edge.kind !== 'namespace') continue;

      const spellings = options?.receiverPaths?.(
        {
          localName: edge.localName,
          importPath: edge.targetExportedName,
          targetFile: edge.targetFile,
        },
        moduleFileExists,
      );
      if (spellings === undefined) addTarget(edge.localName, edge.targetFile);
      else for (const [spelling, targetFile] of spellings) addTarget(spelling, targetFile);
    }
    for (const name of namesHere) claimedNames.add(name);
  }
  return out;
}
