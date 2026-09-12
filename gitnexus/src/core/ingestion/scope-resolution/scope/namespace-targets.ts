/**
 * Build a per-file `localName → targetFilePath` map over the file's
 * module-scope namespace-kind import edges.
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
 * Scope-chain concern (verified 2026-04-21): `pythonImportOwningScope`
 * documents that function-local and class-body imports bind to the
 * inner scope, which would make a module-only read incomplete. In
 * practice `finalize-algorithm` places ALL of a file's ImportEdges
 * onto `indexes.imports[moduleScope]` regardless of where the
 * `import` statement appears — the integration fixtures
 * `python-function-local-namespace-import` and
 * `python-class-body-namespace-import` both emit correct CALLS edges
 * with reason "namespace-receiver", demonstrating that the module-
 * scope read is sufficient today. If finalize routing ever changes to
 * honor the hook's per-scope contract, this function must walk the
 * reference-site scope chain (mirror `findExportedDefByName`).
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { ScopeResolver } from '../contract/scope-resolver.js';

export interface NamespaceTargetOptions {
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
  parsed: ParsedFile,
  scopes: ScopeResolutionIndexes,
  options?: NamespaceTargetOptions,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const moduleEdges = scopes.imports.get(parsed.moduleScope);
  if (moduleEdges === undefined) return out;

  const addTarget = (key: string, targetFile: string): void => {
    let targets = out.get(key);
    if (targets === undefined) {
      targets = [];
      out.set(key, targets);
    }
    if (!targets.includes(targetFile)) targets.push(targetFile);
  };

  const moduleFileExists = options?.moduleFileExists ?? ((): boolean => false);

  for (const edge of moduleEdges) {
    if (edge.targetFile === null || edge.kind !== 'namespace') continue;

    const spellings = options?.receiverPaths?.(
      {
        localName: edge.localName,
        importPath: edge.targetExportedName,
        targetFile: edge.targetFile,
      },
      moduleFileExists,
    );

    // A provider that declines this edge — or has no hook — gets the default:
    // the bound name alone, pointing at this edge's own target.
    if (spellings === undefined) {
      addTarget(edge.localName, edge.targetFile);
      continue;
    }
    for (const [spelling, targetFile] of spellings) addTarget(spelling, targetFile);
  }
  return out;
}
