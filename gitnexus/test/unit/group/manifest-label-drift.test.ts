/**
 * #2380: manifest-extractor's CUSTOM_CONTRACT_RESOLVE_QUERY hand-lists the graph
 * labels that resolve as contract symbols. It is a deliberate SUBSET of the
 * shared SYMBOL_NODE_LABELS (ingestion/utils/symbol-labels.ts) — omitting
 * Namespace/Variable/Module, which would widen contract resolution and is
 * #2325-test-locked. A comment asserts that relationship but nothing enforced
 * it, so adding a label to SYMBOL_NODE_LABELS could silently diverge the two.
 * This locks it: the query string stays literal; the test derives its label set.
 */
import { describe, it, expect } from 'vitest';
import { CUSTOM_CONTRACT_RESOLVE_QUERY } from '../../../src/core/group/extractors/manifest-extractor.js';
import {
  RESOLVE_GENERATED_SYMBOL_QUERY,
  RESOLVE_METHOD_QUERY,
} from '../../../src/core/group/extractors/graphql-extractor.js';
import { SYMBOL_NODE_LABELS } from '../../../src/core/ingestion/utils/symbol-labels.js';

describe('manifest contract-resolve label list vs SYMBOL_NODE_LABELS (#2380)', () => {
  const match = CUSTOM_CONTRACT_RESOLVE_QUERY.match(/labels\(n\) IN \[([^\]]+)\]/);
  const manifestLabels = new Set(
    (match?.[1] ?? '').split(',').map((t) => t.trim().replace(/^'|'$/g, '')),
  );
  const symbolLabels = new Set<string>(SYMBOL_NODE_LABELS);

  it('extracts a non-empty label allowlist from the query', () => {
    expect(manifestLabels.size).toBeGreaterThan(0);
  });

  it('every manifest label is a member of SYMBOL_NODE_LABELS (strict subset)', () => {
    const extra = [...manifestLabels].filter((l) => !symbolLabels.has(l));
    expect(extra).toEqual([]);
  });

  it('the difference is exactly {Namespace, Variable, Module}', () => {
    const diff = [...symbolLabels].filter((l) => !manifestLabels.has(l)).sort();
    expect(diff).toEqual(['Module', 'Namespace', 'Variable']);
  });
});

describe.each([
  ['GraphQL provider', RESOLVE_METHOD_QUERY],
  ['GraphQL generated symbol', RESOLVE_GENERATED_SYMBOL_QUERY],
])('%s query label list vs SYMBOL_NODE_LABELS', (_name, query) => {
  const match = query.match(/labels\(n\) IN \[([^\]]+)\]/);
  const queryLabels = (match?.[1]?.match(/'([^']+)'/g) ?? []).map((label) => label.slice(1, -1));
  const symbolLabels = new Set<string>(SYMBOL_NODE_LABELS);

  it('keeps every hand-listed label in the shared symbol label set', () => {
    expect(queryLabels.length).toBeGreaterThan(0);
    for (const label of queryLabels) expect(symbolLabels.has(label)).toBe(true);
  });
});
