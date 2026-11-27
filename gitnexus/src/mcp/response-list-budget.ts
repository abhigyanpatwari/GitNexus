import { MCP_TOKEN_ESTIMATE_BYTES, McpBudgetExceededError } from './output-budget.js';

/**
 * `maxTokens` for `query` and `context`: trim list items instead of cutting the
 * serialized text, so the JSON stays valid and staleness/identity survive
 * (same contract as impact, #3793). Every list keeps the same number of
 * leading items, and `trimmedForBudget` records shown/total per shortened list.
 */

type Json = Record<string, unknown>;
export type BudgetedListTool = 'query' | 'context';

const QUERY_LISTS = ['processes', 'process_symbols', 'definitions', 'results'];
const CONTEXT_LISTS = ['processes', 'routes', 'typed_properties', 'candidates'];

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const head = (value: unknown, n: number) => (Array.isArray(value) ? value.slice(0, n) : value);

/** Calls `visit(path, list)` for every trimmable list in the result. */
function forEachList(
  tool: BudgetedListTool,
  result: Json,
  visit: (path: string, list: unknown[]) => void,
) {
  for (const key of tool === 'query' ? QUERY_LISTS : CONTEXT_LISTS) {
    if (Array.isArray(result[key])) visit(key, result[key]);
  }
  if (tool === 'query') return;
  for (const direction of ['incoming', 'outgoing']) {
    const refs = result[direction];
    if (!isRecord(refs)) continue;
    for (const [type, list] of Object.entries(refs)) {
      if (Array.isArray(list)) visit(`${direction}.${type}`, list);
    }
  }
  if (Array.isArray(result.chain)) {
    visit('chain', result.chain);
    result.chain.forEach((layer, i) => {
      if (!isRecord(layer)) return;
      for (const side of ['upstream', 'downstream']) {
        if (Array.isArray(layer[side])) visit(`chain[${i}].${side}`, layer[side] as unknown[]);
      }
    });
  }
}

function cutLists(tool: BudgetedListTool, result: Json, n: number): Json {
  const out: Json = { ...result };
  for (const key of tool === 'query' ? QUERY_LISTS : CONTEXT_LISTS) {
    if (key in result) out[key] = head(result[key], n);
  }
  if (tool === 'query') {
    // Don't list steps of a flow that was trimmed away. Steps arrive in ranked-flow
    // order, so the steps kept for `n` flows are a prefix of those kept for `n + 1`.
    if (Array.isArray(out.processes) && Array.isArray(result.process_symbols)) {
      // Multi-repo results join on (_repo, id); a bare id can collide across repos.
      const flowKey = (repo: unknown, id: unknown) => `${String(repo)}\0${String(id)}`;
      const kept = new Set(out.processes.map((p) => (isRecord(p) ? flowKey(p._repo, p.id) : '')));
      out.process_symbols = result.process_symbols
        .filter(
          (s) =>
            !isRecord(s) || s.process_id === undefined || kept.has(flowKey(s._repo, s.process_id)),
        )
        .slice(0, n);
    }
    return out;
  }
  for (const direction of ['incoming', 'outgoing']) {
    const refs = result[direction];
    if (isRecord(refs)) {
      out[direction] = Object.fromEntries(Object.entries(refs).map(([t, l]) => [t, head(l, n)]));
    }
  }
  if (Array.isArray(result.chain)) {
    out.chain = result.chain
      .slice(0, n)
      .map((layer: unknown) =>
        isRecord(layer)
          ? { ...layer, upstream: head(layer.upstream, n), downstream: head(layer.downstream, n) }
          : layer,
      );
  }
  return out;
}

function trimmedView(tool: BudgetedListTool, result: Json, n: number, maxTokens: number): Json {
  const cut = cutLists(tool, result, n);
  const shown = new Map<string, number>();
  forEachList(tool, cut, (path, list) => shown.set(path, list.length));
  const lists: Record<string, { shown: number; total: number }> = {};
  forEachList(tool, result, (path, list) => {
    // Lists inside a dropped chain layer are covered by the `chain` entry.
    const layer = /^chain\[(\d+)\]\./.exec(path);
    if (layer && Number(layer[1]) >= (shown.get('chain') ?? 0)) return;
    const count = shown.get(path) ?? 0;
    if (count < list.length) lists[path] = { shown: count, total: list.length };
  });
  return { ...cut, trimmedForBudget: { maxTokens, lists } };
}

/**
 * Returns the result unchanged when it fits (or is not a plain object), the
 * largest trimmed view that fits otherwise, and throws McpBudgetExceededError
 * when even empty lists don't fit. `reservedBytes` covers the next-step hint.
 */
export function fitListsToTokenBudget<T>(
  tool: BudgetedListTool,
  result: T,
  maxTokens: number | undefined,
  reservedBytes = 0,
): T {
  const input: unknown = result;
  if (maxTokens === undefined || !isRecord(input) || 'error' in input) return result;
  const budget = maxTokens * MCP_TOKEN_ESTIMATE_BYTES - reservedBytes;
  if (byteLength(input) <= budget) return result;

  const lengths = new Set<number>([0]);
  forEachList(tool, input, (_, list) => lengths.add(list.length));
  const fits = (n: number) => byteLength(trimmedView(tool, input, n, maxTokens)) <= budget;
  if (lengths.size === 1 || !fits(0)) throw new McpBudgetExceededError(maxTokens);

  // Size grows with `n` except where a list becomes complete and drops its
  // `trimmedForBudget` entry. Search each stretch between such points, longest first.
  const starts = [...lengths].sort((a, b) => a - b);
  for (let s = starts.length - 1; s >= 0; s--) {
    const end = s + 1 < starts.length ? starts[s + 1] - 1 : starts[s];
    if (!fits(starts[s])) continue;
    let low = starts[s];
    let high = end;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    return trimmedView(tool, input, low, maxTokens) as T;
  }
  throw new McpBudgetExceededError(maxTokens);
}
