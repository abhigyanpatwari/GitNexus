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
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { gdscriptImportConfig } from '../import-resolvers/configs/gdscript.js';

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
  importResolver: createImportResolver(gdscriptImportConfig),
  // preload()/load() pull in the whole script as one unit — closest match
  // to GitNexus's 'wildcard-leaf' policy (Go, Ruby, Swift, Dart).
  importSemantics: 'wildcard-leaf',
  mroStrategy: 'first-wins',
});
