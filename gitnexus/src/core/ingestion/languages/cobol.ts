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

  // ── Scope-resolution hooks ───────────────────────────────────────
  emitScopeCaptures: emitCobolScopeCaptures,
  interpretImport: interpretCobolImport,
  importOwningScope: cobolImportOwningScope,
  receiverBinding: cobolReceiverBinding,
});
