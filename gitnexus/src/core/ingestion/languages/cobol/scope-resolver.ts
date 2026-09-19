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

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { cobolProvider } from '../cobol.js';
import { resolveCobolCopyTarget } from './copy-target.js';

const cobolScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Cobol,
  languageProvider: cobolProvider,
  importEdgeReason: 'cobol-scope: copy',

  // ── Resolve COPY bookname to file path ─────────────────────────────
  // Shared with the regex processor's resolveCopy (#2967 lockstep).
  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    return resolveCobolCopyTarget(targetRaw, fromFile, allFilePaths);
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
