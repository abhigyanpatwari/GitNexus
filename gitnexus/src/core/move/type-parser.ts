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
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'i256',
  'address',
  'signer',
  '&signer',
  'vector',
]);

export function extractTypeNames(typeExpr: string): string[] {
  if (!typeExpr) return [];
  // Move 2 function types may carry an ability constraint suffix:
  // `|u64|bool has copy + drop`. The function type can itself be nested in a
  // generic, so the suffix may end immediately before `>` rather than at the
  // end of the complete expression. Abilities are not nominal types.
  const expr = typeExpr
    .trim()
    .replace(
      /\s+has\s+(?:copy|drop|store|key)(?:\s*\+\s*(?:copy|drop|store|key))*(?=\s*(?:[>,)|]|$))/gi,
      '',
    )
    .replace(/^&(mut\s+)?/, '');
  if (MOVE_PRIMITIVES.has(expr)) return [];

  const tokens: string[] = [];
  // Delimiters cover generics (`<`, `>`, `,`), tuples (`(`, `)`), and Move 2
  // function types (`|u64|bool`) - without `()|` those leak into type names.
  for (const raw of expr.split(/[<>,()|]/)) {
    const name = raw.trim().replace(/^&(mut\s+)?/, '');
    if (!name || MOVE_PRIMITIVES.has(name)) continue;
    tokens.push(name);
  }
  return tokens;
}
