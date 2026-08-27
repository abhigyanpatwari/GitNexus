/**
 * `--exact-only` / `exactOnly` had the same defect this PR removes
 * `skipEmbeddings` for: it was declared on `SyncOptions`, threaded through the
 * CLI and the MCP tool, and never read. A sync asked for exact matching only
 * still ran the wildcard stage and still emitted `matchType: 'wildcard'`
 * cross-links, so the flag was a promise the pipeline never kept.
 *
 * It is kept (rather than deleted alongside the never-built BM25/embedding
 * stages) because the stage it names does exist, so the flag describes a real
 * choice. These two cases run the SAME synthetic input through `syncGroup`
 * twice and differ only in the flag, so the wildcard link is the only thing
 * that can move between them.
 */
import { describe, it, expect } from 'vitest';
import { syncGroup } from '../../../src/core/group/sync.js';
import { makeWildcardPair } from './fixtures.js';
import type { GroupConfig, StoredContract } from '../../../src/core/group/types.js';

describe('syncGroup exactOnly gates the wildcard stage', () => {
  const config: GroupConfig = {
    version: 1,
    name: 'test',
    description: '',
    repos: { 'app/provider': 'provider-repo', 'app/consumer': 'consumer-repo' },
    links: [],
    packages: {},
    detect: {
      http: true,
      grpc: false,
      thrift: false,
      topics: false,
      includes: false,
      workspace_deps: false,
    },
    matching: {},
  };

  const { provider, consumer } = makeWildcardPair();

  it('runs the wildcard stage when exactOnly is not set', async () => {
    const result = await syncGroup(config, {
      extractorOverride: async () => [provider, consumer],
      skipWrite: true,
    });

    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].matchType).toBe('wildcard');
    expect(result.crossLinks[0].contractId).toBe('thrift::OrderService/*');
    expect(result.crossLinks[0].from.repo).toBe('app/consumer');
    expect(result.crossLinks[0].to.repo).toBe('app/provider');
    // The consumer was placed, so only the provider is left over.
    expect(result.unmatched.map((c) => c.contractId)).toEqual([
      'thrift::billing.v1.OrderService/PlaceOrder',
    ]);
  });

  it('emits no wildcard cross-link when exactOnly is true, and still reports the contract as unmatched', async () => {
    const result = await syncGroup(config, {
      extractorOverride: async () => [provider, consumer],
      exactOnly: true,
      skipWrite: true,
    });

    expect(result.crossLinks).toEqual([]);

    // The second half of the gate, and the reason it substitutes
    // `{ matched: [], remaining: unmatched }` rather than an empty result:
    // `wildcard.remaining` IS `SyncResult.unmatched`. A gate that returned
    // `remaining: []` would also produce zero cross-links and pass the
    // assertion above, while silently deleting both contracts from the
    // unmatched count an operator reads to decide whether the flag cost them
    // anything. Skipping the stage must leave its input unmatched, not gone.
    expect(result.unmatched.map((c) => c.contractId)).toEqual([
      'thrift::billing.v1.OrderService/PlaceOrder',
      'thrift::OrderService/*',
    ]);
    // Extraction itself is untouched by the flag — both contracts are still in
    // the registry, only the link between them is withheld.
    expect(result.contracts).toHaveLength(2);
  });
});
