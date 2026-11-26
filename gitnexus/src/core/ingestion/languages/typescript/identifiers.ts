import { decodeIdentifierEscapes, decodeStringLiteral } from '../../utils/ecmascript-literals.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/** Decode ECMAScript identifier escapes without changing written graph identities. */
export const canonicalTypeScriptName = (name: string): string => decodeIdentifierEscapes(name);

export { canonicalModuleExportName } from '../../utils/ecmascript-literals.js';

export function numericLiteralValue(spelling: string): number | bigint | undefined {
  if (!/^[+-]?(?:\d|\.\d)/u.test(spelling)) return undefined;
  const sign = spelling[0];
  const digits = (sign === '-' || sign === '+' ? spelling.slice(1) : spelling).replaceAll('_', '');
  if (digits.endsWith('n')) {
    if (sign === '+') return undefined;
    try {
      const value = BigInt(digits.slice(0, -1));
      return sign === '-' ? -value : value;
    } catch {
      return undefined;
    }
  }
  const value = Number(digits);
  if (!Number.isNaN(value)) return sign === '-' ? -value : value;
}

/** A leading sign is its own syntax node and can be separated from the operand by trivia. */
export function signedNumericLiteral(node: SyntaxNode): string | undefined {
  if (node.type !== 'unary_expression') return undefined;
  const operator = node.childForFieldName('operator')?.text;
  const operand = node.childForFieldName('argument');
  if ((operator === '-' || operator === '+') && operand?.type === 'number') {
    const spelling = operator + operand.text;
    if (numericLiteralValue(spelling) !== undefined) return spelling;
  }
}

/** A constant ECMAScript property key, shared by declarations and bracket calls. */
export function literalMethodName(node: SyntaxNode | null): string | undefined {
  if (node?.type === 'computed_property_name') {
    node = node.namedChildren.find((child) => child.type !== 'comment') ?? null;
  }
  if (node?.type === 'string') return decodeStringLiteral(node.text) ?? undefined;
  if (!node) return undefined;
  const spelling = node.type === 'number' ? node.text : signedNumericLiteral(node);
  const value = spelling === undefined ? undefined : numericLiteralValue(spelling);
  return value === undefined ? undefined : String(value);
}
