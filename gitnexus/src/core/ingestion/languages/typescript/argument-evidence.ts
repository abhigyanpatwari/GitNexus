import type { CallNullMode } from './global-declarations.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { decodeStringLiteral } from '../../utils/ecmascript-literals.js';
import {
  canonicalTypeScriptName,
  literalMethodName,
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

export { sourceRangeKey as callRangeKey } from '../../utils/ast-helpers.js';

/** Only record a fresh object when every key and value type is known. */
function objectEvidence(
  arg: SyntaxNode,
  typeOf: (node: SyntaxNode) => string,
): ArgumentEvidence | null {
  const fields: [string, string][] = [];
  for (const member of arg.namedChildren) {
    if (member.type === 'comment') continue;
    const key = member.childForFieldName('key');
    const value = member.childForFieldName('value');
    if (member.type !== 'pair' || !key || !value) return null;
    let name: string | null = null;
    if (key.type === 'property_identifier') name = canonicalTypeScriptName(key.text);
    else if (key.type === 'string') name = decodeStringLiteral(key.text);
    const type = typeOf(value);
    if (name === null || !type) return null;
    fields.push([name, type]);
  }
  return { fields };
}

function arrowEvidence(arg: SyntaxNode): ArgumentEvidence | null {
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

export function argumentEvidence(
  arg: SyntaxNode,
  typeOf: (node: SyntaxNode) => string,
): ArgumentEvidence | null {
  switch (arg.type) {
    case 'spread_element': {
      const value = arg.namedChildren.find((node) => node.type !== 'comment');
      return { spread: value?.type === 'identifier' ? canonicalTypeScriptName(value.text) : null };
    }
    case 'string':
    case 'number':
    case 'true':
    case 'false':
      return arg.text;
    case 'template_string': {
      const value = literalMethodName(arg);
      return value === undefined ? null : JSON.stringify(value);
    }
    case 'unary_expression':
      return signedNumericLiteral(arg) ?? null;
    case 'object':
      return objectEvidence(arg, typeOf);
    case 'arrow_function':
      return arrowEvidence(arg);
    default:
      return null;
  }
}

function literalValue(spelling: string): string | number | bigint | boolean | undefined {
  if (/^(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')$/u.test(spelling))
    return decodeStringLiteral(spelling) ?? undefined;
  if (spelling === 'true' || spelling === 'false') return spelling === 'true';
  return numericLiteralValue(spelling);
}

export function isLiteralParameter(type: string): boolean {
  const annotation = type.trim();
  return annotation === 'null' || literalValue(annotation) !== undefined;
}

function acceptsArrow(annotation: string, arity: number): boolean | undefined {
  const fn = /^\(([^()]*)\)\s*=>\s*void$/u.exec(annotation);
  if (!fn) return undefined;
  const parameters = fn[1].trim() ? fn[1].split(',') : [];
  if (
    !parameters.every((param) =>
      /^\s*[\w$]+\??\s*:\s*(?:number|string|boolean|unknown|any)\s*$/u.test(param),
    )
  )
    return undefined;
  // Only unannotated arrow parameters have arity-only evidence. A contextual
  // parameter receives the target's optional type, including undefined.
  return arity <= parameters.length;
}

function objectProperty(field: string) {
  const colon = field.indexOf(':');
  if (colon === -1) return undefined;
  const key = /^(?:readonly\s+)?([\w$]+)(\?)?$/u.exec(field.slice(0, colon).trim());
  if (!key) return undefined;
  const alternatives = field
    .slice(colon + 1)
    .split('|')
    .map((part) => part.trim());
  if (
    !alternatives.every((part) =>
      /^(?:number|string|boolean|unknown|any|undefined|null)$/u.test(part),
    )
  )
    return undefined;
  return { name: key[1], optional: !!key[2], alternatives };
}

function acceptsProperty(
  property: NonNullable<ReturnType<typeof objectProperty>>,
  raw: string | undefined,
  mode: CallNullMode,
  fieldUndefinedType?: () => string | undefined,
): boolean | undefined {
  if (raw === undefined) return property.optional;
  const { alternatives } = property;
  if (alternatives.includes('any') || alternatives.includes('unknown')) return true;
  const value = raw === 'undefined' && fieldUndefinedType ? fieldUndefinedType() : raw;
  if (value === undefined) return undefined;
  if (alternatives.includes(value)) return true;
  if (mode === 'loose' && (value === 'null' || value === 'undefined')) return true;
  return mode === 'strict' && property.optional && value === 'undefined';
}

function acceptsObject(
  annotation: string,
  fieldTypes: [string, string][],
  mode: CallNullMode,
  fieldUndefinedType?: () => string | undefined,
): ArgumentCompatibility {
  if (!annotation.startsWith('{') || !annotation.endsWith('}')) return undefined;
  const members = annotation.slice(1, -1).trim();
  // TypeScript tries subtype matches before assignable matches. A fresh literal
  // with excess fields still fits {} in the second pass.
  if (!members) return fieldTypes.length ? 'assignable' : true;
  const fields = new Map(fieldTypes);
  const accepted = new Set<string>();
  for (const field of members.split(/[;,]/u)) {
    if (!field.trim()) continue;
    const property = objectProperty(field);
    if (!property) return undefined;
    accepted.add(property.name);
    const compatible = acceptsProperty(
      property,
      fields.get(property.name),
      mode,
      fieldUndefinedType,
    );
    if (compatible !== true) return compatible;
  }
  return [...fields.keys()].every((key) => accepted.has(key));
}

/** Return undefined for an annotation outside the forms compared here. */
export function acceptsArgumentEvidence(
  annotation: string,
  type: string,
  evidence?: ArgumentEvidence | null,
  mode: CallNullMode = 'strict',
  fieldUndefinedType?: () => string | undefined,
): ArgumentCompatibility {
  const literal = literalValue(annotation);
  if (literal !== undefined) {
    if (typeof evidence === 'string') return literalValue(evidence) === literal;
    if (type === 'any' || type === '' || type === 'unknown') return undefined;
    return false;
  }
  if (typeof evidence !== 'object' || evidence === null || 'spread' in evidence) return undefined;
  if ('parameters' in evidence) return acceptsArrow(annotation, evidence.parameters);
  return acceptsObject(annotation, evidence.fields, mode, fieldUndefinedType);
}
