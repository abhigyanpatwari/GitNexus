/**
 * Lean 4 Language Provider.
 *
 * Standalone regex-based processor — no tree-sitter grammar.
 * Lean files (.lean) are detected by extension; declarations and
 * imports are extracted by `lean/captures.ts`, interpreted by
 * `lean/interpret.ts`, and file-target resolution lives in
 * `lean/scope-resolver.ts`.
 *
 * Proof-dependency (tactic-body) edges are deliberately out of scope
 * here: they arrive via the Lean ETL phase from the precomputed
 * LeanGraph (`~/data/leangraph-428/mathlib428.ndjson`), whose elaborator
 * sees what regex cannot.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import {
  emitLeanScopeCaptures,
  interpretLeanImport,
  leanImportOwningScope,
  leanReceiverBinding,
} from './lean/index.js';

export const leanProvider = defineLanguage({
  id: SupportedLanguages.Lean,
  parseStrategy: 'standalone',
  extensions: ['.lean'],
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

  // No `cfgVisitor`: control-flow graphs over tactic blocks are a
  // deliberate non-goal for the regex MVP (same posture as COBOL's
  // PERFORM/GO-TO exclusion).

  // ── Scope-resolution hooks ───────────────────────────────────────
  emitScopeCaptures: emitLeanScopeCaptures,
  interpretImport: interpretLeanImport,
  // `import` is load-time; `open` brings names into scope where written.
  // MVP resolves both file-wide (see `leanImportOwningScope`).
  importsExecuteWhereWritten: false,
  importOwningScope: leanImportOwningScope,
  receiverBinding: leanReceiverBinding,
});
