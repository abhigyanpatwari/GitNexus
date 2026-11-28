import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { lookupNameClaim } from '../../scope-resolution/scope/walkers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { canonicalTypeScriptName, literalMethodName, numericLiteralValue } from './identifiers.js';
import { declarationScope } from './module-kind.js';

type Constant = string | number;
export type EnumValues = Record<string, [string, Constant][]>;
type EnumArgument = { owner: string; value: Constant };
const enumKey = (def: SymbolDefinition) => JSON.stringify([def.filePath, def.qualifiedName]);
const valuesByTree = new WeakMap<
  ScopeResolutionIndexes['scopeTree'],
  Map<string, Map<string, Constant>>
>();

// Successive enum members can double a prior string at every declaration.
const maxFoldedStringLength = 64 * 1024;

function binaryConstant(
  op: string | undefined,
  left: Constant,
  right: Constant,
): Constant | undefined {
  if (op === '+' && (typeof left === 'string' || typeof right === 'string')) {
    const first = String(left);
    const second = String(right);
    return first.length + second.length <= maxFoldedStringLength ? first + second : undefined;
  }
  if (typeof left !== 'number' || typeof right !== 'number') return undefined;
  switch (op) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '**':
      return left ** right;
    case '/':
      return left / right;
    case '%':
      return left % right;
    case '<<':
      return left << right;
    case '>>':
      return left >> right;
    case '>>>':
      return left >>> right;
    case '|':
      return left | right;
    case '&':
      return left & right;
    case '^':
      return left ^ right;
    default:
      return undefined;
  }
}

function referencedEnumMember(node: SyntaxNode, owner: string): string | undefined {
  const receiver = node.childForFieldName('object');
  if (receiver?.type !== 'identifier' || canonicalTypeScriptName(receiver.text) !== owner)
    return undefined;
  if (node.type === 'subscript_expression')
    return literalMethodName(node.childForFieldName('index'));
  const property = node.childForFieldName('property');
  return property?.type === 'property_identifier'
    ? canonicalTypeScriptName(property.text)
    : undefined;
}

function unaryConstant(op: string | undefined, operand: Constant | undefined): number | undefined {
  if (typeof operand !== 'number') return undefined;
  switch (op) {
    case '+':
      return operand;
    case '-':
      return -operand;
    case '~':
      return ~operand;
    default:
      return undefined;
  }
}

/** Only fold literal expressions and references to previously known members of this enum. */
function initializerValue(
  node: SyntaxNode | null,
  owner: string,
  members: ReadonlyMap<string, Constant>,
  depth = 0,
): Constant | undefined {
  if (!node || depth > 64) return undefined;
  switch (node.type) {
    case 'number': {
      const value = numericLiteralValue(node.text);
      return typeof value === 'number' ? value : undefined;
    }
    case 'string':
    case 'template_string':
      return literalMethodName(node);
    case 'identifier':
      return members.get(canonicalTypeScriptName(node.text));
    case 'member_expression':
    case 'subscript_expression': {
      const name = referencedEnumMember(node, owner);
      return name === undefined ? undefined : members.get(name);
    }
    case 'parenthesized_expression':
      return initializerValue(
        node.namedChildren.find((child) => child.type !== 'comment') ?? null,
        owner,
        members,
        depth + 1,
      );
    case 'unary_expression': {
      const operand = initializerValue(
        node.childForFieldName('argument'),
        owner,
        members,
        depth + 1,
      );
      return unaryConstant(node.childForFieldName('operator')?.type, operand);
    }
    case 'binary_expression': {
      const left = initializerValue(node.childForFieldName('left'), owner, members, depth + 1);
      if (left === undefined) return undefined;
      const right = initializerValue(node.childForFieldName('right'), owner, members, depth + 1);
      return right === undefined
        ? undefined
        : binaryConstant(node.childForFieldName('operator')?.type, left, right);
    }
    default:
      return undefined;
  }
}

/** Computed initializers interrupt auto-increment until the next known numeric value. */
export function enumConstants(declaration: SyntaxNode): [string, Constant][] {
  const values = new Map<string, Constant>();
  const owner = canonicalTypeScriptName(declaration.childForFieldName('name')?.text ?? '');
  let next: number | undefined = 0;
  for (const member of declaration.childForFieldName('body')?.namedChildren ?? []) {
    if (member.type === 'comment') continue;
    const key = member.childForFieldName('name') ?? member;
    const name =
      key.type === 'property_identifier'
        ? canonicalTypeScriptName(key.text)
        : literalMethodName(key);
    const init = member.childForFieldName('value');
    const value: Constant | undefined = init ? initializerValue(init, owner, values) : next;
    const numeric = typeof value === 'number' && Number.isFinite(value);
    if (name !== undefined && (typeof value === 'string' || numeric)) values.set(name, value);
    next = numeric ? value + 1 : undefined;
  }
  return [...values];
}

export function indexEnumArguments(file: ParsedFile, indexes: ScopeResolutionIndexes): void {
  const enums = declarationScope(file.captureSideChannel)?.enumValues;
  if (!enums) return;
  let values = valuesByTree.get(indexes.scopeTree);
  if (!values) {
    values = new Map();
    valuesByTree.set(indexes.scopeTree, values);
  }
  for (const def of file.localDefs) {
    const at = def.declarationRange;
    if (def.type !== 'Enum' || !at) continue;
    const members = enums[`${at.startLine}:${at.startCol}`];
    if (!members) continue;
    const key = enumKey(def);
    const existing = values.get(key);
    if (existing) {
      for (const [name, value] of members) existing.set(name, value);
    } else values.set(key, new Map(members));
  }
}

function enumAt(
  spelling: string,
  scope: ScopeId,
  indexes: ScopeResolutionIndexes,
  purpose: 'type' | 'value',
  position?: { startLine: number; startCol: number },
) {
  const claim = lookupNameClaim(scope, canonicalTypeScriptName(spelling), indexes, {
    purpose,
    position,
  });
  const first = claim.bindings[0]?.def;
  if (first?.type !== 'Enum') return;
  const key = enumKey(first);
  return claim.bindings.every(({ def }) => def.type === 'Enum' && enumKey(def) === key)
    ? key
    : undefined;
}

export function enumArgument(
  spelling: string,
  scope: ScopeId,
  indexes: ScopeResolutionIndexes,
  position: { startLine: number; startCol: number },
): EnumArgument | undefined {
  const parts = spelling.split('.');
  if (parts.length !== 2) return;
  const owner = enumAt(parts[0], scope, indexes, 'value', position);
  const value =
    owner &&
    valuesByTree.get(indexes.scopeTree)?.get(owner)?.get(canonicalTypeScriptName(parts[1]));
  if (value !== undefined && owner) return { owner, value };
}

export function acceptsEnum(
  annotation: string,
  argument: EnumArgument,
  signature: SymbolDefinition,
  scope: ScopeId,
  indexes: ScopeResolutionIndexes,
): boolean | undefined {
  if (annotation === 'unknown' || annotation === 'any') return true;
  const [head, member, ...tail] = annotation.split('.');
  if (tail.length) return;
  const owner = enumAt(head, scope, indexes, 'type', signature.declarationRange);
  if (!owner || owner !== argument.owner) return;
  if (!member) return true;
  const constant = valuesByTree
    .get(indexes.scopeTree)
    ?.get(owner)
    ?.get(canonicalTypeScriptName(member));
  return constant === undefined ? undefined : constant === argument.value;
}
