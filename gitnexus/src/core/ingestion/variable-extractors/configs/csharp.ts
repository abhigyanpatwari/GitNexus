// gitnexus/src/core/ingestion/variable-extractors/configs/csharp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';
import type { VariableVisibility } from '../../variable-types.js';
import { collectModifierTexts } from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';

/**
 * C# variable extraction config.
 *
 * C# does not have true top-level variables (pre-C# 9). In C# 9+ top-level
 * statements, local_declaration_statement can appear at program scope.
 * Class-scoped fields are handled by the field extractor.
 */
export const csharpVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.CSharp,
  constNodeTypes: [],
  staticNodeTypes: [],
  variableNodeTypes: ['local_declaration_statement'],

  extractName(node) {
    // local_declaration_statement → variable_declaration → variable_declarator → identifier
    const varDecl = node.namedChildren.find((c) => c.type === 'variable_declaration');
    if (!varDecl) return undefined;
    const declarator = varDecl.namedChildren.find((c) => c.type === 'variable_declarator');
    const name = declarator?.childForFieldName('name');
    return name?.type === 'identifier' ? name.text : undefined;
  },

  extractType(node) {
    const varDecl = node.namedChildren.find((c) => c.type === 'variable_declaration');
    if (!varDecl) return undefined;
    const typeNode = varDecl.childForFieldName('type');
    if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    return undefined;
  },

  extractVisibility(node): VariableVisibility {
    const mods = collectModifierTexts(node);
    if (mods.has('public')) return 'public';
    if (mods.has('private')) return 'private';
    if (mods.has('protected') && mods.has('internal')) return 'protected internal';
    if (mods.has('private') && mods.has('protected')) return 'private protected';
    if (mods.has('protected')) return 'protected';
    if (mods.has('internal')) return 'internal';
    return 'private';
  },

  isConst(node) {
    const mods = collectModifierTexts(node);
    return mods.has('const');
  },

  isStatic(node) {
    const mods = collectModifierTexts(node);
    return mods.has('static');
  },

  isMutable(node) {
    const mods = collectModifierTexts(node);
    return !mods.has('const') && !mods.has('readonly');
  },
};
