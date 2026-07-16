/**
 * Move Language Provider (stub).
 *
 * Move/Aptos is ingested compiler-first via the move-flow MCP server in the
 * `moveIngest` phase — GitNexus never tree-sits or regex-scans Move source.
 * This provider exists only to satisfy the exhaustive `SupportedLanguages`
 * provider table; it declares no extensions, so `.move` files are never routed
 * through the generic tree-sitter / scope-resolution pipeline (the `parse`
 * phase additionally excludes every file ingested by `moveIngest`).
 */
import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';

export const moveProvider = defineLanguage({
  id: SupportedLanguages.Move,
  parseStrategy: 'standalone',
  extensions: [], // .move files are handled by the moveIngest phase, not here
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
