/** Deterministic response-size check; no model calls, DB, or network.
 * Run: node --import tsx scripts/bench/mcp-response-filters.ts
 * Fixtures exercise wide graph responses, not task-solving or model billing.
 */
import assert from 'node:assert/strict';
import { applyMcpResponseFilter, resolveMcpResponseFilter } from '../../src/mcp/response-filter.js';
import { getNextStepHint } from '../../src/mcp/server.js';

const symbol = (index: number) => ({
  uid: `Function:src/payments/payment-service.ts:handlePayment${index}`,
  name: `handlePayment${index}`,
  kind: 'Function',
  filePath: 'src/payments/payment-service.ts',
  startLine: index * 10 + 1,
});
const refs = Array.from({ length: 30 }, (_, i) => symbol(i));
const chain = Array.from({ length: 2 }, (_, i) => ({
  depth: i + 1,
  upstream: Array.from({ length: 50 }, (_, j) => symbol(i * 100 + j)),
  downstream: Array.from({ length: 50 }, (_, j) => symbol(i * 100 + j + 50)),
}));
const processes = Array.from({ length: 5 }, (_, i) => ({
  id: `proc:payment-${i}`,
  summary: `Payment workflow ${i}`,
  priority: 0.8 - i / 10,
  symbol_count: 3,
  step_count: 10,
  chain,
}));
const processSymbols = processes.flatMap((p, i) =>
  Array.from({ length: 3 }, (_, j) => ({
    id: symbol(i * 3 + j).uid,
    name: symbol(i * 3 + j).name,
    filePath: symbol(i * 3 + j).filePath,
    process_id: p.id,
    startLine: (i * 3 + j) * 10 + 1,
  })),
);
const diagnostics = {
  warning: 'Index has an unresolved dispatch boundary',
  epistemic: 'lower-bound',
  boundaries: ['Dynamic dispatch is unresolved'],
  causes: { dispatchBoundary: 1 },
  staleness: { status: 'current', lastCommit: 'fixture' },
};
const query = { processes, process_symbols: processSymbols, definitions: [], ...diagnostics };
const context = {
  status: 'found',
  symbol: symbol(0),
  incoming: { calls: refs.slice(0, 10), uses: refs.slice(10) },
  outgoing: { calls: refs.slice(0, 10), imports: refs.slice(10) },
  processes: processes.map(({ chain: _chain, ...process }) => process),
  chain,
  ...diagnostics,
};
const cases = [
  {
    name: 'query symbols, expanded flows available',
    tool: 'query',
    result: query,
    args: { response_sections: ['process_symbols', 'definitions'] },
    keep: ['process_symbols', 'definitions'],
  },
  {
    name: 'query symbols, no chain requested',
    tool: 'query',
    result: { ...query, processes: processes.map(({ chain: _chain, ...p }) => p) },
    args: { response_sections: ['process_symbols', 'definitions'] },
    keep: ['process_symbols', 'definitions'],
  },
  {
    name: 'context callers, expanded chain available',
    tool: 'context',
    result: context,
    args: { response_sections: ['incoming'], relationTypes: ['CALLS'] },
    keep: ['symbol'],
  },
  {
    name: 'context callers, no chain requested',
    tool: 'context',
    result: Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'chain')),
    args: { response_sections: ['incoming'], relationTypes: ['CALLS'] },
    keep: ['symbol'],
  },
];
const measurements = cases.map(({ name, tool, result, args, keep }) => {
  const filtered = applyMcpResponseFilter(result, resolveMcpResponseFilter(tool, args)) as Record<
    string,
    unknown
  >;
  assert.equal(applyMcpResponseFilter(result, undefined), result);
  for (const key of [...keep, ...Object.keys(diagnostics)]) {
    assert.deepEqual(filtered[key], (result as Record<string, unknown>)[key]);
  }
  if (tool === 'context') assert.deepEqual(filtered.incoming, { calls: context.incoming.calls });
  const format = (value: unknown) =>
    JSON.stringify(value, null, 2) + getNextStepHint(tool, { repo: 'fixture' });
  const baselineBytes = Buffer.byteLength(format(result));
  const filteredBytes = Buffer.byteLength(format(filtered));
  assert.deepEqual(JSON.parse(JSON.stringify(filtered)), filtered);
  return {
    name,
    baselineBytes,
    filteredBytes,
    savedBytes: baselineBytes - filteredBytes,
    reductionPercent: Number((100 * (1 - filteredBytes / baselineBytes)).toFixed(1)),
    baselineEstimatedTokens: Math.ceil(baselineBytes / 4),
    filteredEstimatedTokens: Math.ceil(filteredBytes / 4),
  };
});
console.log(
  JSON.stringify(
    {
      workload: 'synthetic graph responses; complete MCP text including hints',
      estimator: 'UTF-8 bytes / 4, not model-specific billing tokens',
      measurements,
    },
    null,
    2,
  ),
);
