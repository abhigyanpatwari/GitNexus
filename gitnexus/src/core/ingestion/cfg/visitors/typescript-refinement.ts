import type { SyntaxNode } from '../../utils/ast-helpers.js';
import {
  MAX_VALUE_BYTES,
  MAX_VALUE_NODES,
  parseAnchoredAsciiPattern,
  type StringRestriction,
  type ValueExpression,
} from '../../taint/value-refinement.js';

export interface PredicateFact {
  readonly site?: number;
  readonly subject: number;
  readonly accepts: boolean;
  readonly restriction: StringRestriction;
  readonly establishesPrimitive?: boolean;
}

export interface RefinementFileContext {
  readonly validators: ReadonlyMap<string, StringRestriction>;
  readonly enabled: boolean;
}

const UNKNOWN_EXPRESSION: ValueExpression = Object.freeze({ kind: 'unknown' });
const UNCERTAIN_RUNTIME_ROOTS = new Set([
  'RegExp',
  'eval',
  'Function',
  'globalThis',
  'global',
  'window',
  'self',
]);

function regexRestriction(node: SyntaxNode): StringRestriction | undefined {
  if (node.type !== 'regex' || node.text.length > MAX_VALUE_BYTES) return;
  const pattern = node.childForFieldName('pattern');
  const flags =
    node.childForFieldName('flags')?.text ?? node.text.slice(node.text.lastIndexOf('/') + 1);
  return pattern ? parseAnchoredAsciiPattern(pattern.text, flags) : undefined;
}

/** One bounded file scan; every non-test reference invalidates a mutable RegExp object. */
export function createRefinementFileContext(root: SyntaxNode): RefinementFileContext {
  if (!/\.\s*test\b/.test(root.text)) return { validators: new Map(), enabled: false };
  const candidates = new Map<string, { declaration: number; restriction?: StringRestriction }>();
  const identifiers: SyntaxNode[] = [];
  const pending = [root];
  let visits = 0;
  let bytes = 0;
  let enabled = true;
  while (pending.length) {
    if (++visits > 100_000) return { validators: new Map(), enabled: false };
    const node = pending.pop()!;
    if (node.type.includes('identifier')) identifiers.push(node);
    if (node.type === 'regex') {
      const declaration = node.parent;
      const lexical = declaration?.parent;
      const indexedInitializer =
        declaration?.type === 'variable_declarator' &&
        declaration.childForFieldName('value')?.id === node.id &&
        declaration.childForFieldName('name')?.type === 'identifier' &&
        lexical?.type === 'lexical_declaration' &&
        lexical.parent?.type === 'program' &&
        lexical.firstChild?.text === 'const';
      const member = node.parent;
      const call = member?.parent;
      const directTest =
        member?.type === 'member_expression' &&
        member.childForFieldName('object')?.id === node.id &&
        member.childForFieldName('property')?.text === 'test' &&
        call?.type === 'call_expression' &&
        call.childForFieldName('function')?.id === member.id;
      if (!indexedInitializer && !directTest) enabled = false;
    }
    if (node.type === 'identifier') {
      const name = node.text;
      if (name.includes('\\') || UNCERTAIN_RUNTIME_ROOTS.has(name)) enabled = false;
    }
    if (
      node.type === 'variable_declarator' &&
      node.parent?.type === 'lexical_declaration' &&
      node.parent.parent?.type === 'program' &&
      node.parent.firstChild?.text === 'const'
    ) {
      const name = node.childForFieldName('name');
      const value = node.childForFieldName('value');
      const restriction = value && regexRestriction(value);
      if (name?.type === 'identifier' && value?.type === 'regex') {
        bytes += value!.text.length;
        if (candidates.size >= 256 || bytes > 8192)
          return { validators: new Map(), enabled: false };
        if (candidates.has(name.text)) enabled = false;
        candidates.set(name.text, { declaration: name.id, restriction });
      }
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) pending.push(child);
    }
  }
  for (const node of identifiers) {
    if (++visits > 100_000) return { validators: new Map(), enabled: false };
    const candidate = candidates.get(node.text);
    if (!candidate || node.id === candidate.declaration) continue;
    const member = node.parent;
    const call = member?.parent;
    if (
      node.type !== 'identifier' ||
      member?.type !== 'member_expression' ||
      member.childForFieldName('object')?.id !== node.id ||
      member.childForFieldName('property')?.text !== 'test' ||
      call?.type !== 'call_expression' ||
      call.childForFieldName('function')?.id !== member.id
    )
      enabled = false;
  }
  const validators = new Map<string, StringRestriction>();
  if (enabled)
    for (const [name, candidate] of candidates) {
      if (candidate.restriction) validators.set(name, candidate.restriction);
    }
  return { validators, enabled };
}

function unwrap(node: SyntaxNode): SyntaxNode {
  while (
    ['parenthesized_expression', 'as_expression', 'non_null_expression', 'type_assertion'].includes(
      node.type,
    )
  ) {
    const inner = node.childForFieldName('expression') ?? node.firstNamedChild;
    if (!inner || inner.id === node.id) break;
    node = inner;
  }
  return node;
}

/** Preserve only exact string/binding composition, with a fixed traversal budget. */
export function readValueExpression(
  node: SyntaxNode,
  resolve: (identifier: SyntaxNode) => number,
): ValueExpression {
  let remaining = MAX_VALUE_NODES;
  let bytes = 0;
  let exhausted = false;
  const visit = (raw: SyntaxNode): ValueExpression => {
    if (--remaining < 0) {
      exhausted = true;
      return UNKNOWN_EXPRESSION;
    }
    const value = unwrap(raw);
    if (value.type === 'identifier') return { kind: 'binding', binding: resolve(value) };
    if (value.type === 'string') {
      const text = value.text;
      bytes += text.length;
      if (bytes > MAX_VALUE_BYTES) {
        exhausted = true;
        return UNKNOWN_EXPRESSION;
      }
      return text.length <= MAX_VALUE_BYTES && !text.includes('\\')
        ? { kind: 'literal', value: text.slice(1, -1) }
        : UNKNOWN_EXPRESSION;
    }
    if (value.type === 'binary_expression' && value.childForFieldName('operator')?.text === '+') {
      const left = value.childForFieldName('left');
      const right = value.childForFieldName('right');
      return left && right
        ? { kind: 'concat', parts: [visit(left), visit(right)] }
        : UNKNOWN_EXPRESSION;
    }
    if (
      value.type === 'template_string' &&
      value.text.length <= MAX_VALUE_BYTES &&
      !value.text.includes('\\')
    ) {
      const parts: ValueExpression[] = [];
      for (const child of value.namedChildren) {
        if (child.type === 'string_fragment') {
          bytes += child.text.length;
          if (bytes > MAX_VALUE_BYTES) {
            exhausted = true;
            return UNKNOWN_EXPRESSION;
          }
          parts.push({ kind: 'literal', value: child.text });
        } else if (child.type === 'template_substitution' && child.firstNamedChild)
          parts.push(visit(child.firstNamedChild));
        else return UNKNOWN_EXPRESSION;
      }
      return { kind: 'concat', parts };
    }
    if (
      [
        'object',
        'new_expression',
        'array',
        'number',
        'true',
        'false',
        'null',
        'regex',
        'function_expression',
        'arrow_function',
      ].includes(value.type)
    )
      return { kind: 'non-string' };
    return UNKNOWN_EXPRESSION;
  };
  const result = visit(node);
  return exhausted ? UNKNOWN_EXPRESSION : result;
}

export function readPredicate(
  raw: SyntaxNode,
  resolve: (identifier: SyntaxNode) => number,
  context: RefinementFileContext | undefined,
  siteOf?: (call: SyntaxNode) => number | undefined,
): PredicateFact | undefined {
  let node = unwrap(raw);
  let accepts = true;
  let remaining = 8;
  while (node.type === 'unary_expression' && node.firstChild?.text === '!' && remaining-- > 0) {
    const argument = node.childForFieldName('argument');
    if (!argument) return;
    accepts = !accepts;
    node = unwrap(argument);
  }
  if (remaining <= 0) return;
  if (node.type === 'call_expression') {
    if (!context?.enabled) return;
    const callee = node.childForFieldName('function');
    const object = callee?.childForFieldName('object');
    const args = node.childForFieldName('arguments')?.namedChildren;
    if (
      callee?.type !== 'member_expression' ||
      callee.childForFieldName('property')?.text !== 'test' ||
      !object ||
      !args ||
      args.length !== 1 ||
      args[0].type !== 'identifier' ||
      node.text.includes('?.')
    )
      return;
    const restriction =
      object.type === 'regex'
        ? regexRestriction(object)
        : object.type === 'identifier'
          ? context?.validators.get(object.text)
          : undefined;
    if (restriction) {
      const site = siteOf?.(node);
      return {
        subject: resolve(args[0]),
        accepts,
        restriction,
        ...(site !== undefined ? { site } : {}),
      };
    }
  }
  if (node.type === 'binary_expression') {
    const operator = node.childForFieldName('operator')?.text;
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (!left || !right || (operator !== '===' && operator !== '!==')) return;
    const subject =
      left.type === 'identifier' ? left : right.type === 'identifier' ? right : undefined;
    const literal = subject?.id === left.id ? right : left;
    if (!subject || literal.type !== 'string') return;
    const expression = readValueExpression(literal, resolve);
    if (
      expression.kind !== 'literal' ||
      !expression.value ||
      expression.value.length > MAX_VALUE_BYTES
    )
      return;
    return {
      subject: resolve(subject),
      accepts: operator === '===' ? accepts : !accepts,
      restriction: {
        chars: [...new Set(expression.value)].sort().join(''),
        min: expression.value.length,
        max: expression.value.length,
      },
      establishesPrimitive: true,
    };
  }
}

/** Known ordinary options only; inherited shell settings and spread/getters are unknown. */
export function hasDefaultShellArguments(args: readonly SyntaxNode[]): boolean {
  if (args.length === 1) return true;
  if (args.length !== 2 || args[1].type !== 'object') return false;
  return args[1].namedChildren.every(
    (pair) =>
      pair.type === 'pair' &&
      pair.childForFieldName('key')?.text === 'encoding' &&
      pair.childForFieldName('value')?.type === 'string',
  );
}
