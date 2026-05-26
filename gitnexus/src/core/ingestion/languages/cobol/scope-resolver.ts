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

const cobolScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Cobol,
  languageProvider: cobolProvider,
  importEdgeReason: 'cobol-scope: copy',

  // ── Resolve COPY bookname to file path ─────────────────────────────
  resolveImportTarget: (targetRaw, _fromFile, allFilePaths) => {
    const upper = targetRaw.toUpperCase();
    // Check copybook files first
    for (const fp of allFilePaths) {
      const ext = path.extname(fp).toLowerCase();
      if (!COPYBOOK_EXTENSIONS.has(ext)) continue;
      const basename = path.basename(fp, ext).toUpperCase();
      if (basename === upper) return fp;
    }
    // Also search COBOL source files (.cbl, .cob, .cobol)
    const COBOL_SOURCE_EXTS = new Set(['.cbl', '.cob', '.cobol']);
    for (const fp of allFilePaths) {
      const ext = path.extname(fp).toLowerCase();
      if (!COBOL_SOURCE_EXTS.has(ext)) continue;
      const basename = path.basename(fp, ext).toUpperCase();
      if (basename === upper) return fp;
    }
    return null;
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
