/**
 * COBOL `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed
 * by the generic `runScopeResolution` orchestrator.
 *
 * The provider is a thin wiring object — COBOL's simple scope model
 * (Module + Function only, no inheritance, no type system) plugs into
 * `runScopeResolution` with minimal configuration.
 *
 * Reference: `languages/python/scope-resolver.ts`.
 */

import path from 'node:path';
import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { cobolProvider } from '../cobol.js';

// Copybook file extensions for COPY name resolution
const COPYBOOK_EXTENSIONS = new Set(['.cpy', '.copybook']);
// COBOL source files, searched only after every copybook has missed.
const COBOL_SOURCE_EXTENSIONS = new Set(['.cbl', '.cob', '.cobol']);

/**
 * Uppercased-basename → first file carrying it, one map PER TIER, memoized on
 * the `allFilePaths` Set identity (#2908).
 *
 * `resolveImportTarget` used to run two full workspace scans per `COPY` — one
 * for the copybook tier, one for the source tier — each calling `path.extname`
 * + `path.basename` + `toUpperCase` on every entry. A `COPY` of a member that
 * lives outside the repo (the common case: vendor and system copybooks) missed
 * in both, so both scans always ran to completion, making resolution
 * O(copies × files). The orchestrator passes the SAME Set to every import in a
 * pass (`pipeline/run.ts` builds it once), so a `WeakMap` keyed on that Set
 * turns the scans into one build per run.
 *
 * Two tiers rather than one map is the tie-break, not a stylistic choice: a
 * `.cpy`/`.copybook` hit beats a `.cbl`/`.cob`/`.cobol` hit even when the source
 * file comes FIRST in Set-iteration order, which is exactly what collapsing the
 * tiers into a single first-wins map would silently discard. Within a tier the
 * first file in Set-iteration order wins, mirroring the `return` on first match
 * in the scans this replaces.
 *
 * The per-file key is derived with the same `path.extname(fp).toLowerCase()` →
 * `path.basename(fp, ext)` → `toUpperCase()` sequence the scans used, including
 * its quirk: `path.basename` strips the suffix only on an exact, case-sensitive
 * match, so `Foo.CPY` indexes under `FOO.CPY` rather than `FOO`. Node's `path`
 * stays in the loop for the same reason — on POSIX it does not treat `\` as a
 * separator, and hand-rolled slicing on `/` would start resolving backslash
 * paths the scans never resolved.
 */
interface CobolCopyIndex {
  /** `.cpy` / `.copybook` files — tier 1. */
  readonly copybooks: ReadonlyMap<string, string>;
  /** `.cbl` / `.cob` / `.cobol` files — tier 2. */
  readonly sources: ReadonlyMap<string, string>;
}

const COBOL_COPY_INDEX_CACHE = new WeakMap<ReadonlySet<string>, CobolCopyIndex>();

function getCobolCopyIndex(allFilePaths: ReadonlySet<string>): CobolCopyIndex {
  const cached = COBOL_COPY_INDEX_CACHE.get(allFilePaths);
  if (cached !== undefined) return cached;

  const copybooks = new Map<string, string>();
  const sources = new Map<string, string>();
  // One pass builds both tiers: the two scans walked the same files and
  // classified each by the same extension test.
  for (const fp of allFilePaths) {
    const ext = path.extname(fp).toLowerCase();
    const tier = COPYBOOK_EXTENSIONS.has(ext)
      ? copybooks
      : COBOL_SOURCE_EXTENSIONS.has(ext)
        ? sources
        : undefined;
    if (tier === undefined) continue;
    const basename = path.basename(fp, ext).toUpperCase();
    // First in Set-iteration order wins, as the scans' first-match `return` did.
    if (!tier.has(basename)) tier.set(basename, fp);
  }

  const built: CobolCopyIndex = { copybooks, sources };
  COBOL_COPY_INDEX_CACHE.set(allFilePaths, built);
  return built;
}

const cobolScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Cobol,
  languageProvider: cobolProvider,
  importEdgeReason: 'cobol-scope: copy',

  // ── Resolve COPY bookname to file path ─────────────────────────────
  resolveImportTarget: (targetRaw, _fromFile, allFilePaths) => {
    const upper = targetRaw.toUpperCase();
    const index = getCobolCopyIndex(allFilePaths);
    // Copybooks first, then COBOL sources — the tier order IS the tie-break.
    return index.copybooks.get(upper) ?? index.sources.get(upper) ?? null;
  },

  // COBOL has no binding-merge rules beyond the default (local-first-then-imports).
  mergeBindings: (existing) => [...existing],

  // COBOL arity: compare CALL USING param count against def's parameterCount.
  // COBOL requires exact arity match for CALL USING.
  arityCompatibility: (callsite, def) => {
    if (callsite.arity === undefined) return 'unknown';
    const defParamCount = def.parameterCount;
    if (defParamCount === undefined) return 'unknown';
    if (callsite.arity === defParamCount) return 'compatible';
    return 'incompatible';
  },

  // PROGRAM-ID declarations bridge to legacy Module graph nodes. COBOL's
  // procedure-pointer ENTRY values therefore target Module defs, while every
  // AST-backed provider keeps the shared callable-label default.
  isCallableValueTarget: (def) => def.type === 'Module',

  // Structural COBOL CALLS/IMPORTS remain owned by the established regex
  // processor; this resolver contributes only procedure-pointer CALLS.
  scopeResolutionEdgeMode: 'callable-flow-only',

  // No inheritance in COBOL — empty MRO map.
  buildMro: () => new Map(),

  // Everything lives under the PROGRAM-ID Module scope.
  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // COBOL has no super calls.
  isSuperReceiver: () => false,

  // ── Optional toggles ─────────────────────────────────────────────
  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: false,
};

export { cobolScopeResolver };
