/**
 * Pure predicates gating C# `using` suffix-fallback resolution so BCL usings
 * (e.g. `System.Threading.Tasks`) can't match a coincidentally-named local
 * file (#1881).
 *
 * Lives in the shared `ingestion/` layer — NOT under `languages/csharp/` — so
 * BOTH the registry-primary scope resolver (`languages/csharp/import-target.ts`)
 * and the legacy DAG resolver (`import-resolvers/csharp.ts`) can import it
 * without an `import-resolvers/ -> languages/` dependency inversion (#5).
 */

import type { CSharpNamespaceEvidence } from './language-config.js';

/**
 * Whether the unanchored suffix fallback may run for `targetRaw`.
 *
 * Fails OPEN when the namespace scan was truncated (large repos must not
 * silently lose legitimate edges, #1881 #11) and when no evidence was
 * threaded at all (preserves legacy permissive behavior). Otherwise defers
 * to {@link importAlignsWithDeclaredNamespaces}.
 */
export function csharpSuffixFallbackAllowed(
  targetRaw: string,
  evidence: CSharpNamespaceEvidence | undefined,
): boolean {
  if (evidence === undefined) return true;
  if (evidence.truncated) return true;
  return importAlignsWithDeclaredNamespaces(
    targetRaw,
    evidence.declaredNamespaces,
    evidence.rootNamespaces,
  );
}

/** True when `targetRaw` plausibly refers to a namespace declared in-repo. */
export function importAlignsWithDeclaredNamespaces(
  targetRaw: string,
  declaredNamespaces: ReadonlySet<string> | undefined,
  rootNamespaces?: ReadonlySet<string>,
): boolean {
  if (declaredNamespaces === undefined || declaredNamespaces.size === 0) return false;

  // Exact: the import IS a declared in-repo namespace.
  if (declaredNamespaces.has(targetRaw)) return true;

  // Child-of: the import's IMMEDIATE parent namespace is declared in-repo.
  // Anchoring on the direct parent — not "any declared prefix" — is what stops
  // a declared BCL prefix from green-lighting an unrelated BCL using: a repo
  // that declares `namespace System;` must NOT make `using
  // System.Threading.Tasks;` resolve to a coincidental local `Tasks.cs`,
  // because the import's parent `System.Threading` is not itself declared
  // (#1881). The case this still allows is a type / `using static` import under
  // a declared namespace laid out without its full path on disk, e.g.
  // `using static MyApp.Utils.Logger;` when `MyApp.Utils` is declared.
  const lastDot = targetRaw.lastIndexOf('.');
  if (lastDot > 0 && declaredNamespaces.has(targetRaw.slice(0, lastDot))) return true;

  // Ancestor-of: the import is a strict prefix of some declared namespace
  // (e.g. `using MyApp;` when `MyApp.Models` is declared). Only honored when
  // the import also sits at or above an in-repo root namespace, so a BCL prefix
  // can't qualify merely because a file declares something deeper under it
  // (e.g. `System.Threading.Tasks.Extensions`) (#1881).
  const childPrefix = targetRaw + '.';
  for (const ns of declaredNamespaces) {
    if (ns.startsWith(childPrefix)) {
      return isAtOrAboveInRepoRoot(targetRaw, declaredNamespaces, rootNamespaces);
    }
  }
  return false;
}

function isAtOrAboveInRepoRoot(
  targetRaw: string,
  declaredNamespaces: ReadonlySet<string>,
  rootNamespaces: ReadonlySet<string> | undefined,
): boolean {
  const descendantPrefix = targetRaw + '.';
  if (rootNamespaces !== undefined && rootNamespaces.size > 0) {
    for (const root of rootNamespaces) {
      // targetRaw equals a root, or is an ancestor of one (e.g. `using MyApp;`
      // for csproj RootNamespace `MyApp.Core`).
      if (root === targetRaw || root.startsWith(descendantPrefix)) return true;
    }
    return false;
  }
  // No explicit roots (e.g. no csproj): treat the top-level segment of each
  // declared namespace as the implied root.
  for (const ns of declaredNamespaces) {
    const dot = ns.indexOf('.');
    const top = dot === -1 ? ns : ns.slice(0, dot);
    if (top === targetRaw) return true;
  }
  return false;
}
