import { describe, expect, it } from 'vitest';
import type { GraphEmitManifest } from '../../src/core/lbug/graph-emit-sink.js';
import type { PdgEmitManifest } from '../../src/core/lbug/pdg-emit-sink.js';
import {
  StreamedIncrementalWritebackError,
  assertIncrementalWritebackSupportsPipelineResult,
} from '../../src/core/run-analyze.js';

const graphEmitManifest: GraphEmitManifest = {
  relsByPair: new Map(),
  totalRows: 0,
  structuralRows: 0,
};

const pdgEmitManifest: PdgEmitManifest = {
  nodeFiles: new Map(),
  relsByPair: new Map(),
};

describe('assertIncrementalWritebackSupportsPipelineResult', () => {
  it.each([
    ['structural', { graphEmitManifest }, ['structural']],
    ['PDG', { pdgEmitManifest }, ['PDG']],
    ['structural and PDG', { graphEmitManifest, pdgEmitManifest }, ['structural', 'PDG']],
  ] as const)(
    'rejects an incremental result with a defined zero-row %s manifest',
    (_label, manifests, expectedKinds) => {
      try {
        assertIncrementalWritebackSupportsPipelineResult(true, manifests);
        expect.fail('expected StreamedIncrementalWritebackError');
      } catch (error) {
        expect(error).toBeInstanceOf(StreamedIncrementalWritebackError);
        expect((error as StreamedIncrementalWritebackError).manifestKinds).toEqual(expectedKinds);
        expect((error as Error).message).toContain('live graph index was not changed');
        expect((error as Error).message).toMatch(/disable incremental streaming/i);
        expect((error as Error).message).toContain('--force');
      }
    },
  );

  it('allows ordinary incremental and all full-rebuild results', () => {
    expect(() => assertIncrementalWritebackSupportsPipelineResult(true, {})).not.toThrow();
    expect(() =>
      assertIncrementalWritebackSupportsPipelineResult(false, { graphEmitManifest }),
    ).not.toThrow();
    expect(() =>
      assertIncrementalWritebackSupportsPipelineResult(false, { pdgEmitManifest }),
    ).not.toThrow();
    expect(() =>
      assertIncrementalWritebackSupportsPipelineResult(false, {
        graphEmitManifest,
        pdgEmitManifest,
      }),
    ).not.toThrow();
  });
});
