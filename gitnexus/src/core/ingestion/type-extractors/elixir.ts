import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, ConstructorBindingScanner, ReturnTypeExtractor } from './types.js';
import type { SyntaxNode } from '../utils.js';

/**
 * Elixir type extractor — @spec annotation parsing.
 *
 * Elixir has no static type system in the traditional sense, but @spec
 * annotations provide type information:
 *
 *   @spec create(map()) :: {:ok, t()} | {:error, term()}
 *   def create(attrs) do
 *     ...
 *   end
 *
 * This extractor parses @spec from preceding unary_operator nodes
 * (module attributes) to extract parameter and return types.
 *
 * For struct construction patterns like `user = %User{name: "Alice"}`,
 * we extract the struct module as the type.
 */

/** Regex to extract Elixir type names from @spec */
const SPEC_RETURN_RE = /::\s*(.+)$/;

/** Elixir built-in type names — excluded from type resolution */
const ELIXIR_BUILTINS = new Set(['integer', 'float', 'binary', 'boolean', 'atom', 'string', 'map', 'list', 'tuple', 'pid', 'reference', 'term', 'any', 'number', 'keyword', 'charlist', 'iodata', 'iolist', 'bitstring', 'byte', 'char', 'fun', 'module', 'node', 'timeout', 'no_return', 'non_neg_integer', 'pos_integer', 'neg_integer', 'mfa', 'port', 'identifier', 'as_boolean', 'struct', 't']);

/**
 * Extract simple type name from an Elixir typespec string.
 * Handles: "String.t()" → "String", "integer()" → "integer",
 * "{:ok, t()}" → undefined (complex), "User.t()" → "User"
 */
const extractElixirTypeName = (typeStr: string): string | undefined => {
  const trimmed = typeStr.trim();

  // Tuple/union types are too complex
  if (trimmed.startsWith('{') || trimmed.includes(' | ')) return undefined;

  // Module.t() pattern → Module
  const dotMatch = trimmed.match(/^(\w+(?:\.\w+)*)\.t\(\)$/);
  if (dotMatch) {
    const parts = dotMatch[1].split('.');
    return parts[parts.length - 1];
  }

  // Simple type() pattern → type (but filter out primitive types)
  const simpleMatch = trimmed.match(/^(\w+)\(\)$/);
  if (simpleMatch) {
    const name = simpleMatch[1];
    if (ELIXIR_BUILTINS.has(name)) return undefined;
    return name;
  }

  // Bare module name (starts with uppercase)
  if (/^[A-Z]\w*$/.test(trimmed)) return trimmed;

  return undefined;
};

/**
 * Elixir node types that may carry type bindings.
 * In tree-sitter-elixir, function definitions are `call` nodes
 * with target `def`/`defp`. We scan for preceding @spec attributes.
 */
const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'call',
]);

/**
 * Extract @spec annotations from the preceding sibling nodes of a def/defp call.
 * In tree-sitter-elixir, @spec is a unary_operator with @ operator whose
 * operand is a call with target "spec".
 */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, _env: Map<string, string>): void => {
  // Only handle def/defp nodes
  if (node.type !== 'call') return;
  const target = node.childForFieldName?.('target');
  if (!target || target.type !== 'identifier') return;
  if (target.text !== 'def' && target.text !== 'defp') return;

  // @spec types are pre-populated by looking at preceding siblings
  // but Elixir parameters have no inline types — types come from @spec
  // This is a no-op for now; the spec parsing happens in extractReturnType
};

/**
 * Elixir parameters have no inline type annotations.
 * Types come from @spec, which is handled separately.
 */
const extractParameter: ParameterExtractor = (_node: SyntaxNode, _env: Map<string, string>): void => {
  // Elixir parameters have no type annotations.
};

/**
 * Scan for struct construction: user = %User{name: "Alice"}
 * In tree-sitter-elixir, this is a map node with a struct child.
 */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  // Match assignment: identifier = %StructName{...}
  if (node.type !== 'binary_operator') return undefined;
  const children = node.children ?? [];
  // Binary operator: left = right, operator is '='
  if (children.length < 3) return undefined;
  const operator = children.find((c: any) => c.type === '=' || c.text === '=');
  if (!operator) return undefined;

  const left = node.childForFieldName?.('left');
  const right = node.childForFieldName?.('right');
  if (!left || !right) return undefined;
  if (left.type !== 'identifier') return undefined;
  if (right.type !== 'map') return undefined;

  // Look for struct child inside the map
  const structNode = right.children?.find((c: any) => c.type === 'struct');
  if (!structNode) return undefined;

  // The struct name is an alias or identifier child
  const nameNode = structNode.children?.find((c: any) => c.type === 'alias' || c.type === 'identifier');
  if (!nameNode) return undefined;

  // Extract last segment of qualified name: MyApp.User → User
  const fullName = nameNode.text;
  const parts = fullName.split('.');
  const calleeName = parts[parts.length - 1];

  return { varName: left.text, calleeName };
};

/**
 * Extract return type from @spec annotation preceding a def/defp.
 * Walks backward through siblings looking for unary_operator (@spec).
 */
const extractReturnType: ReturnTypeExtractor = (node) => {
  if (node.type !== 'call') return undefined;
  const target = node.childForFieldName?.('target');
  if (!target || target.type !== 'identifier') return undefined;
  if (target.text !== 'def' && target.text !== 'defp') return undefined;

  // Walk backward through siblings looking for @spec
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === 'unary_operator') {
      const operand = sibling.childForFieldName?.('operand');
      if (operand?.type === 'call') {
        const specTarget = operand.childForFieldName?.('target');
        if (specTarget?.type === 'identifier' && specTarget.text === 'spec') {
          // Found @spec — extract return type after ::
          const specText = operand.text;
          const match = SPEC_RETURN_RE.exec(specText);
          if (match) {
            return extractElixirTypeName(match[1]);
          }
        }
      }
    } else if (sibling.isNamed && sibling.type !== 'comment') {
      // call nodes may be @impl/@doc/@deprecated attributes (target is a unary_operator @)
      // or real def/defp/other calls (target is a plain identifier). Only break on real calls.
      if (sibling.type === 'call') {
        const t = sibling.childForFieldName?.('target');
        if (t?.type === 'identifier') break; // real def/defp/other call — stop
        // Otherwise target is a unary_operator (e.g. @impl true) — keep walking
      } else if (sibling.type === 'unary_operator') {
        // Another @attribute node (e.g. @doc, @moduledoc) — keep walking
      } else {
        break;
      }
    }
    sibling = sibling.previousSibling;
  }

  return undefined;
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  scanConstructorBinding,
  extractReturnType,
};
