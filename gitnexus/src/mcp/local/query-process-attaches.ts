/**
 * Shape ranked query processes into the MCP `process_symbols` attach list
 * and honest per-process `symbol_count` (#3351).
 *
 * Aggregation already pushes a hub onto every owning process. This helper
 * is the last shaping step: slice each process to `max_symbols`, keep one
 * row per `(id, process_id)`, then set `symbol_count` from those rows.
 * `content` stays only on the first row for each symbol id so a hub in
 * many flows does not repeat its source text.
 */

export type QueryProcessAttach = {
  id: string;
  process_id: string;
  is_entry_point?: boolean;
} & Record<string, unknown>;

export type RankedQueryProcess<S extends QueryProcessAttach = QueryProcessAttach> = {
  id: string;
  label?: string;
  heuristicLabel?: string;
  processType?: string;
  stepCount?: number;
  entryPointId?: string;
  priority: number;
  symbols: S[];
  routes?: Array<{ url: string; method?: string }>;
};

export type QueryProcessCard = {
  id: string;
  summary: string;
  priority: number;
  symbol_count: number;
  process_type?: string;
  step_count?: number;
  route?: string;
  method?: string;
  routes?: Array<{ url: string; method?: string }>;
  chain?: unknown;
};

/**
 * Pair key for attach rows. Both `id` and `process_id` routinely contain
 * colons (`func:validate`, `proc:login-flow`), so a `:` join would collide.
 */
function attachPairKey(id: string, processId: string): string {
  return `${id}\0${processId}`;
}

export function shapeQueryProcessAttaches<S extends QueryProcessAttach>(
  rankedProcesses: Array<RankedQueryProcess<S>>,
  options: {
    maxSymbolsPerProcess: number;
    chainByProcessId?: ReadonlyMap<string, unknown>;
  },
): { processes: QueryProcessCard[]; process_symbols: S[] } {
  const { maxSymbolsPerProcess, chainByProcessId } = options;
  const seen = new Set<string>();
  const contentSeen = new Set<string>();
  const process_symbols: S[] = [];
  const countByProcess = new Map<string, number>();

  for (const p of rankedProcesses) {
    for (const s of p.symbols.slice(0, maxSymbolsPerProcess)) {
      const key = attachPairKey(s.id, s.process_id);
      if (seen.has(key)) continue;
      seen.add(key);
      let row: S = s;
      if (s.content !== undefined) {
        if (contentSeen.has(s.id)) {
          const { content: _content, ...rest } = s;
          row = rest as S;
        } else {
          contentSeen.add(s.id);
        }
      }
      if (p.entryPointId && s.id === p.entryPointId) row = { ...row, is_entry_point: true };
      process_symbols.push(row);
      countByProcess.set(s.process_id, (countByProcess.get(s.process_id) ?? 0) + 1);
    }
  }

  const processes = rankedProcesses.map((p) => {
    const card: QueryProcessCard = {
      id: p.id,
      summary: p.heuristicLabel || p.label || '',
      priority: Math.round(p.priority * 1000) / 1000,
      symbol_count: countByProcess.get(p.id) ?? 0,
      process_type: p.processType,
      step_count: p.stepCount,
    };
    if (p.routes && p.routes.length > 0) {
      card.route = p.routes[0].url;
      card.method = p.routes[0].method || undefined;
      card.routes = p.routes;
    }
    const chain = chainByProcessId?.get(p.id);
    if (chain !== undefined) card.chain = chain;
    return card;
  });

  return { processes, process_symbols };
}
