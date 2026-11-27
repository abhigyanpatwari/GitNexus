/**
 * File-local name facts for narrowing persisted `import X` edges
 * (`on-demand-imports.ts`), recorded at capture time for every Swift file.
 *
 * `import X` makes every declaration of module X visible without naming one.
 * Whether an importer depends on a file of X is decided from syntactic facts
 * read from one file each: the importer's uses and the target's declarations,
 * plus one alias hop (`aliasOf`, `on-demand-imports.ts`). An incremental run
 * sees the same answer as a full one because the importer keeps an edge to
 * every file the answer read:
 *
 * - What a file DECLARES that another file can reach without naming its
 *   owner, by how it is reached:
 *     - `top`: top-level declarations of every kind (type, protocol, actor,
 *       typealias, macro, function, `let`/`var` including tuple patterns,
 *       precedence group), reached by spelling the name;
 *     - `ops`: operators the file declares (`operator` declarations, and
 *       operator functions whose token is not a standard Swift operator),
 *       reached by using the token;
 *     - `ext`: members declared in `extension` bodies, reached by writing the
 *       name anywhere: after a dot, or bare through an implicit `self` in a
 *       type, subclass or conforming type; and the argument labels of an
 *       extension subscript (`xs[safe: 3]`);
 *     - `statics`: static members and enum cases declared in type bodies,
 *       reached as implicit members (`.primary`, `case .large:`,
 *       `if case .large = size`, `case let .some(v):`, keyword-named
 *       `.true`, `.repeat(1)`);
 *     - `extTypes`: the extended type of an extension that declares an
 *       initializer, a subscript, `callAsFunction`, a standard-operator
 *       overload, a conformance, or nothing at all, reached by spelling the
 *       type (`[T]`, `[K: V]` and `T?` spell `Array`, `Dictionary` and
 *       `Optional`);
 *     - `aliasOf`: the type names on the right of a top-level `typealias`,
 *       so a kept alias keeps the files declaring what it stands for.
 *   Instance members of a type body are not listed: they are reached through
 *   the type, whose name is in `top`. `private` and `fileprivate`
 *   declarations are not listed: no other file can name them.
 *   When the file holds anything the extractor does not model, its
 *   declarations are unknown (`declares: null`, with the reason) and every
 *   importer of its module keeps it: a parse error at the top level, in a
 *   declaration header or in a declaration body the walk visits; an `ERROR`
 *   holding a declaration; an unterminated string or error running to the end
 *   of the file; a node it does not know there (a freestanding macro other
 *   than `#Preview` and `#_sourceLocation`, by name); an extension of a type
 *   it cannot name; or a failure while gathering. Its uses are still
 *   recorded.
 * - What a file USES: every distinct identifier outside `import`
 *   declarations (`ids`, words error recovery left as bare `ERROR` leaves
 *   included), the subset written as implicit members (`implicit`), and the
 *   operator tokens it uses (`ops`). Recorded only for files with at least
 *   one `import`.
 *
 * Names are compared without their backticks: `` `default` `` declares
 * `default`.
 *
 * Facts reach the main thread on `ParsedFile.captureSideChannel`, so they
 * survive the worker boundary and the parsed-file cache without a re-parse.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/** What a file declares, by how another file reaches it. Sorted, distinct;
 *  an empty category is omitted. */
export interface SwiftDeclaredNames {
  readonly top?: readonly string[];
  readonly ops?: readonly string[];
  readonly ext?: readonly string[];
  readonly statics?: readonly string[];
  readonly extTypes?: readonly string[];
  /** The nominal names on the right of the file's top-level `typealias`es. */
  readonly aliasOf?: readonly string[];
}

/** What a file uses. `implicit` indexes into `ids`. */
export interface SwiftUsedNames {
  readonly ids: readonly string[];
  readonly implicit?: readonly number[];
  readonly ops?: readonly string[];
}

/** Why a file's declarations are unknown. */
export type SwiftUnknownDeclarations =
  | 'parse-error'
  | 'error-hides-declaration'
  | 'unterminated-to-eof'
  | 'unknown-node'
  | 'unnamed-extended-type'
  | 'failure';

export interface SwiftCaptureSideChannel {
  readonly kind: 'swift';
  readonly nameFacts: {
    readonly version: 5;
    /** Null when the file holds a form the facts do not model (`unknown`). */
    readonly declares: SwiftDeclaredNames | null;
    readonly unknown?: SwiftUnknownDeclarations;
    /** Absent for a file with no `import`, or when gathering failed. */
    readonly uses?: SwiftUsedNames;
  };
}

/** The facts as sets, for matching. */
export interface SwiftNameFacts {
  /** Undefined when the file's declarations are not fully known. */
  readonly declares?: {
    readonly top: ReadonlySet<string>;
    readonly ops: ReadonlySet<string>;
    readonly ext: ReadonlySet<string>;
    readonly statics: ReadonlySet<string>;
    readonly extTypes: ReadonlySet<string>;
    readonly aliasOf: ReadonlySet<string>;
  };
  readonly uses?: {
    readonly ids: ReadonlySet<string>;
    readonly implicit: ReadonlySet<string>;
    readonly ops: ReadonlySet<string>;
  };
}

// The facts of the file captured last; read back immediately after its
// capture (`LanguageProvider.collectCaptureSideChannel`).
let latest: { readonly filePath: string; readonly facts: SwiftCaptureSideChannel } | null = null;

const sorted = (names: ReadonlySet<string>): string[] | undefined =>
  names.size === 0 ? undefined : [...names].sort();

/** A name as Swift compares it: `` `default` `` is `default`. */
export const identifierText = (text: string): string =>
  text.length > 2 && text.startsWith('`') && text.endsWith('`') ? text.slice(1, -1) : text;

/** Operators of the Swift standard library. A function named by one of them
 *  is an overload, used through values of its operand types; any other
 *  operator token names a custom operator. */
const STANDARD_OPERATORS: ReadonlySet<string> = new Set([
  ...['!', '~', '+', '-', '...', '..<', '?', '='],
  ...['<<', '>>', '&<<', '&>>', '*', '/', '%', '&*', '&', '&+', '&-', '|', '^'],
  ...['??', '<', '<=', '>', '>=', '==', '!=', '===', '!==', '~=', '&&', '||'],
  ...['*=', '/=', '%=', '+=', '-=', '<<=', '>>=', '&=', '|=', '^=', '&*=', '&+=', '&-='],
  ...['&<<=', '&>>=', '.==', '.!=', '.<', '.<=', '.>', '.>=', '.&', '.|', '.^'],
  ...['.&=', '.|=', '.^=', '.!', '.~'],
]);

/** An operator token: a `custom_operator` node, or an anonymous node the
 *  grammar emits for an operator it knows (`++`, `...`, `==`). */
const OPERATOR_TOKEN = /^[-+*/%=<>!&|^~?.]+$/;
const isOperatorToken = (node: SyntaxNode): boolean =>
  node.type === 'custom_operator' ||
  (!node.isNamed && node.type !== '.' && OPERATOR_TOKEN.test(node.type));

/** Sugar-spelled types, by the standard type they spell. */
const SUGAR_TYPES: Readonly<Record<string, string>> = {
  array_type: 'Array',
  array_literal: 'Array',
  dictionary_type: 'Dictionary',
  dictionary_literal: 'Dictionary',
  optional_type: 'Optional',
};

/** Thrown when a file holds a form the facts do not model. */
class UnmodelledForm extends Error {
  constructor(readonly reason: SwiftUnknownDeclarations) {
    super(reason);
  }
}

/** A parse error the parser left among a node's children: an `ERROR` node, or
 *  a token it inserted (`isMissing`). Either can hide declarations. */
function assertParsed(node: SyntaxNode): void {
  for (const child of node.children)
    if (child !== null && (child.isError || child.isMissing))
      throw new UnmodelledForm('parse-error');
}

/** A `static` or `class` member declaration. */
function isStaticMember(decl: SyntaxNode): boolean {
  for (const child of decl.children) {
    if (child === null) continue;
    if (child.type === 'static' || child.type === 'class') return true;
    if (child.type !== 'modifiers') continue;
    for (const modifier of child.namedChildren)
      if (modifier?.type === 'property_modifier' && /^(static|class)$/.test(modifier.text))
        return true;
  }
  return false;
}

/** A `private` or `fileprivate` declaration (not `private(set)`, whose getter
 *  stays visible): no other file can name it. */
function isFilePrivate(decl: SyntaxNode): boolean {
  for (const child of decl.namedChildren) {
    if (child?.type !== 'modifiers') continue;
    for (const modifier of child.namedChildren) {
      if (modifier?.type !== 'visibility_modifier') continue;
      const tokens = modifier.children.map((token) => token?.type);
      if (tokens.includes('set')) continue;
      if (tokens.includes('private') || tokens.includes('fileprivate')) return true;
    }
  }
  return false;
}

/** Names a `property_declaration` binds; a tuple binding nests `pattern` nodes. */
function boundNames(decl: SyntaxNode, into: Set<string>): void {
  for (const pattern of decl.childrenForFieldName('name')) {
    if (pattern.type !== 'pattern') continue;
    const stack: SyntaxNode[] = [pattern];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'simple_identifier') into.add(identifierText(node.text));
      else if (node.type === 'pattern')
        for (const child of node.namedChildren) if (child !== null) stack.push(child);
    }
  }
}

/** The name node of a function-like declaration: `simple_identifier`,
 *  `custom_operator`, or an anonymous operator token. */
function functionName(decl: SyntaxNode): SyntaxNode | null {
  return decl.childForFieldName('name');
}

/** An operator function's token, when it names a custom operator. */
function customOperatorOf(name: SyntaxNode | null): string | undefined {
  if (name === null || !isOperatorToken(name)) return undefined;
  const token = name.type === 'custom_operator' ? name.text : name.type;
  return STANDARD_OPERATORS.has(token) ? undefined : token;
}

interface DeclCollector {
  readonly top: Set<string>;
  readonly ops: Set<string>;
  readonly ext: Set<string>;
  readonly statics: Set<string>;
  readonly extTypes: Set<string>;
  readonly aliasOf: Set<string>;
}

/** Declaration kind of a `class_declaration`: class, struct, enum, actor or extension. */
const declarationKind = (decl: SyntaxNode): string | undefined =>
  decl.childForFieldName('declaration_kind')?.type;

/** Members that hold nothing another file reaches without the type's name,
 *  or that the walk handles; anything else in a body is unmodelled. No
 *  directive appears here: the conditional-directive preprocessing blanks a
 *  balanced `#if` group inside a body, and any other directive or diagnostic
 *  in a body parses as an error. */
const PLAIN_BODY_MEMBERS: ReadonlySet<string> = new Set([
  'comment',
  'multiline_comment',
  'init_declaration',
  'deinit_declaration',
  'subscript_declaration',
  'typealias_declaration',
  'associatedtype_declaration',
  'protocol_declaration',
  'protocol_function_declaration',
  'protocol_property_declaration',
  'enum_entry',
  'property_declaration',
  'function_declaration',
  'class_declaration',
]);

/** Statics, enum cases and custom operators of a type body, nested types
 *  included. Iterative: nesting depth is input-controlled. */
function collectTypeBody(body: SyntaxNode | null, facts: DeclCollector): void {
  const bodies: SyntaxNode[] = body === null ? [] : [body];
  while (bodies.length > 0) {
    const current = bodies.pop()!;
    assertParsed(current);
    for (const member of current.namedChildren) {
      if (member === null) continue;
      if (!PLAIN_BODY_MEMBERS.has(member.type)) throw new UnmodelledForm('unknown-node');
      if (isFilePrivate(member)) continue;
      switch (member.type) {
        case 'enum_entry':
          for (const name of member.childrenForFieldName('name'))
            if (name.type === 'simple_identifier') facts.statics.add(identifierText(name.text));
          break;
        case 'property_declaration':
          if (isStaticMember(member)) boundNames(member, facts.statics);
          break;
        case 'function_declaration': {
          const name = functionName(member);
          const op = customOperatorOf(name);
          if (op !== undefined) facts.ops.add(op);
          else if (name?.type === 'simple_identifier' && isStaticMember(member))
            facts.statics.add(identifierText(name.text));
          break;
        }
        case 'class_declaration': {
          // A parse error in a nested type's header can hide what follows.
          assertParsed(member);
          const nested = member.childForFieldName('body');
          if (declarationKind(member) !== 'extension' && nested !== null) bodies.push(nested);
          break;
        }
      }
    }
  }
}

/** The name an extension's extended type is spelled by: the trailing
 *  identifier of `A.B<C>`, or the standard type a sugar form spells. */
function extendedTypeName(extended: SyntaxNode | null): string | undefined {
  if (extended === null) return undefined;
  const sugar = SUGAR_TYPES[extended.type];
  if (sugar !== undefined) return sugar;
  if (extended.type !== 'user_type') return undefined;
  const name = extended.namedChildren.filter((child) => child?.type === 'type_identifier').pop();
  return name === undefined || name === null ? undefined : identifierText(name.text);
}

/** Members of an `extension T` body, and whether T itself must be provided. */
function collectExtension(decl: SyntaxNode, facts: DeclCollector): void {
  const typeName = extendedTypeName(decl.childForFieldName('name'));
  if (typeName === undefined) throw new UnmodelledForm('unnamed-extended-type');
  const body = decl.childForFieldName('body');
  if (body !== null) assertParsed(body);
  // Every member of a `private extension` is file-private.
  if (isFilePrivate(decl)) {
    for (const member of body?.namedChildren ?? [])
      if (member?.type === 'class_declaration')
        collectTypeBody(member.childForFieldName('body'), emptyCollector());
    return;
  }
  let reachedThroughType = decl.namedChildren.some(
    (child) => child?.type === 'inheritance_specifier',
  );
  let members = 0;
  for (const member of body?.namedChildren ?? []) {
    if (member === null) continue;
    if (!PLAIN_BODY_MEMBERS.has(member.type)) throw new UnmodelledForm('unknown-node');
    switch (member.type) {
      case 'function_declaration': {
        members++;
        if (isFilePrivate(member)) break;
        const name = functionName(member);
        const op = customOperatorOf(name);
        if (name?.type === 'simple_identifier') {
          facts.ext.add(identifierText(name.text));
          // `t()` calls it through a value of T without writing its name.
          if (identifierText(name.text) === 'callAsFunction') reachedThroughType = true;
        } else if (op !== undefined) facts.ops.add(op);
        // A standard-operator overload is used through values of T.
        else reachedThroughType = true;
        break;
      }
      case 'property_declaration':
        members++;
        if (!isFilePrivate(member)) boundNames(member, facts.ext);
        break;
      case 'class_declaration':
      case 'protocol_declaration':
      case 'typealias_declaration': {
        members++;
        if (isFilePrivate(member)) break;
        assertParsed(member);
        const name = member.childForFieldName('name');
        if (name?.type === 'type_identifier') facts.ext.add(identifierText(name.text));
        if (member.type === 'class_declaration')
          collectTypeBody(member.childForFieldName('body'), facts);
        break;
      }
      case 'subscript_declaration':
        members++;
        if (isFilePrivate(member)) break;
        // `xs[safe: 3]` reaches it through a value whose type it may never
        // write; the label is written.
        for (const parameter of member.namedChildren) {
          const label =
            parameter?.type === 'parameter' ? parameter.childForFieldName('external_name') : null;
          if (label?.type === 'simple_identifier' && label.text !== '_')
            facts.ext.add(identifierText(label.text));
        }
        reachedThroughType = true;
        break;
      case 'init_declaration':
        members++;
        if (!isFilePrivate(member)) reachedThroughType = true;
        break;
    }
  }
  if (reachedThroughType || members === 0) facts.extTypes.add(typeName);
}

/** Top-level declarations the walk reads. */
export const SWIFT_TOP_LEVEL_DECLARATIONS: ReadonlySet<string> = new Set([
  'class_declaration',
  'protocol_declaration',
  'typealias_declaration',
  'macro_declaration',
  'precedence_group_declaration',
  'operator_declaration',
  'function_declaration',
  'property_declaration',
]);

/** Top-level nodes that declare nothing another file can name: imports,
 *  comments and directives, and the statements and expressions of a
 *  `main.swift` (from the grammar's `source_file` children). */
export const SWIFT_TOP_LEVEL_PLAIN: ReadonlySet<string> = new Set([
  ...['import_declaration', 'comment', 'multiline_comment', 'directive', 'diagnostic'],
  ...['shebang_line', 'additive_expression', 'array_literal', 'as_expression', 'assignment'],
  ...['await_expression', 'bang', 'bin_literal', 'bitwise_operation', 'boolean_literal'],
  ...['call_expression', 'check_expression', 'comparison_expression', 'conjunction_expression'],
  ...['constructor_expression', 'custom_operator', 'dictionary_literal', 'disjunction_expression'],
  ...['do_statement', 'equality_expression', 'for_statement', 'fully_open_range'],
  ...['guard_statement', 'hex_literal', 'if_statement', 'infix_expression', 'integer_literal'],
  ...['key_path_expression', 'key_path_string_expression', 'lambda_literal'],
  ...['line_string_literal', 'multi_line_string_literal', 'multiplicative_expression'],
  ...['navigation_expression', 'nil_coalescing_expression', 'oct_literal'],
  ...['open_end_range_expression', 'open_start_range_expression', 'playground_literal'],
  ...['postfix_expression', 'prefix_expression', 'range_expression', 'raw_string_literal'],
  ...['real_literal', 'regex_literal', 'repeat_while_statement', 'selector_expression'],
  ...['self_expression', 'simple_identifier', 'special_literal', 'statement_label'],
  ...['super_expression', 'switch_statement', 'ternary_expression', 'throw_keyword'],
  ...['try_expression', 'tuple_expression', 'value_pack_expansion', 'value_parameter_pack'],
  'while_statement',
]);

/** Top-level freestanding macros that, by name, declare nothing another file
 *  can name: `#Preview` registers a preview under a compiler-private name, and
 *  `#_sourceLocation` is a compiler directive. (`#warning` and `#error` parse
 *  as `diagnostic`, already plain.) A module's own macro of the same name is
 *  not told apart. */
export const SWIFT_PLAIN_MACROS: ReadonlySet<string> = new Set(['Preview', '_sourceLocation']);

/** Top-level nodes the grammar allows whose declarations the walk cannot
 *  read: a freestanding macro other than `SWIFT_PLAIN_MACROS` may declare
 *  anything, and an initializer or associated type at the top level only
 *  appears after a misparse. Any node in none of the three sets is treated the
 *  same way. */
export const SWIFT_TOP_LEVEL_UNKNOWN: ReadonlySet<string> = new Set([
  'macro_invocation',
  'init_declaration',
  'associatedtype_declaration',
]);

const emptyCollector = (): DeclCollector => ({
  top: new Set(),
  ops: new Set(),
  ext: new Set(),
  statics: new Set(),
  extTypes: new Set(),
  aliasOf: new Set(),
});

/** A node that declares something; under an `ERROR` it may be hidden. */
const DECLARATION_NODE = /_declaration$|^enum_entry$/;
const STRING_LITERALS: ReadonlySet<string> = new Set([
  'line_string_literal',
  'multi_line_string_literal',
  'raw_string_literal',
]);

/** A parse error deeper than the positions the walk checks can still hide
 *  declarations: an `ERROR` holding a declaration, or an unterminated string
 *  or `ERROR` that runs to the end of the file and swallows what follows.
 *  Only for a tree that has an error at all. One pass, iterative. */
function assertNothingHidden(root: SyntaxNode): void {
  if (!root.hasError) return;
  const lastEnd = root.lastChild?.endIndex ?? root.endIndex;
  const cursor = root.walk();
  // How many `ERROR` nodes enclose the current one.
  const inError: boolean[] = [];
  let errors = 0;
  for (;;) {
    const node = cursor.currentNode;
    const isError = node.isError;
    if (errors > 0 && DECLARATION_NODE.test(node.type))
      throw new UnmodelledForm('error-hides-declaration');
    // A string is unterminated when the parser had to insert its closing
    // delimiter (an error inside the literal); a complete literal that just
    // happens to be the last token hides nothing.
    const unterminated = isError || (STRING_LITERALS.has(node.type) && node.hasError);
    if (unterminated && node.endIndex >= lastEnd) throw new UnmodelledForm('unterminated-to-eof');
    if (cursor.gotoFirstChild()) {
      inError.push(isError);
      if (isError) errors++;
      continue;
    }
    let moved = cursor.gotoNextSibling();
    while (!moved && cursor.gotoParent()) {
      if (inError.pop()) errors--;
      moved = cursor.gotoNextSibling();
    }
    if (!moved) break;
  }
}

/** The nominal names a `typealias` stands for: every type name on its right. */
function aliasedNames(decl: SyntaxNode, into: Set<string>): void {
  const stack = decl.childrenForFieldName('name').slice(1);
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'type_identifier') into.add(identifierText(node.text));
    else for (const child of node.namedChildren) if (child !== null) stack.push(child);
  }
}

/** What `root` declares, by how another file reaches it; null with the
 *  reason when the file holds a form the facts do not model. */
function collectDeclarations(root: SyntaxNode): {
  readonly declares: SwiftDeclaredNames | null;
  readonly unknown?: SwiftUnknownDeclarations;
} {
  const facts = emptyCollector();
  try {
    if (root.isError) throw new UnmodelledForm('parse-error');
    assertParsed(root);
    for (const decl of root.namedChildren) {
      if (decl === null || SWIFT_TOP_LEVEL_PLAIN.has(decl.type)) continue;
      if (decl.type === 'macro_invocation') {
        const macro = decl.namedChildren.find((child) => child?.type === 'simple_identifier');
        if (macro && SWIFT_PLAIN_MACROS.has(macro.text)) continue;
      }
      if (!SWIFT_TOP_LEVEL_DECLARATIONS.has(decl.type)) throw new UnmodelledForm('unknown-node');
      // A parse error in a declaration's header hides it and what follows.
      assertParsed(decl);
      if (decl.type === 'operator_declaration') {
        // An operator is visible to every file that imports its module.
        for (const token of decl.children)
          if (token !== null && isOperatorToken(token))
            facts.ops.add(token.type === 'custom_operator' ? token.text : token.type);
        continue;
      }
      if (decl.type === 'class_declaration' && declarationKind(decl) === 'extension') {
        collectExtension(decl, facts);
        continue;
      }
      if (isFilePrivate(decl)) {
        // Nothing in it is reachable, but a parse error in its body can hide
        // the declarations after it.
        if (decl.type === 'class_declaration')
          collectTypeBody(decl.childForFieldName('body'), emptyCollector());
        const body = decl.childForFieldName('body');
        if (decl.type === 'protocol_declaration' && body !== null) assertParsed(body);
        continue;
      }
      switch (decl.type) {
        case 'class_declaration': {
          const name = decl.childForFieldName('name');
          if (name?.type === 'type_identifier') facts.top.add(identifierText(name.text));
          collectTypeBody(decl.childForFieldName('body'), facts);
          break;
        }
        case 'protocol_declaration':
        case 'typealias_declaration': {
          const name = decl.childForFieldName('name');
          if (name?.type === 'type_identifier') facts.top.add(identifierText(name.text));
          if (decl.type === 'typealias_declaration') aliasedNames(decl, facts.aliasOf);
          const body = decl.childForFieldName('body');
          if (body !== null) assertParsed(body);
          break;
        }
        case 'macro_declaration':
        case 'precedence_group_declaration': {
          const name = decl.namedChildren.find((child) => child?.type === 'simple_identifier');
          if (name) facts.top.add(identifierText(name.text));
          break;
        }
        case 'function_declaration': {
          const name = functionName(decl);
          const op = customOperatorOf(name);
          if (name?.type === 'simple_identifier') facts.top.add(identifierText(name.text));
          else if (op !== undefined) facts.ops.add(op);
          break;
        }
        case 'property_declaration':
          boundNames(decl, facts.top);
          break;
      }
    }
    assertNothingHidden(root);
  } catch (error) {
    if (error instanceof UnmodelledForm) return { declares: null, unknown: error.reason };
    throw error;
  }
  return {
    declares: {
      ...(facts.top.size ? { top: sorted(facts.top) } : {}),
      ...(facts.ops.size ? { ops: sorted(facts.ops) } : {}),
      ...(facts.ext.size ? { ext: sorted(facts.ext) } : {}),
      ...(facts.statics.size ? { statics: sorted(facts.statics) } : {}),
      ...(facts.extTypes.size ? { extTypes: sorted(facts.extTypes) } : {}),
      ...(facts.aliasOf.size ? { aliasOf: sorted(facts.aliasOf) } : {}),
    },
  };
}

/** Parents of a `.` that is not an implicit member: a member access, a
 *  qualified type or an import path. */
const QUALIFYING_DOT_PARENTS: ReadonlySet<string> = new Set([
  'navigation_suffix',
  'user_type',
  'import_declaration',
  'identifier',
]);

/** A word that can name a member: an identifier, or a keyword written as one
 *  (`.true`, `.nil`, `.self`, `.repeat(1)`). */
const IDENTIFIER_WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What `root` uses, outside `import` declarations. One cursor pass, linear in
 *  the tree: parent types come from a stack, and the member after an implicit
 *  `.` is read when the walk reaches it, never through `parent`/`nextSibling`
 *  lookups whose cost grows with depth. */
function collectUses(root: SyntaxNode): SwiftUsedNames {
  const ids = new Set<string>();
  const implicit = new Set<string>();
  const ops = new Set<string>();
  const parents: string[] = [];
  // After an implicit `.`, the first leaf of the next node names the member.
  let member: 'next' | 'leaf' | undefined;
  const cursor = root.walk();
  for (;;) {
    const type = cursor.nodeType;
    if (member === 'next') member = 'leaf';
    let descend = type !== 'import_declaration';
    let dot = false;
    switch (type) {
      case 'simple_identifier':
      case 'type_identifier': {
        const name = identifierText(cursor.nodeText);
        ids.add(name);
        if (member === 'leaf') implicit.add(name);
        member = undefined;
        descend = false;
        break;
      }
      case '.':
        // An implicit member: `.primary`, `case .large:`, `if case .x = v`,
        // `case let .some(v):`, `for case .x in xs`.
        dot = !QUALIFYING_DOT_PARENTS.has(parents[parents.length - 1] ?? '');
        break;
      default: {
        const sugar = SUGAR_TYPES[type];
        if (sugar !== undefined) ids.add(sugar);
        else if (isOperatorToken(cursor.currentNode)) {
          ops.add(type === 'custom_operator' ? cursor.nodeText : type);
          descend = false;
        }
      }
    }
    if (descend && cursor.gotoFirstChild()) {
      parents.push(type);
      continue;
    }
    if (member === 'leaf') {
      const word = cursor.nodeIsNamed ? identifierText(cursor.nodeText) : type;
      if (IDENTIFIER_WORD.test(word)) {
        ids.add(word);
        implicit.add(word);
      }
      member = undefined;
    }
    // A name error recovery left as a bare `ERROR` leaf (`consume x`).
    if (type === 'ERROR')
      for (const word of cursor.nodeText.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) ids.add(word);
    let moved = cursor.gotoNextSibling();
    if (moved && dot) member = 'next';
    while (!moved && cursor.gotoParent()) {
      parents.pop();
      member = undefined;
      moved = cursor.gotoNextSibling();
    }
    if (!moved) break;
  }
  const idList = [...ids].sort();
  const index = new Map(idList.map((name, i) => [name, i]));
  const implicitIndices =
    implicit.size === 0
      ? undefined
      : [...implicit].map((name) => index.get(name)!).sort((a, b) => a - b);
  const opList = sorted(ops);
  return {
    ids: idList,
    ...(implicitIndices ? { implicit: implicitIndices } : {}),
    ...(opList ? { ops: opList } : {}),
  };
}

/** Record the name facts of `filePath` from its syntax tree. Gathering never
 *  throws: a failure leaves the declarations unknown or the uses absent, which
 *  keeps every edge the facts would decide. */
export function recordSwiftNameFacts(filePath: string, root: SyntaxNode): void {
  let declared: ReturnType<typeof collectDeclarations>;
  let uses: SwiftUsedNames | undefined;
  try {
    declared = collectDeclarations(root);
  } catch {
    declared = { declares: null, unknown: 'failure' };
  }
  try {
    // Imports are top-level statements: decide before walking the whole tree.
    if (root.namedChildren.some((child) => child?.type === 'import_declaration'))
      uses = collectUses(root);
  } catch {
    uses = undefined;
  }
  latest = {
    filePath,
    facts: {
      kind: 'swift',
      nameFacts: {
        version: 5,
        declares: declared.declares,
        ...(declared.unknown === undefined ? {} : { unknown: declared.unknown }),
        ...(uses === undefined ? {} : { uses }),
      },
    },
  };
}

/** Worker-side snapshot of the facts recorded for `filePath`; undefined when
 * another file was captured since. */
export function collectSwiftCaptureSideChannel(
  filePath: string,
): SwiftCaptureSideChannel | undefined {
  return latest !== null && latest.filePath === filePath ? latest.facts : undefined;
}

const isNameList = (value: unknown): value is readonly string[] =>
  value === undefined || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
const isIndexList = (value: unknown, size: number): value is readonly number[] =>
  value === undefined ||
  (Array.isArray(value) && value.every((v) => Number.isInteger(v) && v >= 0 && v < size));

const factsByPayload = new WeakMap<object, SwiftNameFacts | null>();

/** The name facts of `parsed`, or undefined when they are missing or not
 * trustworthy. Facts survive a cache round trip as plain JSON. */
export function readSwiftNameFacts(parsed: ParsedFile): SwiftNameFacts | undefined {
  const payload = parsed.captureSideChannel as Partial<SwiftCaptureSideChannel> | undefined;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const cached = factsByPayload.get(payload);
  if (cached !== undefined) return cached ?? undefined;
  const facts = payload.kind === 'swift' ? payload.nameFacts : undefined;
  const declares = facts?.declares;
  const uses = facts?.uses;
  let read: SwiftNameFacts | null = null;
  if (
    facts?.version === 5 &&
    typeof declares === 'object' &&
    (declares === null ||
      (isNameList(declares.top) &&
        isNameList(declares.ops) &&
        isNameList(declares.ext) &&
        isNameList(declares.statics) &&
        isNameList(declares.extTypes) &&
        isNameList(declares.aliasOf))) &&
    (uses === undefined ||
      (typeof uses === 'object' &&
        uses !== null &&
        Array.isArray(uses.ids) &&
        isNameList(uses.ids) &&
        isIndexList(uses.implicit, uses.ids.length) &&
        isNameList(uses.ops)))
  ) {
    const set = (names: readonly string[] | undefined) => new Set(names ?? []);
    read = {
      ...(declares === null
        ? {}
        : {
            declares: {
              top: set(declares.top),
              ops: set(declares.ops),
              ext: set(declares.ext),
              statics: set(declares.statics),
              extTypes: set(declares.extTypes),
              aliasOf: set(declares.aliasOf),
            },
          }),
      ...(uses === undefined
        ? {}
        : {
            uses: {
              ids: set(uses.ids),
              implicit: new Set((uses.implicit ?? []).map((i) => uses.ids[i]!)),
              ops: set(uses.ops),
            },
          }),
    };
  }
  factsByPayload.set(payload, read);
  return read ?? undefined;
}
