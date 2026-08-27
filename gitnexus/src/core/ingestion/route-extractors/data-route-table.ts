/**
 * Conservative extraction for explicit JavaScript-style route tables.
 *
 * A generic object containing `path`, `method`, and `handler` can also be an
 * HTTP client request descriptor. Extraction therefore requires both a
 * route-named binding and a static `for (... of table)` dispatch loop whose
 * request guard compares the entry's path and method before directly invoking
 * its handler.
 */
import type Parser from 'tree-sitter';
import type { SyntaxNode } from 'tree-sitter';
import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';

export const DATA_ROUTE_TABLE_SOURCE = 'data-route-table';

const ROUTE_BINDING_HINT = /route/i;
const ROUTE_TOKEN_HINTS = ['path', 'method', 'handler'] as const;
const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

export interface DataRouteTableRoute {
  path: string;
  method: string;
  /** Full static handler designator, e.g. `auth.getCurrentUser`. */
  handlerDesignator: string;
  handlerName: string;
  /** Present only for a bare handler identifier, for named-import resolution. */
  handlerLocalName?: string;
  line: number;
}

const SIMPLE_STRING_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

function decodeJavaScriptStringLiteral(raw: string): string | null {
  if (raw.length < 2) return null;
  const delimiter = raw[0];
  if (
    (delimiter !== "'" && delimiter !== '"' && delimiter !== '`') ||
    raw[raw.length - 1] !== delimiter
  ) {
    return null;
  }

  const body = raw.slice(1, -1);
  let decoded = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char !== '\\') {
      if (delimiter !== '`' && (char === '\n' || char === '\r')) return null;
      decoded += char;
      continue;
    }

    const escaped = body[++index];
    if (escaped === undefined) return null;
    if (escaped === '\n' || escaped === '\u2028' || escaped === '\u2029') continue;
    if (escaped === '\r') {
      if (body[index + 1] === '\n') index++;
      continue;
    }

    const simple = SIMPLE_STRING_ESCAPES[escaped];
    if (simple !== undefined) {
      decoded += simple;
      continue;
    }
    if (escaped === '0') {
      if (/\d/.test(body[index + 1] ?? '')) return null;
      decoded += '\0';
      continue;
    }
    if (/[1-9]/.test(escaped)) return null;
    if (escaped === 'x') {
      const hex = body.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (escaped === 'u') {
      if (body[index + 1] === '{') {
        const close = body.indexOf('}', index + 2);
        if (close === -1) return null;
        const hex = body.slice(index + 2, close);
        if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) return null;
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff) return null;
        decoded += String.fromCodePoint(codePoint);
        index = close;
        continue;
      }
      const hex = body.slice(index + 1, index + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }

    // JavaScript treats an escaped non-special character as that character.
    decoded += escaped;
  }
  return decoded;
}

/**
 * A `string`/`template_string` node's decoded value, or `null` when it is not a
 * readable literal (an interpolated template, an unterminated escape). Shared
 * with the NestJS extractor so both agree on what a readable literal is —
 * notably that escapes must be DECODED, not dropped, because tree-sitter splits
 * a literal around every `escape_sequence`.
 */
export function plainString(node: SyntaxNode): string | null {
  if (node.type === 'string') return decodeJavaScriptStringLiteral(node.text);
  if (
    node.type === 'template_string' &&
    node.namedChildren.every(
      (child) => child.type === 'string_fragment' || child.type === 'escape_sequence',
    )
  ) {
    return decodeJavaScriptStringLiteral(node.text);
  }
  return null;
}

/**
 * A property key's name, for the spellings that carry one — `{ path: … }` and
 * `{ 'path': … }`. A computed key (`{ [KEY]: … }`) has none. Shared with the
 * NestJS extractor, which reads `@Controller({ path: … })` the same way.
 */
export function propertyName(node: SyntaxNode): string | null {
  if (node.type === 'identifier' || node.type === 'property_identifier') return node.text;
  if (node.type === 'string') return plainString(node);
  return null;
}

function handlerName(
  node: SyntaxNode,
): { designator: string; name: string; localName?: string } | null {
  if (node.type === 'identifier') {
    return { designator: node.text, name: node.text, localName: node.text };
  }
  if (node.type !== 'member_expression') return null;

  const object = node.childForFieldName('object');
  const property = node.childForFieldName('property');
  if (
    object?.type !== 'identifier' ||
    property === null ||
    property.type !== 'property_identifier'
  ) {
    return null;
  }
  return {
    designator: `${object.text}.${property.text}`,
    name: property.text,
  };
}

const EXECUTING_VALUE_NODES = new Set([
  'assignment_expression',
  'augmented_assignment_expression',
  'await_expression',
  'call_expression',
  'new_expression',
  'spread_element',
  'update_expression',
  'yield_expression',
]);

function containsExecutingExpression(node: SyntaxNode): boolean {
  if (EXECUTING_VALUE_NODES.has(node.type)) return true;
  if (node.type === 'unary_expression' && node.text.trimStart().startsWith('delete ')) return true;
  return node.namedChildren.some(containsExecutingExpression);
}

function routeFromObject(node: SyntaxNode): DataRouteTableRoute | null {
  const values = new Map<string, SyntaxNode>();
  for (const child of node.namedChildren) {
    if (child.type === 'comment') continue;
    // Spread properties, methods, computed keys, and other executable shapes
    // make the entry non-declarative, so the whole entry is suppressed.
    if (child.type !== 'pair') return null;
    const keyNode = child.childForFieldName('key');
    const valueNode = child.childForFieldName('value');
    if (keyNode === null || valueNode === null) return null;
    const key = propertyName(keyNode);
    if (key === null) return null;
    if (!ROUTE_TOKEN_HINTS.includes(key as (typeof ROUTE_TOKEN_HINTS)[number])) {
      if (containsExecutingExpression(valueNode)) return null;
      continue;
    }
    if (values.has(key)) return null;
    values.set(key, valueNode);
  }

  const pathNode = values.get('path');
  const methodNode = values.get('method');
  const handlerNode = values.get('handler');
  if (pathNode === undefined || methodNode === undefined || handlerNode === undefined) return null;

  const path = plainString(pathNode);
  const rawMethod = plainString(methodNode);
  const handler = handlerName(handlerNode);
  if (path === null || !path.startsWith('/') || rawMethod === null || handler === null) return null;
  const method = rawMethod.toUpperCase();
  if (!HTTP_METHODS.has(method)) return null;

  return {
    path,
    method,
    handlerDesignator: handler.designator,
    handlerName: handler.name,
    ...(handler.localName === undefined ? {} : { handlerLocalName: handler.localName }),
    line: node.startPosition.row + 1,
  };
}

function staticRouteIdentity(node: SyntaxNode): string | null {
  const values = new Map<string, SyntaxNode>();
  let lastUnknownProperty = -1;
  let lastPath = -1;
  let lastMethod = -1;
  for (const [index, child] of node.namedChildren.entries()) {
    if (child.type === 'comment') continue;
    if (child.type !== 'pair') {
      lastUnknownProperty = index;
      continue;
    }
    const keyNode = child.childForFieldName('key');
    const valueNode = child.childForFieldName('value');
    if (keyNode === null || valueNode === null) {
      lastUnknownProperty = index;
      continue;
    }
    const key = propertyName(keyNode);
    if (key === null) {
      lastUnknownProperty = index;
      continue;
    }
    if (!ROUTE_TOKEN_HINTS.includes(key as (typeof ROUTE_TOKEN_HINTS)[number])) continue;
    values.set(key, valueNode);
    if (key === 'path') lastPath = index;
    if (key === 'method') lastMethod = index;
  }
  const pathNode = values.get('path');
  const methodNode = values.get('method');
  if (pathNode === undefined || methodNode === undefined || !values.has('handler')) return null;
  if (lastPath < lastUnknownProperty || lastMethod < lastUnknownProperty) return null;
  const path = plainString(pathNode);
  const rawMethod = plainString(methodNode);
  if (path === null || !path.startsWith('/') || rawMethod === null) return null;
  const method = rawMethod.toUpperCase();
  return HTTP_METHODS.has(method) ? `${method}\0${path}` : null;
}

function lexicalContainer(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (current.parent !== null) {
    current = current.parent;
    if (current.type === 'program' || current.type === 'statement_block') return current;
  }
  return current;
}

function loopBindingName(node: SyntaxNode): string | null {
  const left = node.childForFieldName('left');
  if (left?.type === 'identifier') return left.text;
  if (left?.type !== 'lexical_declaration' && left?.type !== 'variable_declaration') return null;
  const declarator = left.namedChildren.find((child) => child.type === 'variable_declarator');
  const name = declarator?.childForFieldName('name');
  return name?.type === 'identifier' ? name.text : null;
}

function entryMemberField(node: SyntaxNode, entryName: string): string | null {
  if (node.type === 'parenthesized_expression') {
    const nested = node.namedChildren[0];
    return nested === undefined ? null : entryMemberField(nested, entryName);
  }
  if (node.type !== 'member_expression') return null;
  const object = node.childForFieldName('object');
  const property = node.childForFieldName('property');
  return object?.type === 'identifier' &&
    object.text === entryName &&
    property?.type === 'property_identifier'
    ? property.text
    : null;
}

const NESTED_EXECUTABLES = new Set([
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
  'arrow_function',
  'method_definition',
  'class_declaration',
  'class',
]);

function referencesEntry(node: SyntaxNode, entryName: string): boolean {
  if (node.type === 'identifier' && node.text === entryName) return true;
  return node.namedChildren.some((child) => referencesEntry(child, entryName));
}

const REQUEST_ROOTS = new Set(['req', 'request', 'event', 'ctx', 'context', 'url']);
const REQUEST_PATH_FIELDS = new Set(['path', 'pathname', 'url', 'rawpath']);
const REQUEST_METHOD_FIELDS = new Set(['method', 'httpmethod', 'verb']);

function isEnclosingParameter(node: SyntaxNode, name: string): boolean {
  let current: SyntaxNode | null = node.parent;
  while (current !== null) {
    if (NESTED_EXECUTABLES.has(current.type)) {
      const names = new Set<string>();
      collectPatternNames(current.childForFieldName('parameters'), (value) => names.add(value));
      collectPatternNames(current.childForFieldName('parameter'), (value) => names.add(value));
      return names.has(name);
    }
    current = current.parent;
  }
  return false;
}

function isRequestField(
  node: SyntaxNode,
  field: 'path' | 'method',
  bindingCounts: ReadonlyMap<string, number>,
): boolean {
  if (node.type === 'parenthesized_expression') {
    const nested = node.namedChildren[0];
    return nested !== undefined && isRequestField(nested, field, bindingCounts);
  }
  const accepted = field === 'path' ? REQUEST_PATH_FIELDS : REQUEST_METHOD_FIELDS;
  if (node.type !== 'member_expression') return false;
  const object = node.childForFieldName('object');
  const property = node.childForFieldName('property');
  const root = object?.type === 'identifier' ? object.text : null;
  const bindingCount = root === null ? 0 : (bindingCounts.get(root) ?? 0);
  return (
    property?.type === 'property_identifier' &&
    accepted.has(property.text.toLowerCase()) &&
    root !== null &&
    REQUEST_ROOTS.has(root.toLowerCase()) &&
    (bindingCount === 0 || (bindingCount === 1 && isEnclosingParameter(node, root)))
  );
}

interface ComparisonEvidence {
  valid: boolean;
  fields: Set<string>;
}

function comparisonFields(
  condition: SyntaxNode,
  entryName: string,
  bindingCounts: ReadonlyMap<string, number>,
): ComparisonEvidence {
  const text = condition.text.trim();
  if (text === 'false' || text === '0' || text === 'null' || text === 'undefined') {
    return { valid: false, fields: new Set() };
  }
  if (condition.type === 'parenthesized_expression') {
    const nested = condition.namedChildren[0];
    return nested === undefined
      ? { valid: true, fields: new Set() }
      : comparisonFields(nested, entryName, bindingCounts);
  }
  if (condition.type === 'unary_expression') return { valid: false, fields: new Set() };
  if (condition.type !== 'binary_expression') return { valid: false, fields: new Set() };

  const operator = condition.children.find((child) => !child.isNamed)?.type;
  const left = condition.childForFieldName('left');
  const right = condition.childForFieldName('right');
  if (left === null || right === null) return { valid: false, fields: new Set() };

  if (operator === '||') return { valid: false, fields: new Set() };
  if (operator === '&&') {
    const leftEvidence = comparisonFields(left, entryName, bindingCounts);
    const rightEvidence = comparisonFields(right, entryName, bindingCounts);
    if (!leftEvidence.valid || !rightEvidence.valid) return { valid: false, fields: new Set() };
    return {
      valid: true,
      fields: new Set([...leftEvidence.fields, ...rightEvidence.fields]),
    };
  }
  if (operator !== '===' && operator !== '==') return { valid: false, fields: new Set() };

  const leftField = entryMemberField(left, entryName);
  const rightField = entryMemberField(right, entryName);
  if ((leftField === null) === (rightField === null)) return { valid: false, fields: new Set() };
  if (
    (leftField !== null && referencesEntry(right, entryName)) ||
    (rightField !== null && referencesEntry(left, entryName))
  ) {
    return { valid: false, fields: new Set() };
  }
  const field = leftField ?? rightField;
  const requestOperand = leftField !== null ? right : left;
  const matchesRequest =
    (field === 'path' || field === 'method') &&
    isRequestField(requestOperand, field, bindingCounts);
  return {
    valid: matchesRequest,
    fields: matchesRequest ? new Set([field]) : new Set(),
  };
}

function directlyCallsHandler(node: SyntaxNode, entryName: string): boolean {
  let found = false;
  const visit = (child: SyntaxNode): void => {
    if (found || (child !== node && NESTED_EXECUTABLES.has(child.type))) return;
    if (child.type === 'statement_block') {
      for (const statement of child.namedChildren) {
        visit(statement);
        if (found || definitelyTerminates(statement)) {
          break;
        }
      }
      return;
    }
    if (child.type === 'call_expression') {
      const fn = child.childForFieldName('function');
      if (fn !== null && entryMemberField(fn, entryName) === 'handler') {
        let current: SyntaxNode = child;
        let parent = current.parent;
        while (parent !== null && current.id !== node.id) {
          if (
            parent.type !== 'await_expression' &&
            parent.type !== 'parenthesized_expression' &&
            parent.type !== 'expression_statement' &&
            parent.type !== 'return_statement' &&
            parent.type !== 'statement_block'
          ) {
            return;
          }
          current = parent;
          parent = current.parent;
        }
        found = current.id === node.id;
        return;
      }
    }
    for (const nested of child.namedChildren) visit(nested);
  };
  visit(node);
  return found;
}

function isWriteTarget(node: SyntaxNode): boolean {
  let current: SyntaxNode = node;
  let parent = current.parent;
  while (parent !== null) {
    if (
      parent.type === 'assignment_expression' ||
      parent.type === 'augmented_assignment_expression'
    ) {
      const left = parent.childForFieldName('left');
      return left !== null && left.startIndex <= node.startIndex && left.endIndex >= node.endIndex;
    }
    if (parent.type === 'update_expression') return true;
    if (parent.type === 'unary_expression' && parent.text.trimStart().startsWith('delete ')) {
      return true;
    }
    if (
      parent.type === 'expression_statement' ||
      parent.type === 'variable_declarator' ||
      parent.type === 'call_expression'
    ) {
      return false;
    }
    current = parent;
    parent = current.parent;
  }
  return false;
}

function hasOnlyIngressReferences(scope: SyntaxNode): boolean {
  let valid = true;
  const visit = (node: SyntaxNode): void => {
    if (!valid) return;
    if (node.type === 'identifier' && REQUEST_ROOTS.has(node.text.toLowerCase())) {
      const member = node.parent;
      const property = member?.childForFieldName('property');
      if (
        member?.type !== 'member_expression' ||
        member.childForFieldName('object')?.id !== node.id ||
        property?.type !== 'property_identifier' ||
        (!REQUEST_PATH_FIELDS.has(property.text.toLowerCase()) &&
          !REQUEST_METHOD_FIELDS.has(property.text.toLowerCase())) ||
        isWriteTarget(member)
      ) {
        valid = false;
        return;
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(scope);
  return valid;
}

function hasOnlyDispatchEntryReferences(node: SyntaxNode, entryName: string): boolean {
  let valid = true;
  const visit = (child: SyntaxNode): void => {
    if (!valid) return;
    if (child.type === 'identifier' && child.text === entryName) {
      const member = child.parent;
      if (
        member?.type !== 'member_expression' ||
        member.childForFieldName('object')?.id !== child.id
      ) {
        valid = false;
        return;
      }
      const property = member.childForFieldName('property');
      if (property?.type !== 'property_identifier' || isWriteTarget(member)) {
        valid = false;
        return;
      }
      if (property.text === 'handler') {
        const call = member.parent;
        if (
          call?.type !== 'call_expression' ||
          call.childForFieldName('function')?.id !== member.id
        ) {
          valid = false;
          return;
        }
      } else if (property.text !== 'path' && property.text !== 'method') {
        valid = false;
        return;
      }
    }
    for (const nested of child.namedChildren) visit(nested);
  };
  visit(node);
  return valid;
}

function hasProviderDispatch(
  body: SyntaxNode,
  entryName: string,
  bindingCounts: ReadonlyMap<string, number>,
): boolean {
  if (!hasOnlyDispatchEntryReferences(body, entryName)) return false;
  let found = false;
  const visit = (node: SyntaxNode): void => {
    if (found || (node !== body && NESTED_EXECUTABLES.has(node.type))) return;
    if (node.type === 'statement_block') {
      for (const statement of node.namedChildren) {
        visit(statement);
        if (found || definitelyTerminates(statement)) {
          break;
        }
      }
      return;
    }
    if (node.type === 'if_statement') {
      const condition = node.childForFieldName('condition');
      const consequence = node.childForFieldName('consequence');
      if (condition !== null && isStaticallyFalse(condition)) {
        const alternative = node.childForFieldName('alternative');
        if (alternative !== null) visit(alternative);
        return;
      }
      if (condition !== null && consequence !== null) {
        const evidence = comparisonFields(condition, entryName, bindingCounts);
        if (
          evidence.valid &&
          evidence.fields.has('path') &&
          evidence.fields.has('method') &&
          directlyCallsHandler(consequence, entryName)
        ) {
          found = true;
          return;
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(body);
  return found;
}

function isStaticallyFalse(node: SyntaxNode): boolean {
  if (node.type === 'parenthesized_expression') {
    const nested = node.namedChildren[0];
    return nested !== undefined && isStaticallyFalse(nested);
  }
  const text = node.text.trim();
  return text === 'false' || text === '0' || text === 'null' || text === 'undefined';
}

function isStaticallyTrue(node: SyntaxNode): boolean {
  if (node.type === 'parenthesized_expression') {
    const nested = node.namedChildren[0];
    return nested !== undefined && isStaticallyTrue(nested);
  }
  return node.text.trim() === 'true';
}

function definitelyTerminates(node: SyntaxNode): boolean {
  if (
    node.type === 'return_statement' ||
    node.type === 'throw_statement' ||
    node.type === 'break_statement' ||
    node.type === 'continue_statement'
  ) {
    return true;
  }
  if (node.type === 'statement_block') {
    return node.namedChildren.some((statement) => definitelyTerminates(statement));
  }
  if (node.type !== 'if_statement') return false;
  const condition = node.childForFieldName('condition');
  const consequence = node.childForFieldName('consequence');
  const alternative = node.childForFieldName('alternative');
  if (condition === null) return false;
  if (isStaticallyTrue(condition)) {
    return consequence !== null && definitelyTerminates(consequence);
  }
  if (isStaticallyFalse(condition)) {
    return alternative !== null && definitelyTerminates(alternative);
  }
  return (
    consequence !== null &&
    alternative !== null &&
    definitelyTerminates(consequence) &&
    definitelyTerminates(alternative)
  );
}

function hasDispatchLoop(
  scope: SyntaxNode,
  tableName: string,
  bindingCounts: ReadonlyMap<string, number>,
): boolean {
  let found = false;
  const visit = (node: SyntaxNode): void => {
    if (found) return;
    if (node !== scope && NESTED_EXECUTABLES.has(node.type)) return;
    if (node.type === 'for_in_statement') {
      const right = node.childForFieldName('right');
      const isForOf = node.children.some((child) => child.type === 'of');
      const hasConstBinding = node.children.some((child) => child.type === 'const');
      if (isForOf && hasConstBinding && right?.type === 'identifier' && right.text === tableName) {
        const entryName = loopBindingName(node);
        const body = node.childForFieldName('body');
        if (
          entryName !== null &&
          bindingCounts.get(entryName) === 1 &&
          body !== null &&
          hasProviderDispatch(body, entryName, bindingCounts)
        ) {
          found = true;
          return;
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(scope);
  return found;
}

function collectPatternNames(node: SyntaxNode | null, add: (name: string) => void): void {
  if (node === null) return;
  if (node.type === 'identifier') {
    add(node.text);
    return;
  }
  for (const child of node.namedChildren) collectPatternNames(child, add);
}

function collectBindingCounts(root: SyntaxNode): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const add = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'import_statement') {
      const clause = node.namedChildren.find((child) => child.type === 'import_clause');
      collectPatternNames(clause ?? null, add);
      return;
    }
    if (node.type === 'variable_declarator') {
      collectPatternNames(node.childForFieldName('name'), add);
    } else if (node.type === 'for_in_statement') {
      const left = node.childForFieldName('left');
      if (left?.type === 'identifier') add(left.text);
    } else if (
      node.type === 'function_declaration' ||
      node.type === 'generator_function_declaration' ||
      node.type === 'class_declaration'
    ) {
      collectPatternNames(node.childForFieldName('name'), add);
    }
    if (
      node.type === 'function_declaration' ||
      node.type === 'function_expression' ||
      node.type === 'generator_function_declaration' ||
      node.type === 'generator_function' ||
      node.type === 'arrow_function' ||
      node.type === 'method_definition'
    ) {
      collectPatternNames(node.childForFieldName('parameters'), add);
      collectPatternNames(node.childForFieldName('parameter'), add);
    } else if (node.type === 'catch_clause') {
      collectPatternNames(node.childForFieldName('parameter'), add);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return counts;
}

function isConstDeclarator(node: SyntaxNode): boolean {
  const declaration = node.parent;
  return (
    declaration?.type === 'lexical_declaration' &&
    declaration.children.some((child) => child.type === 'const')
  );
}

function hasOnlyDispatchReferences(
  scope: SyntaxNode,
  declarator: SyntaxNode,
  tableName: string,
): boolean {
  const declarationName = declarator.childForFieldName('name');
  let valid = true;
  const visit = (node: SyntaxNode): void => {
    if (!valid) return;
    if (node.type === 'identifier' && node.text === tableName) {
      if (declarationName?.id === node.id) return;
      const parent = node.parent;
      const allowedForOf =
        parent?.type === 'for_in_statement' &&
        parent.childForFieldName('right')?.id === node.id &&
        parent.children.some((child) => child.type === 'of');
      const lengthMember =
        parent?.type === 'member_expression' &&
        parent.childForFieldName('object')?.id === node.id &&
        parent.childForFieldName('property')?.text === 'length'
          ? parent
          : null;
      const allowedLengthRead = lengthMember !== null && !isWriteTarget(lengthMember);
      if (!allowedForOf && !allowedLengthRead) {
        valid = false;
        return;
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(scope);
  return valid;
}

type HandlerReferenceIndex = ReadonlyMap<string, readonly SyntaxNode[]>;

function collectHandlerReferences(root: SyntaxNode): HandlerReferenceIndex {
  const references = new Map<string, SyntaxNode[]>();
  const visit = (node: SyntaxNode): void => {
    if (
      node.type === 'identifier' ||
      node.type === 'shorthand_property_identifier' ||
      node.type === 'shorthand_property_identifier_pattern'
    ) {
      const matches = references.get(node.text);
      if (matches === undefined) references.set(node.text, [node]);
      else matches.push(node);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return references;
}

function containsNode(container: SyntaxNode | null, node: SyntaxNode): boolean {
  return (
    container !== null &&
    container.startIndex <= node.startIndex &&
    container.endIndex >= node.endIndex
  );
}

function isUnsafeHandlerReference(
  reference: SyntaxNode,
  handlerRoot: string,
  routeEntry: SyntaxNode,
): boolean {
  let current: SyntaxNode = reference;
  let parent = current.parent;
  while (parent !== null) {
    if (parent.type === 'variable_declarator') {
      const name = parent.childForFieldName('name');
      const value = parent.childForFieldName('value');
      if (
        name?.type === 'identifier' &&
        name.text !== handlerRoot &&
        containsNode(value, reference) &&
        !isRouteHandlerDesignatorReference(reference, routeEntry)
      ) {
        return true;
      }
    }

    // The remaining checks historically matched ordinary identifiers only.
    if (reference.type === 'identifier') {
      if (
        parent.type === 'assignment_expression' ||
        parent.type === 'augmented_assignment_expression' ||
        parent.type === 'update_expression' ||
        (parent.type === 'unary_expression' && parent.text.trimStart().startsWith('delete ')) ||
        parent.type === 'return_statement' ||
        parent.type === 'yield_expression' ||
        parent.type === 'throw_statement'
      ) {
        return true;
      }
      if (parent.type === 'call_expression') {
        const args = parent.childForFieldName('arguments');
        const fn = parent.childForFieldName('function');
        const owner = fn?.childForFieldName('object');
        const callsOwnerMember =
          (fn?.type === 'member_expression' || fn?.type === 'subscript_expression') &&
          identifierName(owner) === handlerRoot &&
          containsNode(owner ?? null, reference);
        if (containsNode(args, reference) || callsOwnerMember) return true;
      }
    }

    current = parent;
    parent = current.parent;
  }
  return false;
}

function hasStableHandlerBinding(
  references: HandlerReferenceIndex,
  handlerRoot: string,
  routeEntry: SyntaxNode,
): boolean {
  return !(references.get(handlerRoot) ?? []).some((reference) =>
    isUnsafeHandlerReference(reference, handlerRoot, routeEntry),
  );
}

function identifierName(node: SyntaxNode | null | undefined): string | null {
  if (node?.type === 'identifier') return node.text;
  if (node?.type === 'parenthesized_expression') {
    return identifierName(node.namedChildren[0]);
  }
  return null;
}

function isRouteHandlerDesignatorReference(node: SyntaxNode, routeEntry: SyntaxNode): boolean {
  let designator = node;
  if (
    node.parent?.type === 'member_expression' &&
    node.parent.childForFieldName('object')?.id === node.id
  ) {
    designator = node.parent;
  }
  const pair = designator.parent;
  return (
    pair?.type === 'pair' &&
    pair.parent?.id === routeEntry.id &&
    pair.childForFieldName('value')?.id === designator.id &&
    propertyName(pair.childForFieldName('key')) === 'handler'
  );
}

/** Return static route facts shared by ingestion and group contract extraction. */
export function scanDataRouteTables(tree: Parser.Tree): DataRouteTableRoute[] {
  const source = tree.rootNode.text;
  if (!ROUTE_TOKEN_HINTS.every((token) => source.includes(token))) return [];

  const routes: DataRouteTableRoute[] = [];
  const blockedIdentities = new Set<string>();
  let hasUnknownTableEntries = false;
  const bindingCounts = collectBindingCounts(tree.rootNode);
  const handlerReferences = collectHandlerReferences(tree.rootNode);
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name');
      const value = node.childForFieldName('value');
      if (
        name?.type === 'identifier' &&
        ROUTE_BINDING_HINT.test(name.text) &&
        bindingCounts.get(name.text) === 1 &&
        isConstDeclarator(node) &&
        value?.type === 'array' &&
        hasOnlyDispatchReferences(lexicalContainer(node), node, name.text) &&
        hasOnlyIngressReferences(lexicalContainer(node)) &&
        hasDispatchLoop(lexicalContainer(node), name.text, bindingCounts)
      ) {
        const parsedRoutes: DataRouteTableRoute[] = [];
        let blocksFollowingCandidates = false;
        for (const entry of value.namedChildren) {
          if (entry.type === 'comment') continue;
          if (entry.type !== 'object') {
            hasUnknownTableEntries = true;
            continue;
          }
          const route = routeFromObject(entry);
          if (route === null) {
            const identity = staticRouteIdentity(entry);
            if (identity !== null) blockedIdentities.add(identity);
            if (identity === null) {
              blocksFollowingCandidates = true;
            }
            continue;
          }
          const identity = `${route.method}\0${route.path}`;
          if (blocksFollowingCandidates) {
            blockedIdentities.add(identity);
            continue;
          }
          const handlerRoot = route.handlerDesignator.split('.')[0];
          if (
            handlerRoot === undefined ||
            (bindingCounts.get(handlerRoot) ?? 0) > 1 ||
            !hasStableHandlerBinding(handlerReferences, handlerRoot, entry)
          ) {
            blockedIdentities.add(identity);
            continue;
          }
          parsedRoutes.push(route);
        }
        routes.push(...parsedRoutes);
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  if (hasUnknownTableEntries) return [];
  return routes.filter((route) => !blockedIdentities.has(`${route.method}\0${route.path}`));
}

export function extractDataRouteTableRoutes(
  tree: Parser.Tree,
  filePath: string,
  lineOffset = 0,
): ExtractedDecoratorRoute[] {
  return scanDataRouteTables(tree).map((route) => ({
    filePath,
    routePath: route.path,
    httpMethod: route.method,
    decoratorName: 'DataRouteTable',
    lineNumber: route.line + lineOffset,
    // This source preserves a static dotted designator in the existing field.
    // Its resolver recognizes the source tag and proves the receiver owner;
    // ordinary decorator routes continue to carry a simple handler name.
    handlerName: route.handlerDesignator,
    source: DATA_ROUTE_TABLE_SOURCE,
  }));
}
