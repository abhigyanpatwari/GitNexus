import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { lookupNameClaim } from '../../scope-resolution/scope/walkers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { decodeStringLiteral } from '../../utils/ecmascript-literals.js';
import {
  canonicalTypeScriptName,
  literalMethodName,
  numericLiteralValue,
  signedNumericLiteral,
} from './identifiers.js';
import { declarationScope } from './module-kind.js';

type Constant = string | number;
export type EnumValues = Record<string, [string, Constant][]>;
type EnumArgument = { owner: string; value: Constant };
const enumKey = (def: SymbolDefinition) => JSON.stringify([def.filePath, def.qualifiedName]);
const valuesByTree = new WeakMap<
  ScopeResolutionIndexes['scopeTree'],
  Map<string, Map<string, Constant>>
>();

/** Computed initializers interrupt auto-increment until the next known numeric value. */
export function enumConstants(declaration: SyntaxNode): [string, Constant][] {
  const values: [string, Constant][] = [];
  let next: number | undefined = 0;
  for (const member of declaration.childForFieldName('body')?.namedChildren ?? []) {
    if (member.type === 'comment') continue;
    const key = member.childForFieldName('name') ?? member;
    const name =
      key.type === 'property_identifier'
        ? canonicalTypeScriptName(key.text)
        : literalMethodName(key);
    const init = member.childForFieldName('value');
    let value: Constant | undefined = next;
    if (init?.type === 'string') value = decodeStringLiteral(init.text) ?? undefined;
    else if (init) {
      const spelling = init.type === 'number' ? init.text : signedNumericLiteral(init);
      const number = spelling === undefined ? undefined : numericLiteralValue(spelling);
      value = typeof number === 'number' && Number.isFinite(number) ? number : undefined;
    }
    if (name !== undefined && value !== undefined) values.push([name, value]);
    next = typeof value === 'number' ? value + 1 : undefined;
  }
  return values;
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
