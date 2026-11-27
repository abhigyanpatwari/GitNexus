/**
 * An ordered composition of embedding reuse sources (#3631): the job's
 * own fallback artifact (or legacy source) first, then sibling branch
 * artifacts. Receipts are served by the FIRST source that can prove a
 * node's rows, and chunk reads are routed back to the source that issued
 * the receipt — each source keeps its own provenance rules, this class
 * only fans out. Per-source served counts are kept so the caller can
 * attribute reuse (e.g. sibling vs own) in its reporting.
 */
import type { VectorNodeReceipt, VectorStore } from '../lbug/vector-store.js';
import type { EmbeddingReuseOptions } from './embedding-inputs.js';
import type { EmbeddingReuseSource } from './embedding-job-runner.js';

export class CompositeEmbeddingReuseSource implements EmbeddingReuseSource {
  readonly options: { batchBytes: number };
  readonly requiresInputValidation: boolean;
  private readonly origin = new Map<string, EmbeddingReuseSource>();
  private readonly served = new Map<EmbeddingReuseSource, { nodes: number; chunks: number }>();

  constructor(private readonly sources: readonly EmbeddingReuseSource[]) {
    if (sources.length === 0) throw new Error('A composite reuse source needs at least one source');
    // A unit's chunks are read through ONE source, but the runner sizes
    // its reads from the composite — the smallest constituent budget is
    // the only one every source can honor.
    this.options = { batchBytes: Math.min(...sources.map((source) => source.options.batchBytes)) };
    this.requiresInputValidation = sources.some(
      (source) => source.requiresInputValidation === true,
    );
  }

  async reusable(
    nodeId: string,
    contentHash: string,
    options: EmbeddingReuseOptions,
  ): Promise<VectorNodeReceipt | null> {
    for (const source of this.sources) {
      const receipt = await source.reusable(nodeId, contentHash, options);
      if (!receipt) continue;
      this.origin.set(nodeId, source);
      const stats = this.served.get(source) ?? { nodes: 0, chunks: 0 };
      stats.nodes += 1;
      stats.chunks += receipt.chunks;
      this.served.set(source, stats);
      return receipt;
    }
    return null;
  }

  readonly readChunks: VectorStore['readChunks'] = async (receipt, start, length) => {
    const source = this.origin.get(receipt.nodeId);
    if (!source) throw new Error('Composite reuse read has no origin for its receipt');
    return source.readChunks(receipt, start, length);
  };

  /** Nodes/chunks a constituent source has served through this composite. */
  statsFor(source: EmbeddingReuseSource): { nodes: number; chunks: number } {
    return this.served.get(source) ?? { nodes: 0, chunks: 0 };
  }
}
