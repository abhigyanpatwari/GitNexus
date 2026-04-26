// gitnexus/src/core/ingestion/type-extractors/zig.ts
//
// Zig type-environment extraction.
//
// Zig is a typed language, but type inference is performed by the
// compiler at compile time and is not always reflected in the surface
// syntax. For call-graph purposes we extract only the high-confidence
// patterns — explicit type annotations and parameter types. Anything
// that requires type inference (e.g., `const x = makeFoo()`) is left
// as an unresolved binding for now.

import type {
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
} from './types.js';
import { extractSimpleTypeName } from './shared.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set(['variable_declaration']);

/** Zig: const x: Foo = ... | var x: Foo = ... */
const extractDeclaration: TypeBindingExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
): void => {
  if (node.type !== 'variable_declaration') return;
  // Find the bound identifier (first named identifier child).
  let nameText: string | undefined;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c?.type === 'identifier') {
      nameText = c.text;
      break;
    }
  }
  if (!nameText) return;
  const typeNode = node.childForFieldName?.('type');
  if (!typeNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  if (typeName) env.set(nameText, typeName);
};

/** Zig: parameter → name + type */
const extractParameter: ParameterExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
): void => {
  if (node.type !== 'parameter') return;
  const nameNode = node.childForFieldName?.('name');
  const typeNode = node.childForFieldName?.('type');
  if (!nameNode || !typeNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  if (typeName) env.set(nameNode.text, typeName);
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
};
