/**
 * Tiny extractor for Move type expressions returned by move-flow facts.
 *
 * Input examples: `&CoinStore<Pool<T>>`, `vector<u8>`,
 * `aptos_framework::coin::CoinStore<T>`.
 *
 * Output is the ordered list of type-name tokens that could resolve to a graph
 * struct or enum. References and primitives are stripped; outer and inner
 * generic type names are both returned.
 */

const MOVE_PRIMITIVES = new Set([
  'bool',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'u256',
  'address',
  'signer',
  '&signer',
  'vector',
]);

export function extractTypeNames(typeExpr: string): string[] {
  if (!typeExpr) return [];
  const expr = typeExpr.trim().replace(/^&(mut\s+)?/, '');
  if (MOVE_PRIMITIVES.has(expr)) return [];

  const tokens: string[] = [];
  for (const raw of expr.split(/[<>,]/)) {
    const name = raw.trim().replace(/^&(mut\s+)?/, '');
    if (!name || MOVE_PRIMITIVES.has(name)) continue;
    tokens.push(name);
  }
  return tokens;
}
