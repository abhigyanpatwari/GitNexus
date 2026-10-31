import { MCP_TOKEN_ESTIMATE_BYTES } from './output-budget.js';

/**
 * Agent-facing shaping of `impact` results.
 *
 * The MCP server and the `gitnexus impact` CLI hand impact results to an LLM,
 * which keeps every tool output in its context and re-reads it on each later
 * turn. Measured on DeepSWE trials (Claude Code, gpt-6.1-sol, 44 impact results):
 * the per-symbol `processes` lists were 56% of `byDepth`, and pretty-printed CLI
 * JSON was 45% larger than compact JSON. Neither adds information the model
 * lacks: `affected_processes` already lists every flow once.
 *
 * These helpers run only at those two agent boundaries. The backend result is
 * unchanged for internal callers (group fan-out, the web UI, tests).
 */

/** Symbols per depth level when an agent sets neither limit, offset nor summaryOnly. */
export const IMPACT_AGENT_DEFAULT_LIMIT = 30;

/** Processes listed per affected symbol; `processCount` carries the full count. */
export const IMPACT_ITEM_PROCESS_CAP = 3;

/** A budget that cannot hold the summary must never look like a successful empty walk. */
export class ImpactBudgetExceededError extends Error {
  constructor(readonly maxTokens: number) {
    super('Impact result cannot fit maxTokens. Increase maxTokens or narrow the request.');
    this.name = 'ImpactBudgetExceededError';
  }

  toJSONText(): string {
    const budget = this.maxTokens * MCP_TOKEN_ESTIMATE_BYTES;
    for (const payload of [
      { error: this.message },
      { error: 'Increase maxTokens' },
      { error: true },
    ]) {
      const text = JSON.stringify(payload);
      if (Buffer.byteLength(text, 'utf8') <= budget) return text;
    }
    // Even a one-token budget holds valid JSON. The transport's isError or
    // CLI exit status still signals failure when an error object cannot fit.
    return 'null';
  }
}

/**
 * The default per-depth page for agent calls. `GITNEXUS_IMPACT_DEFAULT_LIMIT=0`
 * restores the unpaged result.
 */
export function impactAgentDefaultLimit(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.GITNEXUS_IMPACT_DEFAULT_LIMIT;
  if (raw === undefined || raw.trim() === '') return IMPACT_AGENT_DEFAULT_LIMIT;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('GITNEXUS_IMPACT_DEFAULT_LIMIT must be a non-negative integer.');
  }
  return value === 0 ? undefined : value;
}

/**
 * Adds the default page to impact arguments that chose no pagination. Group
 * targets (`@name`) and PDG mode ignore pagination, so they pass through.
 */
export function withImpactAgentDefaults<T extends Record<string, unknown> | undefined>(
  args: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (!args) return args;
  if (
    args.limit !== undefined ||
    (args.offset !== undefined && args.offset !== 0) ||
    (args.summaryOnly !== undefined && args.summaryOnly !== false)
  ) {
    return args;
  }
  if (typeof args.repo === 'string' && args.repo.startsWith('@')) return args;
  if (args.mode === 'pdg') return args;
  const limit = impactAgentDefaultLimit(env);
  return limit === undefined ? args : { ...args, limit };
}

type ImpactItem = Record<string, unknown> & { processes?: unknown };

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keeps the first {@link IMPACT_ITEM_PROCESS_CAP} processes on each affected
 * symbol and records the full count as `processCount`.
 */
export function compactImpactItemProcesses<T>(result: T, cap = IMPACT_ITEM_PROCESS_CAP): T {
  const input: unknown = result;
  if (!isRecord(input) || !isRecord(input.byDepth)) return result;
  let trimmed = false;
  const byDepth: Record<string, unknown> = {};
  for (const [depth, items] of Object.entries(input.byDepth)) {
    if (!Array.isArray(items)) {
      byDepth[depth] = items;
      continue;
    }
    byDepth[depth] = items.map((item: ImpactItem) => {
      if (!isRecord(item) || !Array.isArray(item.processes) || item.processes.length <= cap) {
        return item;
      }
      trimmed = true;
      return {
        ...item,
        processes: item.processes.slice(0, cap),
        processCount: item.processes.length,
      };
    });
  }
  return trimmed ? ({ ...input, byDepth } as T) : result;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** `byDepth` with only the first `keep` symbols, taken in depth order. */
function keepFirst(byDepth: Record<string, unknown[]>, keep: number): Record<string, unknown[]> {
  const kept: Record<string, unknown[]> = {};
  let left = keep;
  for (const depth of Object.keys(byDepth).sort((a, b) => Number(a) - Number(b))) {
    kept[depth] = byDepth[depth].slice(0, Math.max(0, left));
    left -= kept[depth].length;
  }
  return kept;
}

/**
 * Fits an impact result into `maxTokens` by dropping whole symbols from the
 * deepest levels first, so the JSON stays valid and the direct dependants
 * survive longest. Counts (`byDepthCounts`, `impactedCount`, `summary`) still
 * describe the full result, and `pagination.trimmedForBudget` says what was
 * cut. If the summary alone cannot fit, fail explicitly instead of letting a
 * byte-level cap turn a successful response into broken JSON.
 *
 * `reservedBytes` is text appended after serialization (next-step hints).
 */
export function fitImpactToTokenBudget<T>(result: T, maxTokens: number, reservedBytes = 0): T {
  const input: unknown = result;
  const budget = maxTokens * MCP_TOKEN_ESTIMATE_BYTES - reservedBytes;
  if (byteLength(result) <= budget) return result;
  // PDG's byDepth aliases interproceduralByDepth. Trimming only one would
  // publish contradictory views of the same slice.
  if (!isRecord(input) || !isRecord(input.byDepth) || input.mode === 'pdg') {
    throw new ImpactBudgetExceededError(maxTokens);
  }

  const byDepth = input.byDepth as Record<string, unknown[]>;
  const total = Object.values(byDepth).reduce(
    (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
    0,
  );
  const build = (keep: number) => {
    const kept = keepFirst(byDepth, keep);
    const shownByDepth = Object.fromEntries(
      Object.entries(kept).map(([depth, items]) => [depth, items.length]),
    );
    return {
      ...input,
      pagination: {
        ...(isRecord(input.pagination) ? input.pagination : {}),
        truncated: true,
        trimmedForBudget: { maxTokens, shownByDepth },
      },
      byDepth: kept,
    };
  };

  // Largest prefix that fits: one serialization per probe, log2(total) probes.
  let low = 0;
  let high = total;
  if (byteLength(build(0)) > budget) throw new ImpactBudgetExceededError(maxTokens);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(build(mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  return build(low) as T;
}

/** The agent-boundary pipeline: compact process lists, then fit the token budget. */
export function shapeImpactForAgent<T>(
  result: T,
  maxTokens: number | undefined,
  reservedBytes = 0,
): T {
  const input: unknown = result;
  const compact =
    isRecord(input) && input.mode === 'pdg' ? result : compactImpactItemProcesses(result);
  return maxTokens === undefined
    ? compact
    : fitImpactToTokenBudget(compact, maxTokens, reservedBytes);
}
