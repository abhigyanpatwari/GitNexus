/**
 * GDScript Language Provider (Godot Engine)
 *
 * Scaffolding stage — registers the language and extension mapping so the
 * pipeline recognises .gd files. Tree-sitter queries, call/heritage
 * extraction, and import resolution are intentionally minimal here and
 * will be filled in by subsequent slices.
 *
 * Scene files (.tscn) and project.godot are NOT handled by this provider
 * — they are processed by dedicated pipeline phases (see godot-support
 * plan).
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { GDSCRIPT_QUERIES } from '../tree-sitter-queries.js';

export const gdscriptProvider = defineLanguage({
  id: SupportedLanguages.Godot,
  extensions: ['.gd'],
  entryPointPatterns: [],
  astFrameworkPatterns: [],
  treeSitterQueries: GDSCRIPT_QUERIES,
  typeConfig: {
    declarationNodeTypes: new Set(),
    extractDeclaration: () => null,
    extractParameter: () => null,
  },
  exportChecker: () => false,
  importResolver: () => null,
  importSemantics: 'named',
  mroStrategy: 'first-wins',
});
