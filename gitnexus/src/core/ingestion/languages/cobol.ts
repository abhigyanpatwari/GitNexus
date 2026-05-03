/**
 * COBOL Language Provider
 *
 * Standalone regex-based processor — no tree-sitter grammar.
 * COBOL files (.cbl, .cob, .cobol, .cpy, .copybook) are detected and
 * processed by cobol-processor.ts in pipeline Phase 2.6, not by the
 * tree-sitter pipeline.
 *
 * This provider exists to satisfy the SupportedLanguages exhaustiveness
 * checks and to declare parseStrategy: 'standalone'.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';

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
});
