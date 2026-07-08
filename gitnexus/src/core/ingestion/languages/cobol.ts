/**
 * COBOL Language Provider
 *
 * Standalone regex-based processor — no tree-sitter grammar.
 * COBOL files (.cbl, .cob, .cobol, .cpy, .copybook) are detected and
 * processed by cobol-processor.ts in pipeline Phase 2.6, not by the
 * tree-sitter pipeline.
 *
 * This provider supports scope-based resolution (RFC #909 Ring 3) via
 * `emitScopeCaptures` which wraps the regex tagger. COPY statements are
 * interpreted as imports; there is no type system and no implicit receiver.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import {
  emitCobolScopeCaptures,
  interpretCobolImport,
  cobolImportOwningScope,
  cobolReceiverBinding,
} from './cobol/index.js';

export const cobolProvider = defineLanguage({
  id: SupportedLanguages.Cobol,
  parseStrategy: 'standalone',
  extensions: [], // COBOL files detected by cobol-processor's isCobolFile/isJclFile
  entryPointPatterns: [],
  astFrameworkPatterns: [],
  treeSitterQueries: '',
  typeConfig: {
    declarationNodeTypes: new Set(),
    extractDeclaration: () => null,
    extractParameter: () => null,
  },
  exportChecker: () => false,
  importResolver: () => null,

  // No `cfgVisitor`: COBOL is the deliberate non-goal of the PDG-language
  // rollout (#2195). There is no installed tree-sitter grammar and COBOL's
  // PERFORM / GO-TO control flow is exotic; the worker's `provider.cfgVisitor &&`
  // gate therefore emits no CFG/PDG layer for COBOL (see worker-roundtrip.test.ts).

  // ── Scope-resolution hooks ───────────────────────────────────────
  emitScopeCaptures: emitCobolScopeCaptures,
  interpretImport: interpretCobolImport,
  importOwningScope: cobolImportOwningScope,
  receiverBinding: cobolReceiverBinding,
});
