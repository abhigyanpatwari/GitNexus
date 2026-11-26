import { decodeIdentifierEscapes, decodeStringLiteral } from '../../utils/ecmascript-literals.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/** Decode ECMAScript identifier escapes without changing written graph identities. */
export const canonicalTypeScriptName = (name: string): string => decodeIdentifierEscapes(name);

export { canonicalModuleExportName } from '../../utils/ecmascript-literals.js';

/** A constant ECMAScript property key, shared by declarations and bracket calls. */
export function literalMethodName(node: SyntaxNode | null): string | undefined {
  if (node?.type === 'computed_property_name') {
    node = node.namedChildren.find((child) => child.type !== 'comment') ?? null;
  }
  if (node?.type === 'string') return decodeStringLiteral(node.text) ?? undefined;
  if (node?.type !== 'number') return undefined;
  const digits = node.text.replaceAll('_', '');
  if (digits.endsWith('n')) {
    try {
      return String(BigInt(digits.slice(0, -1)));
    } catch {
      return undefined;
    }
  }
  const value = Number(digits);
  return Number.isNaN(value) ? undefined : String(value);
}
