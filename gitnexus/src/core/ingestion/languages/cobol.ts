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
  // `COPY` is a pure textual splice by the copybook preprocessor — the
  // `#include` case exactly, and COBOL's only import form. It is spliced before
  // anything runs, so a copybook cycle built from `COPY` statements is real and
  // must not be tagged `runsOnlyWhenCalled` by the central Pass-3 position rule.
  //
  // LATENT today, declared anyway. `cobol/captures.ts` ranges every
  // `@scope.function` (PROCEDURE DIVISION sections and paragraphs) over a
  // SINGLE line — `rangeOf(line, 0, line, endCol)` — so a `COPY` on any later
  // line never resolves inside a Function scope and Pass 3 has nothing to mark.
  // The flag is here so that giving those anchors their true multi-line ranges
  // is a scope-resolution fix and not, silently, a cycle-suppression bug.
  // See `LanguageProvider.importsExecuteWhereWritten`.
  importsExecuteWhereWritten: false,
  importOwningScope: cobolImportOwningScope,
  receiverBinding: cobolReceiverBinding,
});
