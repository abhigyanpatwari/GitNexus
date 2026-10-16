import type Parser from 'tree-sitter';
import { buildPositionIndex, buildScopeTree, lookupLexicalName } from 'gitnexus-shared';
import type { ParsedFile, ParsedImport } from 'gitnexus-shared';
import { plainString } from './data-route-table.js';
import type { FrameworkExpression, FrameworkRouteFacts } from './framework-route-types.js';

type Node = Parser.SyntaxNode;
const UNKNOWN: FrameworkExpression = { kind: 'unknown' };
const HANDLER: FrameworkExpression = { kind: 'handler' };
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

/**
 * Reuses the parser's AST and ParsedFile lexical ownership. The only additional
 * data is framework value flow; declarations/scopes are never reconstructed.
 */
export function extractFrameworkRouteFacts(
  tree: Parser.Tree,
  parsedFile: ParsedFile,
  lineOffset = 0,
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
  };
  const scopes = buildScopeTree(parsedFile.scopes);
  const positions = buildPositionIndex(parsedFile.scopes);
  const invalid = new Set<string>();
  const importsAtPosition = new Map<string, ParsedImport[]>();
  for (const imported of parsedFile.parsedImports) {
    const key = `${imported.atRange.startLine}:${imported.atRange.startCol}`;
    const imports = importsAtPosition.get(key) ?? [];
    imports.push(imported);
    importsAtPosition.set(key, imports);
  }
  const expressionCache = new Map<number, FrameworkExpression>();
  const bindingKey = (scope: string, name: string): string => `${scope}\0${name}`;
  const ownership = (node: Node, name = node.text, atUse = false) => {
    const scope = positions.atPosition(
      filePath,
      node.startPosition.row + 1 + lineOffset,
      node.startPosition.column,
    );
    return scope === undefined
      ? undefined
      : lookupLexicalName(
          scope,
          name,
          { scopes },
          {
            purpose: 'value',
            ...(atUse
              ? {
                  position: {
                    startLine: node.startPosition.row + 1 + lineOffset,
                    startCol: node.startPosition.column,
                  },
                }
              : {}),
          },
        );
  };
  const bindingId = (node: Node, name = node.text, atUse = false): string | undefined => {
    const owner = ownership(node, name, atUse);
    // Pre-finalization imports and untyped parameters deliberately have no
    // BindingRef. A future binding claim, however, is a real TDZ barrier.
    if (
      atUse &&
      owner?.status === 'blocked' &&
      owner.claims.some(
        (claim) =>
          claim.kind === 'blocked' ||
          (claim.kind === 'binding' &&
            claim.availableFrom &&
            (claim.availableFrom.startLine > node.startPosition.row + 1 + lineOffset ||
              (claim.availableFrom.startLine === node.startPosition.row + 1 + lineOffset &&
                claim.availableFrom.startCol > node.startPosition.column))),
      )
    )
      return undefined;
    return owner?.scope ? bindingKey(owner.scope.id, name) : undefined;
  };
  const isGlobal = (node: Node, name: string) => ownership(node, name)?.status === 'absent';

  const expression = (node: Node | null | undefined, depth = 0): FrameworkExpression => {
    if (!node || depth > 64 || node.hasError) return UNKNOWN;
    const cached = expressionCache.get(node.id);
    if (cached) return cached;
    let value: FrameworkExpression = UNKNOWN;
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier') {
      const id = bindingId(node, node.text, true);
      if (id) value = { kind: 'binding', id };
    } else if (node.type === 'array') {
      value = {
        kind: 'array',
        elements: children(node).map((child) => expression(child, depth + 1)),
      };
    } else if (
      [
        'parenthesized_expression',
        'as_expression',
        'satisfies_expression',
        'non_null_expression',
      ].includes(node.type)
    ) {
      value = expression(children(node)[0], depth + 1);
    } else if (
      [
        'arrow_function',
        'function_expression',
        'function_declaration',
        'generator_function_declaration',
      ].includes(node.type)
    ) {
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
          paths: literalPaths(arguments_[0]),
        };
      }
    }
    expressionCache.set(node.id, value);
    return value;
  };

  const bind = (node: Node, value: FrameworkExpression): void => {
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
      const id = bindingId(node);
      if (id) facts.bindings.push({ id, value });
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
  const nodes: Node[] = [tree.rootNode];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.type === 'ERROR') continue;
    nodes.push(...children(node).reverse());
    if (node.type === 'import_statement') {
      // ESM decomposition already carries precise aliases/type-only flags. CJS
      // imports are intentionally handled at their AST calls to guard require.
      const position = `${node.startPosition.row + 1 + lineOffset}:${node.startPosition.column}`;
      for (const imported of importsAtPosition.get(position) ?? []) {
        if (!('localName' in imported) || !('importedName' in imported)) continue;
        const id = bindingKey(
          imported.declaredAtScope ?? parsedFile.moduleScope,
          imported.localName,
        );
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
    } else if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name');
      if (name) bind(name, expression(node.childForFieldName('value')));
    } else if (
      node.type === 'function_declaration' ||
      node.type === 'generator_function_declaration'
    ) {
      const name = node.childForFieldName('name');
      if (name) bind(name, HANDLER);
    } else if (node.type === 'export_statement') {
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
        exported(
          'default',
          expression(
            node.childForFieldName('value') ??
              node.childForFieldName('declaration') ??
              children(node)[0],
          ),
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
      node.type === 'assignment_expression' ||
      node.type === 'augmented_assignment_expression' ||
      node.type === 'update_expression' ||
      node.type === 'for_in_statement' ||
      (node.type === 'unary_expression' && node.children.some((child) => child.type === 'delete'))
    ) {
      const left = node.childForFieldName('left') ?? node.childForFieldName('argument');
      const right = node.childForFieldName('right');
      const object = left?.childForFieldName('object');
      const property = left?.childForFieldName('property');
      if (left?.type === 'identifier' && left.text === 'exports' && isGlobal(left, 'exports'))
        cjsShortcutDetached = true;
      const moduleExports = (candidate: Node | null | undefined): boolean =>
        candidate?.type === 'member_expression' &&
        candidate.childForFieldName('object')?.text === 'module' &&
        candidate.childForFieldName('property')?.text === 'exports' &&
        isGlobal(candidate, 'module');
      const writesExportProperty =
        moduleExports(object) || (object?.text === 'exports' && isGlobal(object, 'exports'));
      if (
        (left?.type === 'subscript_expression' && writesExportProperty) ||
        (node.type !== 'assignment_expression' && (moduleExports(left) || writesExportProperty))
      )
        cjsUnknownWrite = true;
      if (node.type === 'assignment_expression' && moduleExports(left)) {
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
        node.type === 'assignment_expression' &&
        left?.type === 'member_expression' &&
        property?.type === 'property_identifier' &&
        (moduleExports(object) || (object?.text === 'exports' && isGlobal(object, 'exports')))
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
        const invalidate = (target: Node) => {
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
              if (receiver.type !== 'member_expression' && receiver.type !== 'subscript_expression')
                break;
              receiver = receiver.childForFieldName('object');
            }
          } else for (const child of children(target)) invalidate(child);
        };
        invalidate(left);
      }
    } else if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      const method = callee?.childForFieldName('property')?.text;
      if (callee?.type === 'member_expression' && method && METHODS.has(method)) {
        const arguments_ = args(node);
        const handler = arguments_.at(-1);
        facts.calls.push({
          receiver: expression(callee.childForFieldName('object')),
          method,
          arguments: arguments_.map((argument) => expression(argument)),
          paths: literalPaths(arguments_[0]),
          lineNumber: node.startPosition.row + lineOffset,
          ...(handler?.type === 'identifier' ? { handlerName: handler.text } : {}),
        });
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
  return facts;
}
