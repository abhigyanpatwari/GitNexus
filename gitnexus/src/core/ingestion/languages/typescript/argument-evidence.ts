import type { Range } from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { decodeStringLiteral } from '../../utils/ecmascript-literals.js';
import {
  canonicalTypeScriptName,
  numericLiteralValue,
  signedNumericLiteral,
} from './identifiers.js';

export type ArgumentEvidence =
  | string
  | { fields: [string, string][] }
  | { parameters: number }
  | { spread: string | null };
export type ArgumentCompatibility = boolean | 'assignable' | undefined;
export type CallEvidence = Record<string, (ArgumentEvidence | null)[]>;

export function callRangeKey(range: Range): string {
  return `${range.startLine}:${range.startCol}-${range.endLine}:${range.endCol}`;
}

/** Only record a fresh object when every key and value type is known. */
export function argumentEvidence(
  arg: SyntaxNode,
  typeOf: (node: SyntaxNode) => string,
): ArgumentEvidence | null {
  if (arg.type === 'spread_element') {
    const value = arg.namedChildren.find((node) => node.type !== 'comment');
    return { spread: value?.type === 'identifier' ? canonicalTypeScriptName(value.text) : null };
  }
  if (['string', 'number', 'true', 'false'].includes(arg.type)) return arg.text;
  if (arg.type === 'unary_expression') return signedNumericLiteral(arg) ?? null;
  if (arg.type === 'object') {
    const fields: [string, string][] = [];
    for (const member of arg.namedChildren) {
      if (member.type === 'comment') continue;
      const key = member.childForFieldName('key');
      const value = member.childForFieldName('value');
      if (member.type !== 'pair' || !key || !value) return null;
      const name =
        key.type === 'property_identifier'
          ? canonicalTypeScriptName(key.text)
          : key.type === 'string'
            ? decodeStringLiteral(key.text)
            : null;
      const type = typeOf(value);
      if (name === null || !type) return null;
      fields.push([name, type]);
    }
    return { fields };
  }
  if (arg.type !== 'arrow_function') return null;
  const single = arg.childForFieldName('parameter');
  if (single?.type === 'identifier') return { parameters: 1 };
  const parameters = arg
    .childForFieldName('parameters')
    ?.namedChildren.filter((node) => node.type !== 'comment');
  if (
    !parameters?.every(
      (node) =>
        node.type === 'required_parameter' &&
        !node.childForFieldName('type') &&
        !node.childForFieldName('value') &&
        node.childForFieldName('pattern')?.type === 'identifier',
    )
  )
    return null;
  return { parameters: parameters.length };
}

function literalValue(spelling: string): string | number | bigint | boolean | undefined {
  if (/^(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')$/u.test(spelling))
    return decodeStringLiteral(spelling) ?? undefined;
  if (spelling === 'true' || spelling === 'false') return spelling === 'true';
  return numericLiteralValue(spelling);
}

export function isLiteralParameter(type: string): boolean {
  return literalValue(type.trim()) !== undefined;
}

/** Return undefined for an annotation outside the forms compared here. */
export function acceptsArgumentEvidence(
  annotation: string,
  type: string,
  evidence?: ArgumentEvidence | null,
): ArgumentCompatibility {
  const literal = literalValue(annotation);
  if (literal !== undefined) {
    if (typeof evidence === 'string') return literalValue(evidence) === literal;
    if (type === 'any' || type === '' || type === 'unknown') return undefined;
    return false;
  }
  if (typeof evidence !== 'object' || evidence === null || 'spread' in evidence) return undefined;
  if ('parameters' in evidence) {
    const fn = /^\(([^()]*)\)\s*=>\s*void$/u.exec(annotation);
    if (!fn) return undefined;
    const parameters = fn[1].trim() ? fn[1].split(',') : [];
    if (
      !parameters.every((param) =>
        /^\s*[\w$]+\??\s*:\s*(?:number|string|boolean|unknown|any)\s*$/u.test(param),
      )
    )
      return undefined;
    return evidence.parameters <= parameters.length;
  }
  if (!annotation.startsWith('{') || !annotation.endsWith('}')) return undefined;
  // TypeScript tries subtype matches before assignable matches. A fresh literal
  // with excess fields still fits {} in the second pass.
  if (annotation.slice(1, -1).trim() === '') return evidence.fields.length ? 'assignable' : true;
  const fields = new Map(evidence.fields);
  const accepted = new Set<string>();
  for (const field of annotation.slice(1, -1).split(/[;,]/u)) {
    if (!field.trim()) continue;
    const prop =
      /^\s*(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*(number|string|boolean|unknown|any)\s*$/u.exec(
        field,
      );
    if (!prop) return undefined;
    accepted.add(prop[1]);
    const value = fields.get(prop[1]);
    if (
      value === undefined
        ? !prop[2]
        : prop[3] !== value && prop[3] !== 'any' && prop[3] !== 'unknown'
    )
      return false;
  }
  return [...fields.keys()].every((key) => accepted.has(key));
}
