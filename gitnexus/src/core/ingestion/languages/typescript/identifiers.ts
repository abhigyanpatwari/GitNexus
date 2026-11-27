import { decodeIdentifierEscapes, decodeStringLiteral } from '../../utils/ecmascript-literals.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/** Decode ECMAScript identifier escapes without changing written graph identities. */
export const canonicalTypeScriptName = (name: string): string => decodeIdentifierEscapes(name);

export { canonicalModuleExportName } from '../../utils/ecmascript-literals.js';

/** Query candidates for literalMethodName, which checks grouping and substitutions. */
export const literalPropertyKeyQuery = `[(string) (number) (template_string) (parenthesized_expression)
  (unary_expression operator: ["+" "-"] argument: [(number) (parenthesized_expression)])]`;

const decimalDigits = String.raw`\d(?:_?\d)*`;
const decimalInteger = String.raw`(?:0|[1-9](?:_?\d)*)`;
const decimalMantissa = `(?:${decimalInteger}(?:\\.(?:${decimalDigits})?)?|\\.${decimalDigits})`;
const decimalLiteral = new RegExp(
  `^(?:${decimalInteger}n|${decimalMantissa}(?:[eE][+-]?${decimalDigits})?)$`,
  'u',
);
const radixLiteral =
  /^(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*)n?$/u;

export function numericLiteralValue(spelling: string): number | bigint | undefined {
  const sign = spelling[0];
  const unsigned = sign === '-' || sign === '+' ? spelling.slice(1) : spelling;
  if (!decimalLiteral.test(unsigned) && !radixLiteral.test(unsigned)) return undefined;
  const digits = unsigned.replaceAll('_', '');
  if (digits.endsWith('n')) {
    if (sign === '+') return undefined;
    const value = BigInt(digits.slice(0, -1));
    return sign === '-' ? -value : value;
  }
  const value = Number(digits);
  return sign === '-' ? -value : value;
}

function unwrapLiteral(node: SyntaxNode | null): SyntaxNode | null {
  while (node?.type === 'computed_property_name' || node?.type === 'parenthesized_expression') {
    node = node.namedChildren.find((child) => child.type !== 'comment') ?? null;
  }
  return node;
}

/** A leading sign is its own syntax node and can be separated from the operand by trivia. */
export function signedNumericLiteral(
  node: SyntaxNode,
  context: 'argument' | 'property-key' = 'argument',
): string | undefined {
  if (node.type !== 'unary_expression') return undefined;
  const operator = node.childForFieldName('operator')?.text;
  const argument = node.childForFieldName('argument');
  // TypeScript widens signed arguments with grouped operands. A property key uses its runtime value.
  const operand = context === 'property-key' ? unwrapLiteral(argument) : argument;
  if ((operator === '-' || operator === '+') && operand?.type === 'number') {
    const spelling = operator + operand.text;
    if (numericLiteralValue(spelling) !== undefined) return spelling;
  }
}

/** A constant ECMAScript property key, shared by declarations and bracket calls. */
export function literalMethodName(node: SyntaxNode | null): string | undefined {
  node = unwrapLiteral(node);
  if (!node) return undefined;
  if (
    node.type === 'template_string' &&
    node.namedChildren.some((child) => child.type === 'template_substitution')
  )
    return undefined;
  if (node.type === 'string' || node.type === 'template_string')
    return decodeStringLiteral(node.text) ?? undefined;
  const spelling = node.type === 'number' ? node.text : signedNumericLiteral(node, 'property-key');
  const value = spelling === undefined ? undefined : numericLiteralValue(spelling);
  return value === undefined ? undefined : String(value);
}
