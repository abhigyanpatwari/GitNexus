import type Parser from 'tree-sitter';
import type { ParsedFile, ParsedImport } from 'gitnexus-shared';
import { plainString } from './data-route-table.js';
import { unboundCallableName } from '../languages/typescript/unbound-callables.js';
import type { FrameworkExpression, FrameworkRouteFacts } from './framework-route-types.js';
import {
  buildJsRepoFacts,
  dottedNameOf,
  extractJsModuleFacts,
  resolveJsPathExpression,
  type JsRepoFacts,
} from './js-const-resolver.js';
import {
  createLexicalBindings,
  importBindingKey,
  isCommonJsGlobal,
  isModuleExports,
  LEXICAL_FUNCTION_TYPES,
  parameterPattern,
  patternBindingNames,
  TRANSPARENT_EXPRESSION_TYPES,
  transparentInner,
  type LexicalBindings,
} from './lexical-bindings.js';

type Node = Parser.SyntaxNode;
const UNKNOWN: FrameworkExpression = { kind: 'unknown' };
const HANDLER: FrameworkExpression = { kind: 'handler' };
/** Expressions that can evaluate to a framework allocation passed into a helper. */
const CARRIER_KINDS = new Set<FrameworkExpression['kind']>([
  'binding',
  'call',
  'member',
  'import',
  'array',
]);
/** Function values and declarations; methods and signatures are not values here. */
const FUNCTION_TYPES = [
  'arrow_function',
  'function_expression',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
];
const METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'route', 'use']);
const children = (node: Node | null | undefined): Node[] =>
  node?.namedChildren.filter((child) => child.type !== 'comment') ?? [];
const args = (node: Node): Node[] => children(node.childForFieldName('arguments'));

function literalPaths(node: Node | undefined): string[] | null {
  if (!node) return null;
  const value = plainString(node);
  if (value !== null) return value.startsWith('/') ? [value] : null;
  if (node.type !== 'array') return null;
  const paths = children(node).map((child) => plainString(child));
  return paths.length > 0 && paths.every((path) => path !== null && path.startsWith('/'))
    ? [...new Set(paths as string[])]
    : null;
}

/** Expression shapes a module-constant path can be written in. */
const CONSTANT_PATH_TYPES = new Set([
  'identifier',
  'member_expression',
  'template_string',
  'binary_expression',
]);

/** `x as const`, `(x)`, `x satisfies T` → `x`. */
function unwrapTransparent(node: Node | null): Node | null {
  let current = node;
  while (current && TRANSPARENT_EXPRESSION_TYPES.has(current.type))
    current = transparentInner(current);
  return current;
}

/** Nesting bound for {@link isPlainTable}; deeper tables are simply not trusted. */
const MAX_TABLE_DEPTH = 8;

/**
 * Whether an object literal's value at runtime is exactly what
 * `flattenObjectLiteral` records: only `key: value` pairs with static,
 * distinct keys, and nested tables that are plain too.
 *
 * The flattener skips everything else, and anything else can change what a
 * member read returns: a getter or setter (`get A() {…}` beats an earlier
 * `A: '/x'`), a method, a spread, a computed key, a shorthand property, a
 * repeated key, or a `__proto__` entry that swaps the prototype. Any of those
 * makes the whole table untrusted instead of folding a value the runtime may
 * never see.
 */
function isPlainTable(node: Node, depth = 0): boolean {
  if (depth > MAX_TABLE_DEPTH) return false;
  const keys = new Set<string>();
  for (const member of children(node)) {
    if (member.type !== 'pair') return false;
    const key = member.childForFieldName('key');
    if (!key || (key.type !== 'property_identifier' && key.type !== 'string')) return false;
    const name = key.type === 'string' ? plainString(key) : key.text;
    if (name === null || name === '__proto__' || keys.has(name)) return false;
    keys.add(name);
    const value = unwrapTransparent(member.childForFieldName('value'));
    if (value?.type === 'object' && !isPlainTable(value, depth + 1)) return false;
  }
  return true;
}

/**
 * Top-level `const` declarator names, including `export const`. `table` marks a
 * const bound to an object literal: its members stay writable, unlike a string.
 * `plain` is {@link isPlainTable} for a table.
 */
function moduleConstNames(
  root: Node,
): { name: Node; table: boolean; plain: boolean; exported: boolean }[] {
  const names: { name: Node; table: boolean; plain: boolean; exported: boolean }[] = [];
  for (const statement of children(root)) {
    const declaration =
      statement.type === 'export_statement'
        ? statement.childForFieldName('declaration')
        : statement;
    if (declaration?.type !== 'lexical_declaration') continue;
    if (declaration.child(0)?.type !== 'const') continue;
    for (const declarator of children(declaration)) {
      const name = declarator.childForFieldName('name');
      if (declarator.type !== 'variable_declarator' || name?.type !== 'identifier') continue;
      const value = unwrapTransparent(declarator.childForFieldName('value'));
      const table = value?.type === 'object';
      names.push({
        name,
        table,
        plain: table && value !== null && isPlainTable(value),
        exported: statement.type === 'export_statement',
      });
    }
  }
  return names;
}

/** The outermost member read a name heads (`T` in `T.A.B` → `T.A.B`). */
function outermostMember(node: Node): Node {
  let current = node;
  while (
    current.parent?.type === 'member_expression' &&
    current.parent.childForFieldName('object')?.id === current.id
  )
    current = current.parent;
  return current;
}

/** The member/subscript target an assignment, update or `delete` writes, if any. */
function writtenMember(node: Node): Node | null {
  let target: Node | null = null;
  if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression')
    target = node.childForFieldName('left');
  else if (node.type === 'update_expression') target = node.childForFieldName('argument');
  else if (
    node.type === 'unary_expression' &&
    node.children.some((child) => child.type === 'delete')
  )
    target = node.childForFieldName('argument');
  return target?.type === 'member_expression' || target?.type === 'subscript_expression'
    ? target
    : null;
}

/**
 * Route paths written through the file's own module constants: `const USERS =
 * '/api/users'`, a table member `PATHS.USERS`, `BASE + '/x'` and `` `${BASE}/x` ``.
 *
 * Folding reuses the consumer-side resolver (`resolveJsPathExpression`), so a
 * provider and the code calling it read one constant the same way. Every
 * identifier in the expression must resolve, at the use site, to a top-level
 * `const` of this file. A local that shadows it, a `let`, an import, a
 * parameter or any call leaves the path unknown, which keeps the previous
 * behavior (no route) rather than inventing one.
 *
 * A table (a const bound to an object literal) is trusted only while every
 * reference to it in the file reads a string leaf (`T.A`, `T.N.A`) and none
 * writes one. Any other use lets the object escape (an alias, a call argument,
 * a shorthand property, an export in any form, a subscript, a sub-table read),
 * and an escaped object can be written where this scan cannot follow, so the
 * table is not folded. `as const` is a type, not `Object.freeze`, so an
 * exported table is writable by its importers. A table whose literal is not
 * plain ({@link isPlainTable}: a getter, a method, a spread, a computed or
 * repeated key) is not folded either. Strings are immutable, so plain consts,
 * exported or not, need no such check.
 *
 * Every reference in the path must fold on its own, so a const whose value is
 * not a string leaves the path unknown instead of a `${…}` placeholder, while
 * a string const that merely contains `${` keeps its text, as a literal would.
 *
 * The const scan and the module facts are built on first use, so a file whose
 * routes are all literals pays nothing.
 */
function createConstantPaths(
  tree: Parser.Tree,
  filePath: string,
  lexical: LexicalBindings,
): (node: Node | undefined) => string[] | null {
  // Top-level statements only: cheap, and enough to reject the common case (a
  // helper called with a local or a parameter) before any whole-file work.
  // `untrustedTables` are tables rejected from their declaration alone: exported,
  // or not plain. The escape scan in `fold` adds the ones rejected by their uses.
  let consts:
    | { ids: Set<string>; tables: Set<string>; untrustedTables: Set<string>; declared: Set<number> }
    | undefined;
  const moduleConsts = () => {
    if (consts) return consts;
    consts = { ids: new Set(), tables: new Set(), untrustedTables: new Set(), declared: new Set() };
    for (const { name, table, plain, exported } of moduleConstNames(tree.rootNode)) {
      const id = lexical.bindingId(name);
      if (!id || lexical.ambiguous(id)) continue;
      consts.ids.add(id);
      consts.declared.add(name.id);
      if (table) consts.tables.add(id);
      if (table && (exported || !plain)) consts.untrustedTables.add(id);
    }
    return consts;
  };
  // Whole-file table escapes and module facts, built once and only for a path
  // whose every identifier is already a module const.
  let folding: { untrusted: Set<string>; facts: JsRepoFacts } | undefined;
  const fold = () => {
    if (folding) return folding;
    const { tables, untrustedTables, declared } = moduleConsts();
    const facts = buildJsRepoFacts(new Map([[filePath, extractJsModuleFacts(tree)]]));
    const leaves = facts.byFile.get(filePath)?.constants.literals ?? new Map<string, string>();
    const untrusted = new Set(untrustedTables);
    const pending: Node[] = tables.size > 0 ? [tree.rootNode] : [];
    for (let node = pending.pop(); node; node = pending.pop()) {
      for (const child of node.namedChildren) pending.push(child);
      if (node.type === 'shorthand_property_identifier') {
        const id = lexical.bindingId(node, node.text, true);
        if (id && tables.has(id)) untrusted.add(id);
        continue;
      }
      if (node.type !== 'identifier' || declared.has(node.id)) continue;
      const id = lexical.bindingId(node, node.text, true);
      if (!id || !tables.has(id)) continue;
      const read = outermostMember(node);
      // `typeof T` in a type position reads nothing at runtime.
      if (read.parent?.type === 'type_query') continue;
      const dotted = read.id === node.id ? null : dottedNameOf(read);
      const written = read.parent ? writtenMember(read.parent)?.id === read.id : false;
      if (dotted === null || !leaves.has(dotted) || written) untrusted.add(id);
    }
    folding = { untrusted, facts };
    return folding;
  };

  return (node) => {
    if (!node || node.hasError || !CONSTANT_PATH_TYPES.has(node.type)) return null;
    const { ids } = moduleConsts();
    if (ids.size === 0) return null;
    const used: string[] = [];
    const references: Node[] = [];
    const pending: Node[] = [node];
    for (let current = pending.pop(); current; current = pending.pop()) {
      if (current.type === 'identifier') {
        const id = lexical.bindingId(current, current.text, true);
        if (!id || !ids.has(id)) return null;
        used.push(id);
        references.push(outermostMember(current));
      } else if (
        current.type === 'call_expression' ||
        current.type === 'new_expression' ||
        current.type === 'subscript_expression' ||
        LEXICAL_FUNCTION_TYPES.has(current.type)
      ) {
        return null;
      }
      for (const child of current.namedChildren) pending.push(child);
    }
    const { untrusted, facts } = fold();
    if (used.some((id) => untrusted.has(id))) return null;
    if (
      references.some((reference) => resolveJsPathExpression(filePath, reference, facts) === null)
    )
      return null;
    const path = resolveJsPathExpression(filePath, node, facts);
    return path !== null && path.startsWith('/') ? [path] : null;
  };
}

/**
 * Reuses the parser's AST and ParsedFile lexical ownership. The only additional
 * data is framework value flow; declarations/scopes are never reconstructed.
 */
export function extractFrameworkRouteFacts(
  tree: Parser.Tree,
  parsedFile: ParsedFile,
  lineOffset = 0,
  lexical: LexicalBindings = createLexicalBindings(parsedFile, lineOffset, tree.rootNode),
): FrameworkRouteFacts {
  const filePath = parsedFile.filePath;
  const facts: FrameworkRouteFacts = {
    filePath,
    bindings: [],
    exports: [],
    starExports: [],
    invalidBindings: [],
    mutations: [],
    calls: [],
    invocations: [],
  };
  const { bindingId, isGlobal, ambiguous } = lexical;
  const constantPaths = createConstantPaths(tree, filePath, lexical);
  const pathsOf = (node: Node | undefined): string[] | null =>
    literalPaths(node) ?? constantPaths(node);
  const invalid = new Set<string>();
  const importsAtPosition = new Map<string, ParsedImport[]>();
  for (const imported of parsedFile.parsedImports) {
    const key = `${imported.atRange.startLine}:${imported.atRange.startCol}`;
    const imports = importsAtPosition.get(key) ?? [];
    imports.push(imported);
    importsAtPosition.set(key, imports);
  }
  const expressionCache = new Map<number, FrameworkExpression>();
  const importedNames = new Set(
    parsedFile.parsedImports.flatMap((imported) =>
      'localName' in imported ? [imported.localName] : [],
    ),
  );
  const parameterIds = new Map<number, ReadonlySet<string>>();
  const parametersOf = (fn: Node): ReadonlySet<string> => {
    let ids = parameterIds.get(fn.id);
    if (!ids) {
      ids = new Set(
        patternBindingNames(
          fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter'),
        ).flatMap((name) => {
          const id = bindingId(name);
          return id ? [id] : [];
        }),
      );
      parameterIds.set(fn.id, ids);
    }
    return ids;
  };
  const functionValue = (fn: Node): FrameworkExpression => {
    const single = fn.childForFieldName('parameter');
    const params = single ? [single] : children(fn.childForFieldName('parameters'));
    return {
      kind: 'handler',
      fn: `${filePath}:${fn.startIndex}`,
      params: params
        // TypeScript's `this: T` declares the receiver, not an argument position.
        .filter((param) => param.childForFieldName('pattern')?.type !== 'this')
        .map((param) => {
          const name = parameterPattern(param);
          const id = name?.type === 'identifier' ? bindingId(name) : undefined;
          return id && !ambiguous(id) ? id : null;
        }),
    };
  };

  const expression = (node: Node | null | undefined, depth = 0): FrameworkExpression => {
    if (!node || depth > 64 || node.hasError) return UNKNOWN;
    const cached = expressionCache.get(node.id);
    if (cached) return cached;
    let value: FrameworkExpression = UNKNOWN;
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier') {
      const id = bindingId(node, node.text, true);
      if (id && !ambiguous(id)) value = { kind: 'binding', id };
    } else if (node.type === 'array') {
      value = {
        kind: 'array',
        elements: children(node).map((child) => expression(child, depth + 1)),
      };
    } else if (TRANSPARENT_EXPRESSION_TYPES.has(node.type)) {
      value = expression(transparentInner(node), depth + 1);
    } else if (FUNCTION_TYPES.includes(node.type)) {
      value = HANDLER;
    } else if (node.type === 'member_expression') {
      const name = node.childForFieldName('property');
      if (name?.type === 'property_identifier')
        value = {
          kind: 'member',
          object: expression(node.childForFieldName('object'), depth + 1),
          name: name.text,
        };
    } else if (node.type === 'call_expression' || node.type === 'new_expression') {
      const callee = node.childForFieldName(
        node.type === 'new_expression' ? 'constructor' : 'function',
      );
      const arguments_ = args(node);
      const source = arguments_[0] && plainString(arguments_[0]);
      if (
        callee?.type === 'identifier' &&
        callee.text === 'require' &&
        isGlobal(callee, 'require') &&
        source &&
        arguments_.length === 1
      ) {
        value = { kind: 'import', source, name: 'require' };
      } else {
        value = {
          kind: 'call',
          id: `${filePath}:${node.startIndex}`,
          callee: expression(callee, depth + 1),
          construct: node.type === 'new_expression',
          argumentCount: arguments_.length,
          paths: pathsOf(arguments_[0]),
        };
      }
    }
    expressionCache.set(node.id, value);
    return value;
  };

  const bind = (node: Node, value: FrameworkExpression): void => {
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
      const id = bindingId(node);
      if (id && !ambiguous(id)) facts.bindings.push({ id, value });
    } else if (node.type === 'object_pattern') {
      for (const part of children(node)) {
        const key = part.type === 'pair_pattern' ? part.childForFieldName('key') : part;
        const target = part.type === 'pair_pattern' ? part.childForFieldName('value') : part;
        if (
          key &&
          target &&
          ['identifier', 'property_identifier', 'shorthand_property_identifier_pattern'].includes(
            key.type,
          )
        ) {
          bind(target, { kind: 'member', object: value, name: key.text });
        }
      }
    }
  };
  const exported = (name: string, value: FrameworkExpression) =>
    facts.exports.push({ name, value });
  let cjsDefaultAssignments = 0;
  let cjsShortcutDetached = false;
  let cjsUnknownWrite = false;
  const cjsShortcutExports: { name: string; value: FrameworkExpression }[] = [];
  const cjsExports: { name: string; value: FrameworkExpression }[] = [];
  const nodes: { node: Node; enclosingFunction?: Node }[] = [{ node: tree.rootNode }];
  while (nodes.length) {
    const { node, enclosingFunction } = nodes.pop()!;
    const type = node.type;
    if (type === 'ERROR') continue;
    const childFunction = LEXICAL_FUNCTION_TYPES.has(type) ? node : enclosingFunction;
    for (const child of children(node).reverse())
      nodes.push({ node: child, enclosingFunction: childFunction });
    if (type === 'import_statement') {
      // ESM decomposition already carries precise aliases/type-only flags. CJS
      // imports are intentionally handled at their AST calls to guard require.
      const position = `${node.startPosition.row + 1 + lineOffset}:${node.startPosition.column}`;
      for (const imported of importsAtPosition.get(position) ?? []) {
        if (!('localName' in imported) || !('importedName' in imported)) continue;
        const id = importBindingKey(parsedFile, imported);
        facts.bindings.push({
          id,
          value:
            'typeOnly' in imported && imported.typeOnly
              ? UNKNOWN
              : {
                  kind: 'import',
                  source: imported.targetRaw,
                  name: imported.kind === 'namespace' ? '*' : imported.importedName,
                },
        });
      }
    } else if (type === 'variable_declarator') {
      const name = node.childForFieldName('name');
      const value = node.childForFieldName('value');
      if (value && enclosingFunction) {
        const parameters = parametersOf(enclosingFunction);
        for (const target of patternBindingNames(name)) {
          const id = bindingId(target);
          if (id && parameters.has(id)) invalid.add(id);
        }
      }
      // Only a named function can be called by name, so only it carries the
      // identity and parameters call-site forwarding needs.
      if (name)
        bind(
          name,
          value && FUNCTION_TYPES.includes(value.type) ? functionValue(value) : expression(value),
        );
    } else if (type === 'function_declaration' || type === 'generator_function_declaration') {
      const name = node.childForFieldName('name');
      if (name && enclosingFunction) {
        const id = bindingId(name);
        if (id && parametersOf(enclosingFunction).has(id)) invalid.add(id);
      }
      if (name) bind(name, functionValue(node));
    } else if (type === 'export_statement') {
      const sourceNode = node.childForFieldName('source');
      const source = sourceNode && plainString(sourceNode);
      if (node.children.some((child) => child.type === 'type')) continue;
      const clause = children(node).find((child) => child.type === 'export_clause');
      if (clause) {
        for (const specifier of children(clause)) {
          if (specifier.children.some((child) => child.type === 'type')) continue;
          const name = specifier.childForFieldName('name');
          const alias = specifier.childForFieldName('alias');
          if (name)
            exported(
              alias?.text ?? name.text,
              source ? { kind: 'import', source, name: name.text } : expression(name),
            );
        }
      } else if (node.children.some((child) => child.type === 'default')) {
        const declaration =
          node.childForFieldName('value') ??
          node.childForFieldName('declaration') ??
          children(node)[0];
        exported(
          'default',
          declaration && FUNCTION_TYPES.includes(declaration.type)
            ? functionValue(declaration)
            : expression(declaration),
        );
      } else if (source) {
        const namespace = children(node).find((child) => child.type === 'namespace_export');
        const name = namespace && children(namespace)[0];
        if (name) exported(name.text, { kind: 'import', source, name: '*' });
        else if (!node.hasError) facts.starExports.push(source);
      } else {
        const declaration = node.childForFieldName('declaration');
        if (
          declaration?.type === 'lexical_declaration' ||
          declaration?.type === 'variable_declaration'
        ) {
          for (const declarator of children(declaration)) {
            const name = declarator.childForFieldName('name');
            if (name?.type === 'identifier') {
              const id = bindingId(name);
              if (id) exported(name.text, { kind: 'binding', id });
            }
          }
        } else {
          const name = declaration?.childForFieldName('name');
          if (name) exported(name.text, expression(name));
        }
      }
    } else if (
      type === 'assignment_expression' ||
      type === 'augmented_assignment_expression' ||
      type === 'update_expression' ||
      type === 'for_in_statement' ||
      (type === 'unary_expression' && node.children.some((child) => child.type === 'delete'))
    ) {
      const left = node.childForFieldName('left') ?? node.childForFieldName('argument');
      const right = node.childForFieldName('right');
      const object = left?.childForFieldName('object');
      const property = left?.childForFieldName('property');
      if (isCommonJsGlobal(lexical, left, 'exports')) cjsShortcutDetached = true;
      const writesExportProperty =
        isModuleExports(lexical, object) || isCommonJsGlobal(lexical, object, 'exports');
      if (
        (left?.type === 'subscript_expression' && writesExportProperty) ||
        (type !== 'assignment_expression' &&
          (isModuleExports(lexical, left) || writesExportProperty))
      )
        cjsUnknownWrite = true;
      if (type === 'assignment_expression' && isModuleExports(lexical, left)) {
        cjsDefaultAssignments++;
        cjsExports.length = 0;
        if (right?.type === 'object') {
          cjsExports.push({ name: 'default', value: UNKNOWN });
          for (const part of children(right)) {
            const key = part.type === 'pair' ? part.childForFieldName('key') : part;
            const value = part.type === 'pair' ? part.childForFieldName('value') : part;
            if (
              key &&
              ['property_identifier', 'identifier', 'shorthand_property_identifier'].includes(
                key.type,
              )
            ) {
              cjsExports.push({ name: key.text, value: expression(value) });
            } else {
              // A spread, computed key, or other unsupported member can replace
              // an earlier explicit export. Never retain a partial object shape.
              cjsUnknownWrite = true;
            }
          }
        } else cjsExports.push({ name: 'default', value: expression(right) });
      } else if (
        type === 'assignment_expression' &&
        left?.type === 'member_expression' &&
        property?.type === 'property_identifier' &&
        writesExportProperty
      ) {
        const record = { name: property.text, value: expression(right) };
        if (object?.text === 'exports') {
          if (!cjsShortcutDetached) cjsShortcutExports.push(record);
        } else {
          // A replacement module.exports can itself be a Router. Writing one of
          // its properties mutates that allocation, not only the export table.
          const defaultValue = cjsExports.find((entry) => entry.name === 'default')?.value;
          if (defaultValue) facts.mutations.push(defaultValue);
          cjsExports.push(record);
        }
      } else if (left) {
        const invalidate = (root: Node) => {
          const pending = [root];
          while (pending.length > 0) {
            const target = pending.pop()!;
            if (
              target.type === 'identifier' ||
              target.type === 'shorthand_property_identifier_pattern'
            ) {
              const id = bindingId(target);
              if (id) invalid.add(id);
            } else if (
              target.type === 'member_expression' ||
              target.type === 'subscript_expression'
            ) {
              let receiver = target.childForFieldName('object');
              while (receiver) {
                // A namespace member can resolve to an exported allocation even
                // when the namespace itself is only a module value.
                facts.mutations.push(expression(receiver));
                if (
                  receiver.type !== 'member_expression' &&
                  receiver.type !== 'subscript_expression'
                )
                  break;
                receiver = receiver.childForFieldName('object');
              }
            } else if (target.type === 'pair_pattern') {
              const value = target.childForFieldName('value');
              if (value) pending.push(value);
            } else if (
              target.type === 'assignment_pattern' ||
              target.type === 'object_assignment_pattern'
            ) {
              const value = target.childForFieldName('left');
              if (value) pending.push(value);
            } else if (['object_pattern', 'array_pattern', 'rest_pattern'].includes(target.type)) {
              // Reverse pushes keep source order for recorded mutations.
              const items = children(target);
              for (let i = items.length - 1; i >= 0; i--) pending.push(items[i]);
            } else if (TRANSPARENT_EXPRESSION_TYPES.has(target.type)) {
              const inner = transparentInner(target);
              if (inner) pending.push(inner);
            }
          }
        };
        invalidate(left);
      }
    } else if (type === 'call_expression') {
      const callee = node.childForFieldName('function');
      const method = callee?.childForFieldName('property')?.text;
      if (callee?.type === 'member_expression' && method && METHODS.has(method)) {
        const arguments_ = args(node);
        const handler = arguments_.at(-1);
        // An inline handler has no binding; its Function node carries the
        // positional name the capture layer gives it (#3488).
        const handlerName =
          handler?.type === 'identifier' ? handler.text : handler && unboundCallableName(handler);
        facts.calls.push({
          receiver: expression(callee.childForFieldName('object')),
          method,
          arguments: arguments_.map((argument) => expression(argument)),
          paths: pathsOf(arguments_[0]),
          lineNumber: node.startPosition.row + lineOffset,
          ...(handlerName ? { handlerName } : {}),
        });
      } else if (
        callee?.type === 'identifier' ||
        (callee?.type === 'member_expression' &&
          importedNames.has(callee.childForFieldName('object')?.text ?? ''))
      ) {
        // A helper such as `mountRoutes(app, '/p')` may register on its
        // parameters. Only a plain call or a namespace/default import member can
        // reach a named function; arguments after a spread have no position.
        const arguments_ = args(node);
        const spread = arguments_.findIndex((argument) => argument.type === 'spread_element');
        const positional = spread < 0 ? arguments_ : arguments_.slice(0, spread);
        // Keep only arguments that can carry an allocation or a literal path;
        // a call passing neither cannot forward anything a resolver could use.
        const carried = positional.map((argument) => {
          const value = expression(argument);
          return CARRIER_KINDS.has(value.kind) ? value : UNKNOWN;
        });
        const paths = positional.map((argument) => pathsOf(argument));
        if (carried.some((value) => value !== UNKNOWN) || paths.some((path) => path !== null))
          facts.invocations.push({ callee: expression(callee), arguments: carried, paths });
      }
    }
  }
  // exports is only the original module.exports alias. A replacement breaks
  // that alias; do not attribute its writes to the replacement object.
  if (!cjsUnknownWrite) {
    if (cjsDefaultAssignments === 0) facts.exports.push(...cjsShortcutExports);
    if (cjsDefaultAssignments <= 1) facts.exports.push(...cjsExports);
  }
  facts.invalidBindings = [...invalid];
  // A callee bound in this file to anything but a named function, an import or
  // an alias (a callback parameter such as `next(err)`, a local object) can
  // never reach a function registering on its parameters.
  // An argument bound to a parameter or a function cannot be an allocation (a
  // site argument that is itself a parameter never resolves), so it is dropped,
  // and so is a call left with nothing to forward.
  const valueKinds = new Map<string, Set<FrameworkExpression['kind']>>();
  for (const { id, value } of facts.bindings)
    valueKinds.set(id, (valueKinds.get(id) ?? new Set()).add(value.kind));
  const callable = (id: string) =>
    ['handler', 'import', 'binding', 'member'].some((kind) =>
      valueKinds.get(id)?.has(kind as FrameworkExpression['kind']),
    );
  const allocatable = (value: FrameworkExpression): boolean => {
    switch (value.kind) {
      case 'binding':
        return [...(valueKinds.get(value.id) ?? [])].some(
          (kind) => kind !== 'handler' && kind !== 'unknown',
        );
      case 'member':
        return allocatable(value.object);
      case 'call':
        return allocatable(value.callee);
      case 'array':
        return value.elements.some(allocatable);
      default:
        return value.kind === 'import';
    }
  };
  facts.invocations = facts.invocations.flatMap((invocation) => {
    if (invocation.callee.kind === 'binding' && !callable(invocation.callee.id)) return [];
    const carried = invocation.arguments.map((value) => (allocatable(value) ? value : UNKNOWN));
    return carried.some((value) => value !== UNKNOWN) || invocation.paths.some(Boolean)
      ? [{ ...invocation, arguments: carried }]
      : [];
  });
  return facts;
}
