/**
 * Offline query-output comparison using repository source as a fixed payload.
 * Run: node --import tsx scripts/bench/mcp-query-content.ts [--include-text]
 * Measures formatting only, not indexing, model billing, or whole-agent latency.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { formatMcpQueryResult } from '../../src/mcp/output-budget.js';
import { getNextStepHint } from '../../src/mcp/server.js';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const row = (path: string) => ({
  id: `File:gitnexus/${path}`,
  filePath: `gitnexus/${path}`,
  content: source(path),
});
const cases = [
  {
    name: 'large CLI source',
    definitions: [row('src/cli/analyze.ts'), row('src/cli/help-i18n.ts')],
  },
  {
    name: 'large MCP source',
    definitions: [row('src/mcp/local/local-backend.ts'), row('src/mcp/tools.ts')],
  },
  {
    name: 'small symbol',
    definitions: [{ id: 'Function:small', content: 'function small() { return true; }' }],
  },
];
const diagnostics = {
  partial: true,
  warning: 'Incomplete keyword index',
  staleness: { status: 'behind' },
};
const hint = getNextStepHint('query', { repo: 'fixture', include_content: true });
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const measurements = [];
for (const entry of cases) {
  const result = {
    processes: [],
    process_symbols: [],
    definitions: entry.definitions,
    ...diagnostics,
  };
  const before = () => JSON.stringify(result) + hint;
  const after = () => formatMcpQueryResult(result, hint, undefined);
  const baselineText = before();
  const currentText = after();
  const parsed = JSON.parse(currentText);
  assert.deepEqual(
    parsed.definitions.map(({ id }: { id: string }) => id),
    entry.definitions.map(({ id }) => id),
  );
  for (const [key, value] of Object.entries(diagnostics)) assert.deepEqual(parsed[key], value);
  for (let i = 0; i < 100; i++) {
    before();
    after();
  }
  const baselineMs: number[] = [];
  const currentMs: number[] = [];
  const measure = (format: () => string) => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) format();
    return (performance.now() - start) / 100;
  };
  for (let trial = 0; trial < 21; trial++) {
    // Alternate order to reduce a warmup/order bias on this shared host.
    if (trial % 2 === 0) {
      baselineMs.push(measure(before));
      currentMs.push(measure(after));
    } else {
      currentMs.push(measure(after));
      baselineMs.push(measure(before));
    }
  }
  measurements.push({
    name: entry.name,
    corpusSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    baselineBytes: Buffer.byteLength(baselineText),
    currentBytes: Buffer.byteLength(currentText),
    baselineMedianMs: median(baselineMs),
    currentMedianMs: median(currentMs),
    retainedRows: parsed.definitions.length,
    omittedSources: parsed.content_budget?.omitted ?? 0,
    ...(process.argv.includes('--include-text') ? { baselineText, currentText } : {}),
  });
}
console.log(
  JSON.stringify(
    { workload: 'Fixed repository-source payloads; formatting only', measurements },
    null,
    2,
  ),
);
