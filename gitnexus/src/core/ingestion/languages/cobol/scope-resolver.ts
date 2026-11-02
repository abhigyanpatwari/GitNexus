/**
 * COBOL `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed
 * by the generic `runScopeResolution` orchestrator.
 *
 * Program, section, paragraph and qualified data declarations use the shared
 * resolution pipeline without introducing a compiler or inheritance model.
 *
 * Reference: `languages/python/scope-resolver.ts`.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { cobolProvider } from '../cobol.js';
import { resolveCobolCopyTarget } from './copy-target.js';
import {
  cobolRangeKey,
  cobolTokenRange,
  readCobolSemanticSource,
  resolveCobolReference,
} from './semantic.js';

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
  populateOwners: (parsed: ParsedFile) => {
    const qualifiedNames = new Map(parsed.localDefs.map((def) => [def.nodeId, def.qualifiedName]));
    populateClassOwnedMembers(parsed);
    for (const def of parsed.localDefs) def.qualifiedName = qualifiedNames.get(def.nodeId);
  },

  // Observe the provider's exact declaration/qualification model. Structural
  // edges remain owned by cobol-processor; storage-flow expansion is unrelated
  // to the single source declaration named by an operand.
  emitPostResolutionEdges(_graph, parsedFiles, _nodeLookup, _indexes, context) {
    if (!context?.recordSourceBinding) return;
    const sources = parsedFiles.map((parsed) => ({
      parsed,
      facts: readCobolSemanticSource(
        context.fileContents.get(parsed.filePath) ?? '',
        parsed.filePath,
      ),
    }));
    const definitions = new Map(
      sources.flatMap(({ parsed, facts }) => {
        const byRange = new Map(
          parsed.localDefs
            .filter((def) => def.nameRange)
            .map((def) => [cobolRangeKey(def.nameRange!), def]),
        );
        return facts.declarations.flatMap((declaration) => {
          const def = byRange.get(cobolRangeKey(cobolTokenRange(declaration.token)));
          return def ? [[declaration, def] as const] : [];
        });
      }),
    );
    const workspace = sources.map((source) => source.facts);
    for (const { parsed, facts } of sources) {
      const references = new Map(
        facts.references.map((ref) => [cobolRangeKey(cobolTokenRange(ref.token)), ref]),
      );
      for (const site of parsed.referenceSites) {
        const reference = site.nameRange && references.get(cobolRangeKey(site.nameRange));
        if (!reference) continue;
        const targets = resolveCobolReference(reference, facts, workspace);
        const targetDefIds = targets.flatMap((target) => {
          const def = definitions.get(target);
          return def ? [def.nodeId] : [];
        });
        context.recordSourceBinding(site, {
          status:
            targetDefIds.length === 1
              ? 'resolved'
              : targetDefIds.length > 1
                ? 'ambiguous'
                : 'unresolved',
          targetDefIds,
          basis: `cobol-${reference.kind}-binding`,
        });
      }
    }
  },

  // COBOL has no super calls.
  isSuperReceiver: () => false,

  // ── Optional toggles ─────────────────────────────────────────────
  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: false,
};

export { cobolScopeResolver };
