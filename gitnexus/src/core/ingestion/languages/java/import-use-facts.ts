import type { SyntaxNode } from '../../utils/ast-helpers.js';

/** Durable AST facts, collected while the parse worker still owns the tree. */
export interface JavaImportUses {
  readonly version: 2;
  /** False when the tree cannot show every name the file binds (see below). */
  readonly complete: boolean;
  /** Distinct simple names that reach the compilation unit's own scope: used
   * as a type, or as the qualifier of an expression, and bound by nothing the
   * file itself declares. Only these can be supplied by an on-demand import. */
  readonly names: readonly string[];
}

const identifierTypes = ['identifier', 'type_identifier'];
// JLS 3.8 `Character.isIdentifierIgnorable`.
const ignorable = /[\p{Cf}\u0000-\u0008\u000e-\u001b\u007f-\u009f]/u;
const typeDeclarations = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);
const typeBodies = new Set(['class_body', 'interface_body', 'enum_body', 'annotation_type_body']);
/** Parents whose type-declaration children are members (or top-level types),
 * already registered when the parent's frame was opened. Any other parent
 * makes the declaration a local type. */
const memberParents = new Set([...typeBodies, 'program', 'enum_body_declarations']);
const callables = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  'lambda_expression',
]);
const blocks = new Set(['block', 'constructor_body', 'switch_block', 'for_statement']);
const annotations = new Set(['marker_annotation', 'annotation']);
const comments = new Set(['line_comment', 'block_comment']);

/** One lexical scope (JLS 6.3). Each map gives the first source index at which
 * a name declared here is in scope; a use binds when it starts at or after it. */
interface Frame {
  readonly depth: number;
  readonly types: Map<string, number>;
  readonly values: Map<string, number>;
}

function declare(names: Map<string, number>, name: string | undefined, from: number): void {
  if (name !== undefined) names.set(name, Math.min(names.get(name) ?? Infinity, from));
}

function nameOf(node: SyntaxNode | null | undefined): string | undefined {
  return node?.childForFieldName('name')?.text;
}

function typeParameters(node: SyntaxNode, into: Map<string, number>): void {
  const parameters = node.childForFieldName('type_parameters');
  if (parameters === null) return;
  // JLS 6.3: a type parameter is in scope from its own section to the end of
  // the declaration, which excludes modifiers and annotations before it.
  for (const parameter of parameters.namedChildren) {
    const name = parameter.namedChildren.find((child) => child.type === 'type_identifier');
    declare(into, name?.text, parameters.startIndex);
  }
}

function parameters(node: SyntaxNode, into: Map<string, number>): void {
  const body = node.childForFieldName('body');
  const list = node.childForFieldName('parameters');
  if (body === null || list === null) return;
  // JLS 6.3: a parameter is in scope in the body only, not in the header.
  const from = body.startIndex;
  if (list.type === 'identifier') return declare(into, list.text, from);
  for (const parameter of list.namedChildren) {
    if (parameter.type === 'identifier') declare(into, parameter.text, from);
    else if (parameter.type === 'formal_parameter') declare(into, nameOf(parameter), from);
    else if (parameter.type === 'spread_parameter')
      declare(
        into,
        nameOf(parameter.namedChildren.find((child) => child.type === 'variable_declarator')),
        from,
      );
  }
}

/** Members are in scope in the whole body, whatever their order (JLS 6.3).
 * Inherited members are not visible in this file's tree; leaving them out can
 * only keep a dependency that a compiler would not need. */
function members(body: SyntaxNode, frame: Frame): void {
  for (const member of body.namedChildren) {
    if (typeDeclarations.has(member.type)) declare(frame.types, nameOf(member), 0);
    else if (member.type === 'enum_constant') declare(frame.values, nameOf(member), 0);
    else if (member.type === 'enum_body_declarations') members(member, frame);
    else if (member.type === 'field_declaration' || member.type === 'constant_declaration')
      for (const declarator of member.namedChildren)
        if (declarator.type === 'variable_declarator') declare(frame.values, nameOf(declarator), 0);
  }
}

/** JLS 6.3–6.5: collect the simple names this file uses that no declaration
 * in the file binds. One top-down traversal carries the lexical scopes, so the
 * cost is linear in the tree and independent of expression depth. */
export function captureJavaImportUses(root: SyntaxNode): JavaImportUses {
  // JLS 3.3 translates escapes before comments are recognized. A valid raw
  // tree can therefore hide real code (e.g. `// \u000a User value;`). This
  // guard deliberately accepts false positives, including escaped backslashes.
  if (root.hasError || root.text.includes('\\u')) return { version: 2, complete: false, names: [] };
  const hasWildcard = root.namedChildren.some(
    (node) =>
      node.type === 'import_declaration' &&
      node.namedChildren.some((child) => child.type === 'asterisk'),
  );
  if (!hasWildcard) {
    // This file can still be a wildcard TARGET: its declared names must be
    // trustworthy. tree-sitter's raw identifier keys do not implement JLS 3.8
    // ignorable-character equality, so such a file certifies nothing.
    const complete = !root
      .descendantsOfType(identifierTypes)
      .some((node) => ignorable.test(node.text));
    return { version: 2, complete, names: [] };
  }

  const names = new Set<string>();
  const frames: Frame[] = [];
  // Indexed by tree depth: the node type on the current path, how many named
  // children that node has shown so far, and whether it is a `Type::new`.
  const types: string[] = [];
  const named: number[] = [];
  const constructorReference: boolean[] = [];
  let complete = true;
  let skipBelow = -1;

  const open = (depth: number): Frame => {
    const frame: Frame = { depth, types: new Map(), values: new Map() };
    frames.push(frame);
    return frame;
  };
  const bound = (name: string, index: number, value: boolean): boolean => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      if ((frame.types.get(name) ?? Infinity) <= index) return true;
      // JLS 6.4.2: where a name could be a variable or a type, it is the variable.
      if (value && (frame.values.get(name) ?? Infinity) <= index) return true;
    }
    return false;
  };

  const cursor = root.walk();
  const enter = (depth: number): void => {
    if (!cursor.nodeIsNamed) return;
    const type = cursor.nodeType;
    if (comments.has(type)) return;
    while (frames.length > 0 && frames[frames.length - 1].depth >= depth) frames.pop();
    if (skipBelow >= depth) skipBelow = -1;
    const first = (named[depth] ?? 0) === 0;
    named[depth] = (named[depth] ?? 0) + 1;
    named[depth + 1] = 0;
    types[depth] = type;
    const parent = types[depth - 1];

    if (type === 'identifier' || type === 'type_identifier') {
      const text = cursor.nodeText;
      if (ignorable.test(text)) complete = false;
      if (skipBelow !== -1) return;
      const field = cursor.currentFieldName;
      let use: 'type' | 'value' | undefined;
      if (type === 'type_identifier') {
        // A type parameter's own name, or the tail of a qualified type.
        if (parent !== 'type_parameter' && (parent !== 'scoped_type_identifier' || first))
          use = 'type';
      } else if (field === 'name') {
        // Every other `name` field declares something, names a method, or is
        // the tail of a qualified name.
        if (annotations.has(parent)) use = 'type';
      } else if (parent === 'scoped_identifier' || parent === 'record_pattern') {
        use = 'type';
      } else if (parent === 'method_reference') {
        // JLS 15.13: only a class or array type may precede `::new`.
        if (first) use = constructorReference[depth] ? 'type' : 'value';
      } else if (
        field !== 'field' &&
        field !== 'key' &&
        parent !== 'package_declaration' &&
        parent !== 'labeled_statement' &&
        parent !== 'break_statement' &&
        parent !== 'continue_statement' &&
        parent !== 'inferred_parameters' &&
        parent !== 'type_pattern' &&
        parent !== 'record_pattern_component' &&
        !(parent === 'lambda_expression' && field === 'parameters')
      ) {
        // An expression name. Only a qualifier can denote a type, but keeping
        // every unbound name errs toward retaining a dependency.
        use = 'value';
      }
      if (use !== undefined && !bound(text, cursor.startIndex, use === 'value')) names.add(text);
      return;
    }

    if (
      type === 'import_declaration' ||
      (type === 'scoped_identifier' && parent === 'package_declaration')
    ) {
      // Imports and the package name are not uses. Annotations on the package
      // declaration are (JLS 6.3), so only its name is skipped.
      skipBelow = depth;
    } else if (type === 'program') {
      members(cursor.currentNode, open(depth));
    } else if (typeDeclarations.has(type)) {
      const node = cursor.currentNode;
      // A local type is in scope from its own declaration to the end of the
      // block that directly encloses it.
      if (!memberParents.has(parent) && frames.length > 0)
        declare(frames[frames.length - 1].types, nameOf(node), cursor.startIndex);
      const frame = open(depth);
      typeParameters(node, frame.types);
      // Record components are fields of the record: in scope in its body.
      if (type === 'record_declaration') parameters(node, frame.values);
    } else if (typeBodies.has(type)) {
      members(cursor.currentNode, open(depth));
    } else if (callables.has(type)) {
      const node = cursor.currentNode;
      const frame = open(depth);
      typeParameters(node, frame.types);
      parameters(node, frame.values);
    } else if (blocks.has(type)) {
      open(depth);
    } else if (type === 'enhanced_for_statement' || type === 'catch_clause') {
      const node = cursor.currentNode;
      const body = node.childForFieldName('body');
      const variable =
        type === 'catch_clause'
          ? node.namedChildren.find((child) => child.type === 'catch_formal_parameter')
          : node;
      if (body !== null) declare(open(depth).values, nameOf(variable), body.startIndex);
    } else if (type === 'variable_declarator' && parent === 'local_variable_declaration') {
      // JLS 6.3: a local is in scope from its own declarator. The innermost
      // frame is the block, loop or body that directly holds the declaration,
      // so the name can never leak into an enclosing callable or type.
      const name = cursor.currentNode.childForFieldName('name');
      if (name !== null && frames.length > 0)
        declare(frames[frames.length - 1].values, name.text, name.startIndex);
    } else if (type === 'method_reference') {
      constructorReference[depth + 1] = cursor.currentNode.lastChild?.type === 'new';
    }
  };

  for (let depth = 0; ; ) {
    enter(depth);
    if (cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    let moved = cursor.gotoNextSibling();
    while (!moved && cursor.gotoParent()) {
      depth--;
      moved = cursor.gotoNextSibling();
    }
    if (!moved) break;
  }
  return { version: 2, complete, names: complete ? [...names] : [] };
}
