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
 * The nearest scope owns each import name. Providers may retain outer receiver
 * paths that refer to that same namespace object; sibling scopes are invisible.
 */

import type { ParsedFile, ScopeId, SourcePosition, ImportEdge } from 'gitnexus-shared';
import { importEdgeFiles } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { ScopeResolver } from '../contract/scope-resolver.js';
import { lookupNameClaim } from './walkers.js';

export interface NamespaceTargetOptions {
  readonly position?: SourcePosition;
  /** Reference scope for providers that bind imports lexically. */
  readonly inScope?: ScopeId;
  /** `ScopeResolver.namespaceReceiverPaths` for the file's language. Absent
   *  (or returning `undefined` per edge) keeps the local-name-only default:
   *  the extra spellings are opt-in, never inferred from the edge shape. */
  readonly receiverPaths?: ScopeResolver['namespaceReceiverPaths'];
  readonly bindingIdentity?: ScopeResolver['namespaceBindingIdentity'];
  readonly skipEnclosingClasses?: boolean;
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
    const scope = scopeId === parsed.moduleScope ? undefined : scopes.scopeTree.getScope(scopeId);
    if (
      !(options?.skipEnclosingClasses && scope?.kind === 'Class' && scopeId !== options.inScope)
    ) {
      scopeIds.push(scopeId);
    }
    if (scopeId === parsed.moduleScope) break;
    scopeId = scope?.lookupPolicy?.parentScope ?? scope?.parent ?? null;
  }

  // A module import can name hundreds of files: dedupe through a set, not by
  // scanning the list, while keeping first-seen order.
  const added = new Map<string, Set<string>>();
  const addTarget = (key: string, targetFile: string): void => {
    let targets = out.get(key);
    let seen = added.get(key);
    if (targets === undefined || seen === undefined) {
      targets = [];
      seen = new Set();
      out.set(key, targets);
      added.set(key, seen);
    }
    if (seen.has(targetFile)) return;
    seen.add(targetFile);
    targets.push(targetFile);
  };

  const moduleFileExists = options?.moduleFileExists ?? ((): boolean => false);

  const selectionCache = new Map<string, ReturnType<typeof lookupNameClaim>>();
  const initialScope = options?.inScope ?? parsed.moduleScope;
  const useClaims = scopes.scopeTree?.getScope(initialScope)?.bindings !== undefined;
  // Asked per (edge, file): a grouped module import (`statementsAt`) stands
  // for one edge per file, and each is visible exactly when its per-file edge
  // would be.
  const edgeVisible = (edge: ImportEdge, targetFile: string | null): boolean => {
    if (edge.typeOnly === true) return false;
    if (!useClaims) return true; // compatibility with legacy import-only index views
    let claim = selectionCache.get(edge.localName);
    if (claim === undefined) {
      claim = lookupNameClaim(initialScope, edge.localName, scopes, {
        position: options?.position,
        purpose: 'value',
        skipEnclosingClasses: options?.skipEnclosingClasses,
      });
      selectionCache.set(edge.localName, claim);
    }
    if (claim.imports.includes(edge)) return true;
    // A provider may prove that a nearer import and an outer dotted path denote
    // the same namespace object. Keep that path without admitting other names.
    if (
      claim.status !== 'resolved' ||
      options?.bindingIdentity === undefined ||
      targetFile === null ||
      edge.kind !== 'namespace'
    )
      return false;
    const identity = options.bindingIdentity({
      localName: edge.localName,
      importPath: edge.targetExportedName,
      targetFile,
      explicitAlias: edge.explicitAlias,
    });
    return (
      identity !== undefined &&
      claim.imports.some(
        (candidate) =>
          candidate.kind === 'namespace' &&
          importEdgeFiles(candidate, scopes.imports).some(
            (candidateFile) =>
              options.bindingIdentity!({
                localName: candidate.localName,
                importPath: candidate.targetExportedName,
                targetFile: candidateFile,
                explicitAlias: candidate.explicitAlias,
              }) === identity,
          ),
      )
    );
  };
  const claimedNames = new Map<string, string | undefined>();
  for (const id of scopeIds) {
    // Each edge with the file it names; a grouped module import once per file.
    const edges = (scopes.imports.statementsAt(id) ?? []).flatMap((edge) =>
      edge.groupsFiles === true
        ? importEdgeFiles(edge, scopes.imports).map((targetFile) => ({ edge, targetFile }))
        : [{ edge, targetFile: edge.targetFile }],
    );
    const namesHere = new Map<string, string | undefined>();
    const conflictingNames = new Set<string>();
    const candidates = edges.flatMap(({ edge, targetFile }) => {
      if (!edgeVisible(edge, targetFile)) return [];
      const namespace =
        targetFile !== null && edge.kind === 'namespace' && edge.linkStatus !== 'unresolved'
          ? {
              localName: edge.localName,
              importPath: edge.targetExportedName,
              targetFile: edge.namespaceTargetFile ?? targetFile,
              explicitAlias: edge.explicitAlias,
            }
          : undefined;
      const identity = namespace === undefined ? undefined : options?.bindingIdentity?.(namespace);
      if (!namesHere.has(edge.localName)) namesHere.set(edge.localName, identity);
      else if (identity === undefined || namesHere.get(edge.localName) !== identity) {
        namesHere.set(edge.localName, undefined);
        conflictingNames.add(edge.localName);
      }
      return [{ edge, namespace, identity }];
    });
    // Resolve ownership before emitting: import order alone cannot distinguish
    // rebinding from conditional alternatives. Providers without an identity
    // hook retain their existing multi-target behavior within a scope.
    for (const { edge, namespace, identity } of candidates) {
      if (options?.bindingIdentity !== undefined && conflictingNames.has(edge.localName)) continue;
      if (
        claimedNames.has(edge.localName) &&
        (identity === undefined || claimedNames.get(edge.localName) !== identity)
      )
        continue;
      if (namespace === undefined) continue;

      const spellings = options?.receiverPaths?.(namespace, moduleFileExists);
      if (spellings === undefined) addTarget(edge.localName, namespace.targetFile);
      else for (const [spelling, targetFile] of spellings) addTarget(spelling, targetFile);
    }
    for (const [name, identity] of namesHere) {
      if (!claimedNames.has(name)) claimedNames.set(name, identity);
    }
  }
  return out;
}
