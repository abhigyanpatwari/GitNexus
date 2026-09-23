/**
 * Lean 4 `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed
 * by the generic `runScopeResolution` orchestrator.
 *
 * Lean's scope model for MVP: Module (file) + Function (every named
 * declaration; structures/classes refined by the ETL phase which owns
 * the graph nodes), no inheritance modeling, no method receivers.
 *
 * Structural CALLS/IMPORTS edges for Lean are owned by the Lean ETL
 * phase (precomputed LeanGraph); this resolver contributes name
 * binding + file-level import targets, same split as the COBOL wiring.
 *
 * Reference: `languages/cobol/scope-resolver.ts`.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { leanProvider } from '../lean.js';

/**
 * Map a dotted Lean module path to a repo-relative file path.
 * `Mathlib.Analysis.Calculus.Deriv.MeanValue` → `Mathlib/Analysis/Calculus/Deriv/MeanValue.lean`.
 * `open` targets resolve identically (targetRaw is the dotted path either way).
 */
export function resolveLeanImportTarget(
  targetRaw: string,
  _fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const candidate = `${targetRaw.replace(/\./g, '/')}.lean`;
  if (allFilePaths.has(candidate)) return candidate;
  // Suffix fallback: match `<tail>/X/Y.lean` for repos rooted under a subdir.
  const tail = `/${candidate}`;
  for (const p of allFilePaths) {
    if (p.endsWith(tail)) return p;
  }
  return null;
}

const leanScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Lean,
  languageProvider: leanProvider,
  importEdgeReason: 'lean-scope: import/open',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    return resolveLeanImportTarget(targetRaw, fromFile, allFilePaths);
  },

  // Lean binding: local-first-then-imports (same as the default).
  mergeBindings: (existing) => [...existing],

  // No arity model for Lean callsites in MVP.
  arityCompatibility: () => 'unknown',

  // Everything lives under the file Module scope.
  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // Lean has no super calls.
  isSuperReceiver: () => false,

  // Structural edges owned by the Lean ETL phase; scope contributes binding only.
  scopeResolutionEdgeMode: 'callable-flow-only',

  // No inheritance in Lean MVP — empty MRO map.
  buildMro: () => new Map(),

  // ── Optional toggles ─────────────────────────────────────────────
  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: false,
};

export { leanScopeResolver };
