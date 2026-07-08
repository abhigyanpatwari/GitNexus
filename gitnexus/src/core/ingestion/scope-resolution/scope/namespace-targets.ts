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
 * uses this directly. `ParsedImport.kind === 'namespace'` is the
 * cross-language hook.
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

export function collectNamespaceTargets(
  parsed: ParsedFile,
  scopes: ScopeResolutionIndexes,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const moduleEdges = scopes.imports.get(parsed.moduleScope);
  if (moduleEdges === undefined) return out;

  const namespaceLocals = new Set<string>();
  for (const imp of parsed.parsedImports) {
    if (imp.kind === 'namespace') namespaceLocals.add(imp.localName);
  }

  for (const edge of moduleEdges) {
    if (edge.targetFile === null) continue;
    if (!namespaceLocals.has(edge.localName)) continue;
    let targets = out.get(edge.localName);
    if (targets === undefined) {
      targets = [];
      out.set(edge.localName, targets);
    }
    if (!targets.includes(edge.targetFile)) targets.push(edge.targetFile);
  }
  return out;
}
