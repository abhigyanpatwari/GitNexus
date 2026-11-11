import { describe, expect, it } from 'vitest';

const { parityBody } = await import(
  new URL('../../bench/mcp-query/integrity-parity.mjs', import.meta.url).href
);

const receipt = { version: 1, checkedSites: 4, unverifiedEdges: 0, duplicatesSuppressed: 1 };
const verified = {
  status: 'verified',
  scope: 'source-reference-ingestion',
  checkedSites: 4,
  unverifiedEdges: 0,
  duplicatesSuppressed: 1,
  note: 'Source-reference identities and source spans were checked before writing. This validates ingestion provenance, not resolution accuracy or query completeness.',
};
const indexes = { baseline: {}, candidate: { relationshipIntegrity: receipt } };

describe('MCP benchmark legacy receipt parity', () => {
  it('validates and removes only the candidate receipt for a legacy baseline', () => {
    const baseline = { definitions: [{ id: 'one' }] };
    const candidate = { ...baseline, graph_integrity: verified };
    expect(parityBody(baseline, 'baseline', indexes)).toEqual(baseline);
    expect(parityBody(candidate, 'candidate', indexes)).toEqual(baseline);
    expect(candidate.graph_integrity).toEqual(verified);
    expect(
      parityBody({ ...candidate, definitions: [{ id: 'different' }] }, 'candidate', indexes),
    ).not.toEqual(baseline);
  });

  it('validates the unverified status and its counts against the candidate index', () => {
    const candidateReceipt = { ...receipt, unverifiedEdges: 2 };
    const graph_integrity = {
      ...verified,
      status: 'unverified',
      unverifiedEdges: 2,
      note: 'Some reference edges have only a caller/target identity, extracted-buffer coordinates, or incomplete source provenance. Their original source-site distinctness is unverified; query deduplication is not an integrity check.',
    };
    expect(
      parityBody({ graph_integrity }, 'candidate', {
        baseline: {},
        candidate: { relationshipIntegrity: candidateReceipt },
      }),
    ).toEqual({});
  });

  it.each([
    undefined,
    { ...receipt, version: 2 },
    { ...receipt, checkedSites: -1 },
    { ...receipt, unverifiedEdges: 0.5 },
    { ...receipt, duplicatesSuppressed: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects missing or malformed candidate index receipt %#', (invalid) => {
    expect(() =>
      parityBody({ graph_integrity: verified }, 'candidate', {
        baseline: {},
        candidate: { relationshipIntegrity: invalid },
      }),
    ).toThrow('Candidate index has no valid relationship integrity receipt');
  });

  it.each([
    undefined,
    { ...verified, status: 'unverified' },
    { ...verified, checkedSites: 5 },
    { ...verified, scope: 'other' },
    { ...verified, note: 'wrong' },
    { ...verified, extra: true },
  ])('rejects a missing or incorrect response receipt %#', (invalid) => {
    expect(() => parityBody({ graph_integrity: invalid }, 'candidate', indexes)).toThrow(
      'Candidate graph_integrity does not match its index receipt',
    );
  });

  it('rejects a baseline response carrying an unexpected receipt', () => {
    expect(() => parityBody({ graph_integrity: verified }, 'baseline', indexes)).toThrow(
      'Legacy baseline unexpectedly returned graph_integrity',
    );
  });

  it('keeps receipts in ordinary parity when both indexes have them', () => {
    const both = {
      baseline: { relationshipIntegrity: receipt },
      candidate: { relationshipIntegrity: receipt },
    };
    const baseline = { graph_integrity: verified, definitions: [] };
    const candidate = { graph_integrity: { ...verified, checkedSites: 5 }, definitions: [] };
    expect(parityBody(baseline, 'baseline', both)).toBe(baseline);
    expect(parityBody(candidate, 'candidate', both)).toBe(candidate);
    expect(parityBody(candidate, 'candidate', both)).not.toEqual(
      parityBody(baseline, 'baseline', both),
    );
  });
});
