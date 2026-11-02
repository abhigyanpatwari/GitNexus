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
import { collectCobolSourceCfgs } from './cobol/flow.js';
import { cobolRenameProvider } from './cobol/rename.js';
import {
  emitCobolScopeCaptures,
  interpretCobolImport,
  cobolImportOwningScope,
  cobolReceiverBinding,
} from './cobol/index.js';

export const cobolProvider = defineLanguage({
  id: SupportedLanguages.Cobol,
  parseStrategy: 'standalone',
  extensions: ['.cbl', '.cob', '.cobol', '.cpy', '.copybook'],
  entryPointPatterns: [],
  astFrameworkPatterns: [],
  treeSitterQueries: '',
  typeConfig: {
    declarationNodeTypes: new Set(),
    extractDeclaration: () => null,
    extractParameter: () => null,
  },
  exportChecker: () => false,
  rename: cobolRenameProvider,

  // Standalone source provider: program regions preserve paragraph fallthrough
  // and PERFORM return continuations without introducing an AST dependency.
  collectSourceCfgs: collectCobolSourceCfgs,

  // ── Scope-resolution hooks ───────────────────────────────────────
  emitScopeCaptures: emitCobolScopeCaptures,
  interpretImport: interpretCobolImport,
  // `COPY` is a pure textual splice by the copybook preprocessor — the
  // `#include` case exactly, and COBOL's only import form. It is spliced before
  // anything runs, so a copybook cycle built from `COPY` statements is real and
  // must not be tagged `runsOnlyWhenCalled` by the central Pass-3 position rule.
  //
  // Procedure scopes include their bodies, so COPY inside a paragraph must
  // still retain its textual-splice semantics.
  importsExecuteWhereWritten: false,
  importOwningScope: cobolImportOwningScope,
  receiverBinding: cobolReceiverBinding,
});
