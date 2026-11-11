import type { Range } from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

export interface JavaImportUse {
  readonly name: string;
  readonly range: Range;
  readonly purpose: 'type' | 'value' | 'method';
}

/** Durable AST facts, collected while the parse worker still owns the tree. */
export interface JavaImportUses {
  readonly version: 1;
  readonly complete: boolean;
  readonly uses: readonly JavaImportUse[];
}

const identifiers = ['identifier', 'type_identifier'];
const qualified = new Set(['scoped_identifier', 'scoped_type_identifier', 'field_access']);
const ignored = /[\p{Cf}\u0000-\u0008\u000e-\u001b\u007f-\u009f]/u;
const callableScopes = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  'lambda_expression',
  'record_declaration',
]);
const valueScopes = new Set(['block', 'for_statement', 'enhanced_for_statement', 'switch_block']);
const typeBodies = new Set(['class_body', 'interface_body', 'enum_body', 'record_body']);

function enclosing(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode | undefined {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (types.has(current.type)) return current;
  }
  return undefined;
}

/** JLS 6.3: source scopes and declaration order for expression-name bindings.
 * The shared receiver hints can be hoisted; these AST scopes cannot escape a
 * block, loop, catch or lambda. Pattern-flow scopes are deliberately not
 * asserted here, so incomplete pattern evidence can only retain extra edges. */
function valueBinding(node: SyntaxNode): { scope: SyntaxNode; from: number } | undefined {
  const parent = node.parent;
  if (parent === null) return undefined;
  let scope: SyntaxNode | undefined;
  let from = 0;
  if (parent.type === 'variable_declarator' && parent.childForFieldName('name')?.id === node.id) {
    const field =
      parent.parent?.type === 'field_declaration' || parent.parent?.type === 'constant_declaration';
    scope = enclosing(parent, field ? typeBodies : valueScopes);
    if (!field) from = node.startIndex;
  } else if (
    (parent.type === 'formal_parameter' || parent.type === 'spread_parameter') &&
    parent.childForFieldName('name')?.id === node.id
  ) {
    scope = enclosing(parent, callableScopes)?.childForFieldName('body') ?? undefined;
  } else if (
    parent.type === 'catch_formal_parameter' &&
    parent.childForFieldName('name')?.id === node.id
  ) {
    scope = parent.parent?.childForFieldName('body') ?? undefined;
  } else if (
    parent.type === 'enhanced_for_statement' &&
    parent.childForFieldName('name')?.id === node.id
  ) {
    scope = parent.childForFieldName('body') ?? undefined;
  } else if (
    parent.type === 'inferred_parameters' ||
    (parent.type === 'lambda_expression' && parent.childForFieldName('parameters')?.id === node.id)
  ) {
    const lambda = parent.type === 'lambda_expression' ? parent : parent.parent;
    scope = lambda?.childForFieldName('body') ?? undefined;
  } else if (parent.type === 'enum_constant' && parent.childForFieldName('name')?.id === node.id) {
    scope = enclosing(parent, typeBodies);
  }
  return scope === undefined ? undefined : { scope, from };
}

/** JLS 6.5: record simple names (including the root of a qualified name),
 * never a declaration, import, comment, string, or qualified member's tail. */
export function captureJavaImportUses(root: SyntaxNode): JavaImportUses {
  const uses: JavaImportUse[] = [];
  // JLS 3.3 translates escapes before comments are recognized. A valid raw
  // tree can therefore hide real code (e.g. `// \u000a User value;`). This
  // guard deliberately accepts false positives, including escaped backslashes.
  let complete = !root.hasError && !root.text.includes('\\u');
  const hasWildcard = root.namedChildren.some(
    (node) =>
      node.type === 'import_declaration' &&
      node.namedChildren.some((child) => child.type === 'asterisk'),
  );
  const nodes = root.descendantsOfType(identifiers);
  const values = new Map<number, Map<string, number>>();
  const valueDeclarations = new Set<number>();
  if (hasWildcard)
    for (const node of nodes) {
      const binding = valueBinding(node);
      if (binding === undefined) continue;
      valueDeclarations.add(node.id);
      const names = values.get(binding.scope.id) ?? new Map<string, number>();
      names.set(node.text, Math.min(names.get(node.text) ?? Infinity, binding.from));
      values.set(binding.scope.id, names);
    }
  for (const node of nodes) {
    // tree-sitter does not perform JLS 3.3 Unicode translation. Likewise its
    // raw identifier keys do not implement JLS 3.8 ignorable-character equality.
    // Do not certify pruning when the shared scope model cannot represent it.
    if (ignored.test(node.text)) complete = false;
    if (!hasWildcard) continue;
    if (valueDeclarations.has(node.id)) continue;
    const parent = node.parent;
    if (parent === null) continue;
    if (
      (parent.childForFieldName('name')?.id === node.id &&
        /declaration|declarator|parameter/.test(parent.type)) ||
      parent.type === 'type_parameter' ||
      parent.type === 'inferred_parameters' ||
      parent.type === 'labeled_statement' ||
      parent.type === 'break_statement' ||
      parent.type === 'continue_statement' ||
      (parent.type === 'element_value_pair' && parent.firstNamedChild?.id === node.id) ||
      (parent.type === 'lambda_expression' &&
        parent.childForFieldName('parameters')?.id === node.id)
    )
      continue;
    if (qualified.has(parent.type) && parent.firstNamedChild?.id !== node.id) continue;
    if (parent.type === 'method_reference' && parent.firstNamedChild?.id !== node.id) continue;
    const method =
      parent.type === 'method_invocation' && parent.childForFieldName('name')?.id === node.id;
    if (method && parent.childForFieldName('object') !== null) continue;
    let nameNode = node;
    while (nameNode.parent !== null && qualified.has(nameNode.parent.type))
      nameNode = nameNode.parent;
    const typeUse =
      node.type === 'type_identifier' ||
      nameNode.parent?.type === 'marker_annotation' ||
      nameNode.parent?.type === 'annotation';
    let excluded = false;
    for (let ancestor: SyntaxNode | null = node; ancestor !== null; ancestor = ancestor.parent) {
      if (ancestor.type === 'import_declaration' || ancestor.type === 'package_declaration') {
        excluded = true;
        break;
      }
      if (
        !method &&
        !typeUse &&
        (values.get(ancestor.id)?.get(node.text) ?? Infinity) <= node.startIndex
      ) {
        excluded = true;
        break;
      }
      // A type parameter owns this name throughout its declaring type/method
      // (JLS 6.3, 6.4.1). The AST supplies the declaration and its scope.
      const parameters = ancestor.childForFieldName('type_parameters');
      if (
        !method &&
        parameters !== null &&
        node.startIndex >= parameters.startIndex &&
        parameters.namedChildren.some(
          (parameter) =>
            parameter.namedChildren.find((child) => child.type === 'type_identifier')?.text ===
            node.text,
        )
      ) {
        excluded = true;
        break;
      }
    }
    if (excluded) continue;
    uses.push({
      name: node.text,
      range: {
        startLine: node.startPosition.row + 1,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row + 1,
        endCol: node.endPosition.column,
      },
      purpose: method ? 'method' : typeUse ? 'type' : 'value',
    });
  }
  return { version: 1, complete, uses };
}
