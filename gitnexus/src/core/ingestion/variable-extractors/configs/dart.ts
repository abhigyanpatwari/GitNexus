// gitnexus/src/core/ingestion/variable-extractors/configs/dart.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';
import type { VariableVisibility } from '../../variable-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Dart variable extraction config.
 *
 * Top-level Dart variables are NOT wrapped in a `declaration` node (that wrapper
 * only occurs for class-body members). The structure query (`DART_QUERIES`)
 * captures them as `@definition.variable` on the loose container node, which is
 * one of two real shapes:
 *
 *   - `var name = 'x';` / `int x = 5;`
 *       → initialized_identifier_list > initialized_identifier > identifier
 *   - `final int count = 3;` / `const a = 1, b = 2;`
 *       → static_final_declaration_list > static_final_declaration > identifier
 *
 * The variable extractor is invoked on that captured container node to enrich
 * the Variable symbol with name(s)/type/const/mutable metadata.
 *
 * NOTE: the const/final modifier (`const_builtin` / `final_builtin`) and the
 * type annotation (`type_identifier`) are siblings of the captured container —
 * they live on the parent (program), NOT inside it — so const-ness and the type
 * are read from the captured node's parent. (This is why the previous
 * `type_identifier`-as-direct-child read found nothing.)
 */

/** The `initialized_identifier` / `static_final_declaration` name children. */
function nameNodes(container: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < container.namedChildCount; i++) {
    const entry = container.namedChild(i);
    if (!entry) continue;
    if (entry.type === 'initialized_identifier' || entry.type === 'static_final_declaration') {
      const ident = entry.firstNamedChild;
      if (ident?.type === 'identifier') out.push(ident);
    }
  }
  return out;
}

function extractDartVarNames(node: SyntaxNode): string[] {
  return nameNodes(node).map((n) => n.text);
}

/**
 * Scan the container's immediately-preceding siblings (the modifier / type
 * nodes of THIS declaration), stopping at the previous statement's `;` so a
 * neighbouring declaration's modifiers/type never bleed in. Top-level Dart
 * declarations sit as loose siblings under `program` separated by `;`:
 *   final int count = 3; var name = 'x'; const a = 1, b = 2;
 * so the leading `type_identifier` / `const_builtin` / `final_builtin` of a
 * declaration are the siblings between the prior `;` and the captured container.
 */
function scanLeadingSiblings(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  let sib = node.previousSibling;
  while (sib !== null && sib.type !== ';') {
    out.push(sib);
    sib = sib.previousSibling;
  }
  return out;
}

/**
 * The declared type annotation, read from the captured container's leading
 * sibling `type_identifier`. Returns undefined for inferred (`var`)
 * declarations, which have an `inferred_type` sibling instead.
 */
function extractDartVarType(node: SyntaxNode): string | undefined {
  for (const sib of scanLeadingSiblings(node)) {
    if (sib.type === 'type_identifier') return sib.text;
  }
  return undefined;
}

/** Whether a `const_builtin` / `final_builtin` leads this declaration. */
function hasReadonlyModifier(node: SyntaxNode): boolean {
  for (const sib of scanLeadingSiblings(node)) {
    if (sib.type === 'const_builtin' || sib.type === 'final_builtin') return true;
  }
  return false;
}

export const dartVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Dart,
  constNodeTypes: [],
  staticNodeTypes: [],
  // The two real top-level container shapes captured as @definition.variable.
  variableNodeTypes: ['initialized_identifier_list', 'static_final_declaration_list'],

  extractName: (node) => extractDartVarNames(node)[0],
  extractNames: extractDartVarNames,
  extractType: extractDartVarType,

  extractVisibilityForName(_node, name): VariableVisibility {
    // Dart convention: underscore prefix = library-private.
    return name.startsWith('_') ? 'private' : 'public';
  },

  extractVisibility(node): VariableVisibility {
    const first = extractDartVarNames(node)[0];
    if (!first) return 'public';
    return first.startsWith('_') ? 'private' : 'public';
  },

  isConst: hasReadonlyModifier,

  isStatic(_node) {
    // Top-level Dart variables are not static.
    return false;
  },

  isMutable(node) {
    return !hasReadonlyModifier(node);
  },
};
