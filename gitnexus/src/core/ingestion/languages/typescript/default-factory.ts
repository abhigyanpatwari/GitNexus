import { FUNCTION_NODE_TYPES, type SyntaxNode } from '../../utils/ast-helpers.js';
import { canonicalTypeScriptName } from './identifiers.js';

const referenceWrappers = new Set([
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'type_assertion',
  'non_null_expression',
  'instantiation_expression',
]);

const nonStringEvalArguments = new Set([
  'number',
  'true',
  'false',
  'null',
  'regex',
  'array',
  'object',
  'arrow_function',
  'function_expression',
  'generator_function',
  'class',
  'new_expression',
]);

function outerReference(node: SyntaxNode): SyntaxNode {
  while (node.parent && referenceWrappers.has(node.parent.type)) node = node.parent;
  return node;
}

/** Calling a factory creates its closure. A discarded result cannot execute the writer. */
function returnedCallableUses(
  ref: SyntaxNode,
  references: ReadonlyMap<string, SyntaxNode[]>,
): readonly SyntaxNode[] {
  const callee = outerReference(ref);
  const call = callee.parent;
  if (call?.type !== 'call_expression' || call.childForFieldName('function')?.id !== callee.id)
    return [ref];
  const result = outerReference(call);
  const consumer = result.parent;
  if (
    consumer?.type === 'expression_statement' ||
    (consumer?.type === 'unary_expression' &&
      consumer.childForFieldName('operator')?.type === 'void')
  )
    return [];
  if (
    consumer?.type !== 'variable_declarator' ||
    consumer.childForFieldName('value')?.id !== result.id ||
    consumer.parent?.parent?.type === 'export_statement'
  )
    return [ref];
  const local = consumer.childForFieldName('name');
  if (local?.type !== 'identifier') return [ref];
  return (references.get(canonicalTypeScriptName(local.text)) ?? []).filter(
    (use) => use.id !== local.id,
  );
}

/** ECMA-262 13.3.6.1 requires an ordinary call to the identifier reference eval. */
function mayCallDirectEval(ref: SyntaxNode): boolean {
  if (ref.type !== 'identifier') return false;
  const callee = outerReference(ref);
  const call = callee.parent;
  if (
    call?.type !== 'call_expression' ||
    call.childForFieldName('function')?.id !== callee.id ||
    call.children.some((child) => child.type === '?.')
  )
    return false;
  const args = call.childForFieldName('arguments');
  if (args?.type !== 'arguments') return false;
  let source = args.namedChildren.find((child) => child.type !== 'comment');
  while (source && referenceWrappers.has(source.type)) {
    source = source.namedChildren.find(
      (child) => child.type !== 'comment' && child.type !== 'type_arguments',
    );
  }
  return source !== undefined && !nonStringEvalArguments.has(source.type);
}

/** A named function body or instance initializer can execute when its binding escapes. */
function deferredBinding(node: SyntaxNode, returned: SyntaxNode): SyntaxNode | undefined {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (FUNCTION_NODE_TYPES.has(parent.type) || parent.type === 'generator_function') {
      if (parent.childForFieldName('body')?.id !== child.id && child.type !== 'formal_parameters')
        continue;
      if (
        parent.id === returned.id ||
        parent.type === 'function_declaration' ||
        parent.type === 'generator_function_declaration'
      )
        return parent;
      if (
        parent.parent?.type === 'variable_declarator' &&
        parent.parent.childForFieldName('value')?.id === parent.id
      )
        return parent.parent;
    }
    if (
      parent.type === 'method_definition' ||
      (parent.type === 'public_field_definition' &&
        parent.childForFieldName('value')?.id === child.id &&
        !parent.children.some((token) => token.type === 'static'))
    ) {
      const owner = parent.parent?.parent;
      if (owner?.type === 'class_declaration' || owner?.type === 'abstract_class_declaration')
        return owner;
    }
  }
}

/** A direct return supplies the identity of the value exported by a local factory call. */
export function defaultFactoryResult(root: SyntaxNode) {
  const statements = root.namedChildren;
  const exportIndex = statements.findIndex(
    (node) =>
      node.type === 'export_statement' && node.children.some((token) => token.type === 'default'),
  );
  const expression = statements[exportIndex]?.childForFieldName('value');
  if (expression?.type !== 'call_expression') return undefined;
  const callee = expression.childForFieldName('function');
  if (callee?.type !== 'identifier') return undefined;
  const name = canonicalTypeScriptName(callee.text);
  const declarations = statements
    .map((node) =>
      node.type === 'export_statement' ? node.childForFieldName('declaration') : node,
    )
    .filter(
      (node) =>
        node?.type === 'function_declaration' &&
        canonicalTypeScriptName(node.childForFieldName('name')?.text ?? '') === name,
    );
  const factory = declarations[0];
  if (
    declarations.length !== 1 ||
    !factory ||
    factory.children.some((token) => token.type === 'async')
  )
    return undefined;
  const body = factory
    .childForFieldName('body')
    ?.namedChildren.filter((node) => node.type !== 'comment');
  const returned =
    body?.length === 1 && body[0].type === 'return_statement' ? body[0].lastNamedChild : undefined;
  if (returned?.type !== 'arrow_function' && returned?.type !== 'function_expression')
    return undefined;
  const callOffset = expression.startIndex;
  const hasDependency = statements.some(
    (node) =>
      node.type === 'import_statement' ||
      (node.type === 'export_statement' && node.childForFieldName('source') !== null),
  );
  // Index names only if a write to this factory occurs inside a deferred body.
  let references: Map<string, SyntaxNode[]> | undefined;
  let directEvalRefs: SyntaxNode[] = [];
  const unreachable = new Set<number>();
  function isPriorWrite(write: SyntaxNode): boolean {
    const pending = [write];
    const seen = new Set<number>();
    let searchedEval = false;
    for (let node = pending.pop(); node; node = pending.pop()) {
      const owner = deferredBinding(node, returned);
      if (!owner) {
        if (node.startIndex < callOffset) return true;
        continue;
      }
      if (seen.has(owner.id) || unreachable.has(owner.id)) continue;
      seen.add(owner.id);
      const source = owner.id === returned.id ? factory : owner;
      const declaration = source.type === 'variable_declarator' ? source.parent : source;
      const exported =
        declaration?.parent?.type === 'export_statement' ? declaration.parent : undefined;
      if ((exported ?? declaration)?.parent?.id !== root.id) {
        // A namespace or object can expose its nested bindings under a property key.
        pending.push(owner);
        continue;
      }
      const binding = source.childForFieldName('name');
      if (!binding || (hasDependency && exported)) return true;
      if (!references) {
        references = new Map();
        for (const ref of root.descendantsOfType([
          'identifier',
          'type_identifier',
          'shorthand_property_identifier',
        ])) {
          const key = canonicalTypeScriptName(ref.text);
          const uses = references.get(key);
          if (uses) uses.push(ref);
          else references.set(key, [ref]);
        }
        directEvalRefs = (references.get('eval') ?? []).filter(mayCallDirectEval);
      }
      // A reachable direct eval can invoke a writer by a name assembled at runtime.
      if (!searchedEval && directEvalRefs.length) {
        searchedEval = true;
        for (const ref of directEvalRefs) pending.push(ref);
      }
      for (const ref of references.get(canonicalTypeScriptName(binding.text)) ?? []) {
        if (ref.id === binding.id) continue;
        const uses = owner.id === returned.id ? returnedCallableUses(ref, references) : [ref];
        for (const use of uses) {
          if (hasDependency && use.parent?.type === 'export_specifier') return true;
          pending.push(use);
        }
      }
      if (owner.type === 'class_declaration' || owner.type === 'abstract_class_declaration') {
        // A static initializer can construct its own class through 'this'. A decorator
        // receives the class without needing to reference its declared name.
        for (const ref of owner.descendantsOfType(['this', 'decorator'])) pending.push(ref);
      }
    }
    if (searchedEval) directEvalRefs = [];
    for (const owner of seen) unreachable.add(owner);
    return false;
  }
  return {
    name,
    value: returned,
    isPriorWrite,
  };
}
