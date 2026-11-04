/** One durable manifest unit, one bounded provider batch, no corpus-sized maps. */
import { EmbeddingByteBudget } from '../analysis-resource-budget.js';
import type { VectorNodeReceipt, VectorStore, VectorWriteChunk } from '../lbug/vector-store.js';
import type {
  EmbeddingJobJournal,
  EmbeddingJobState,
  EmbeddingUnitIntent,
} from '../../storage/embedding-job-journal.js';
import {
  fetchEmbeddingWorkUnit,
  readEmbeddingWorkUnits,
  type EmbeddingManifestReceipt,
  type EmbeddingManifestSource,
  type EmbeddingWorkUnit,
} from './embedding-work-manifest.js';
import { contentHashForNode, embedInputRanges, isInputRejection } from './embedding-pipeline.js';
import { iterateNodeChunks } from './chunker.js';
import { generateEmbeddingText, splitEmbeddingText } from './text-generator.js';
import { extractStructuralNames } from './structural-extractor.js';
import { resolveEmbeddingConfig } from './config.js';
import { isShortLabel, STRUCTURAL_LABELS, type EmbeddingConfig } from './types.js';
import type { embedBatch } from './embedder.js';

export interface EmbeddingJobRunnerOptions {
  directory: string;
  manifest: EmbeddingManifestReceipt;
  source: EmbeddingManifestSource;
  journal: EmbeddingJobJournal;
  store: VectorStore;
  /** The controller has validated vector/input identities before providing reuse. */
  reuse?: Pick<VectorStore, 'reusable' | 'readChunks' | 'options'>;
  /** The writer was adopted from an older graph. Persist this choice for the
   * whole job: old complete receipts cannot skip current-input validation. */
  revalidateStoredInputs?: boolean;
  config?: Partial<EmbeddingConfig>;
  queueBytes: number;
  provider: typeof embedBatch;
  initializeProvider?: () => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (state: EmbeddingJobState, peakQueueBytes: number) => void;
}

export interface EmbeddingJobRunResult {
  state: EmbeddingJobState;
  peakQueueBytes: number;
  /** Absent while failed work remains. Publication is the controller's job. */
  indexKind?: 'hnsw' | 'exact';
}

/** Caller owns the job lock and closes all handles, including on rejection. */
export async function runEmbeddingJob(
  options: EmbeddingJobRunnerOptions,
): Promise<EmbeddingJobRunResult> {
  const { directory, manifest, source, journal, store, signal } = options;
  const config = resolveEmbeddingConfig(options.config ?? {});
  const budget = new EmbeddingByteBudget(options.queueBytes);
  const dimensions = store.options.dimensions;
  // UTF-16 text + worst-case JSON escaping/encoding, bounded HTTP response
  // decoding/JSON parsing, float results, JS arrays and native copies. HTTP
  // responses are capped at 4096 + 32*dimensions bytes per row by the controller.
  // The provider's runtime has a separate reservation.
  const rowBytes = (textChars: number, idChars: number) =>
    16 * textChars + 512 * dimensions + 64 * 1024 + 4 * idChars;
  const minimumBatchBytes = rowBytes(config.maxInputChars, 0);
  if (minimumBatchBytes > budget.limit)
    throw new Error('Embedding input/vector batch does not fit the resource budget');
  let initialized = false;
  let attempted = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  const remainingNodes =
    manifest.totalNodes - journal.snapshot().completedNodes - journal.snapshot().reusedNodes;
  const ratioFloor = Math.min(20, Math.max(5, Math.ceil(remainingNodes / config.subBatchSize / 2)));
  // Bounded even if every source node is rejected. IDs are needed only until
  // the existing five-node input-rejection guard fires or a success resets it.
  const rejected = new Set<string>();
  const progress = () => options.onProgress?.(journal.snapshot(), budget.peakBytes);

  const processUnit = async (
    unit: EmbeddingWorkUnit,
    intent: EmbeddingUnitIntent,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const complete = options.revalidateStoredInputs
      ? new Map<string, VectorNodeReceipt>()
      : await store.completedNodes(unit.nodes.map((node) => node.id));
    const missing = unit.nodes.filter((node) => !complete.has(node.id));
    const retainedBytes = missing.reduce(
      (n, key) => n + 2 * (key.contentBytes + key.metadataBytes),
      0,
    );
    // One node may expand its text/AST while the rest of the fetched unit stays
    // retained. Admission precedes intent, provider calls and vector mutation.
    const scratchBytes = missing.reduce(
      (n, key) => Math.max(n, 16 * (key.contentBytes + key.metadataBytes)),
      0,
    );
    const maxIdChars = missing.reduce((n, key) => Math.max(n, key.id.length), 0);
    const maximumBatchRows = Math.min(
      256,
      config.subBatchSize,
      Math.floor(store.options.batchBytes / (16 * dimensions + 128 + 2 * (maxIdChars + 40))),
    );
    if (maximumBatchRows < 1) throw new Error('Vector write does not fit its batch reservation');
    if (retainedBytes + scratchBytes + rowBytes(config.maxInputChars, maxIdChars) > budget.limit)
      throw new Error(
        `Embedding unit ${unit.ordinal} requires a larger resource budget; no source text was truncated`,
      );
    if (!journal.snapshot().active) await journal.begin(intent);
    progress();
    if (!missing.length) {
      await store.checkpointUnit([...complete.values()]);
      await journal.acknowledge({
        reusedNodes: complete.size,
        chunks: [...complete.values()].reduce((n, r) => n + r.chunks, 0),
      });
      progress();
      return;
    }
    const fetched = await fetchEmbeddingWorkUnit(
      source,
      { ...unit, nodes: missing, retainedBytes },
      budget,
    );
    const releaseScratch = budget.reserve(scratchBytes);
    let batch: Array<Omit<VectorWriteChunk, 'embedding'> & { text: string; release: () => void }> =
      [];
    const generated = new Map<string, { contentHash: string; chunks: number; ended: boolean }>();
    const failed = new Set<string>();
    let failureCause: 'input' | 'provider' = 'input';
    let abort: unknown;
    let reusedNodes = complete.size;

    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      signal?.throwIfAborted();
      if (!initialized) {
        await options.initializeProvider?.();
        initialized = true;
      }
      attempted++;
      let providerFailed = false;
      try {
        for await (const result of embedInputRanges(
          batch.map((row) => row.text),
          batch.length,
          signal,
          options.provider,
        )) {
          signal?.throwIfAborted();
          const rows = batch.slice(result.start, result.end);
          if ('error' in result) {
            for (const row of rows) failed.add(row.nodeId);
            if (isInputRejection(result.error)) {
              for (const row of rows) if (rejected.size < 5) rejected.add(row.nodeId);
            } else {
              failureCause = 'provider';
              providerFailed = true;
              consecutiveFailures++;
              if (consecutiveFailures >= 5) abort = result.error;
            }
            continue;
          }
          if (
            result.embeddings.length !== rows.length ||
            result.embeddings.some(
              (v) => v.length !== dimensions || v.some((n) => !Number.isFinite(n)),
            )
          )
            throw new Error('Embedding provider returned invalid vector coverage');
          consecutiveFailures = 0;
          rejected.clear();
          const updates = rows.flatMap((row, i) =>
            failed.has(row.nodeId)
              ? []
              : [
                  {
                    nodeId: row.nodeId,
                    contentHash: row.contentHash,
                    chunkIndex: row.chunkIndex,
                    startLine: row.startLine,
                    endLine: row.endLine,
                    embedding: Array.from(result.embeddings[i]),
                  },
                ],
          );
          if (updates.length) await store.appendBatch(updates);
        }
        if (providerFailed) failures++;
        if (!abort && providerFailed && attempted >= ratioFloor && failures / attempted >= 0.25)
          abort = new Error(
            'Embedding endpoint failure rate exceeded 25%; unfinished units remain resumable',
          );
        if (!abort && rejected.size >= 5)
          abort = new Error(
            'Embedding inputs rejected for five nodes without a success; unfinished units remain resumable',
          );
      } finally {
        for (const row of batch) row.release();
        batch = [];
      }
    };

    try {
      // Hash once per fetched node; current-job complete groups never fetch/hash.
      const inputs = fetched.nodes.map((node) => ({
        nodeId: node.id,
        contentHash: contentHashForNode(node, config),
        sourceStartLine: node.startLine ?? 0,
        sourceEndLine: node.endLine ?? 0,
      }));
      if (options.revalidateStoredInputs) {
        for (const input of inputs) {
          const retained = await store.reuseNode(input);
          if (retained) {
            complete.set(input.nodeId, retained);
            reusedNodes++;
          }
        }
      }
      const missingInputs = options.revalidateStoredInputs
        ? inputs.filter((input) => !complete.has(input.nodeId))
        : inputs;
      if (missingInputs.length) await store.beginNodes(missingInputs);
      for (let i = 0; i < fetched.nodes.length; i++) {
        const node = fetched.nodes[i];
        const input = inputs[i];
        signal?.throwIfAborted();
        if (options.revalidateStoredInputs && complete.has(node.id)) continue;
        const reuse = options.reuse;
        const reusable = await reuse?.reusable(node.id, input.contentHash);
        if (reusable && reuse) {
          // Flush before copy so there is only one vector batch in memory.
          await flush();
          if (abort) break;
          const copyRows = Math.min(
            256,
            Math.floor(
              Math.min(
                reuse.options.batchBytes,
                store.options.batchBytes,
                budget.limit - budget.usedBytes,
              ) /
                (32 * dimensions + 1024 + 4 * node.id.length),
            ),
          );
          if (copyRows < 1)
            throw new Error('Reusable vector batch does not fit the resource budget');
          for (let start = 0; start < reusable.chunks; start += copyRows) {
            const length = Math.min(copyRows, reusable.chunks - start);
            // Reuse has no HTTP body or JSON decoder; retain only vector copies.
            const release = budget.reserve(length * (32 * dimensions + 1024 + 4 * node.id.length));
            try {
              const chunks = await reuse.readChunks(reusable, start, length);
              const delta = input.sourceStartLine - (reusable.sourceStartLine ?? 0);
              await store.append(
                node.id,
                input.contentHash,
                chunks.map((chunk) => ({
                  ...chunk,
                  startLine: chunk.startLine + delta,
                  endLine:
                    chunk.endLine === reusable.sourceEndLine
                      ? input.sourceEndLine
                      : chunk.endLine + delta,
                })),
              );
            } finally {
              release();
            }
          }
          complete.set(
            node.id,
            await store.finishNode(node.id, input.contentHash, reusable.chunks),
          );
          reusedNodes++;
          continue;
        }
        if (!isShortLabel(node.label) && STRUCTURAL_LABELS.has(node.label)) {
          try {
            const names = await extractStructuralNames(node.content, node.filePath);
            node.methodNames = names.methodNames;
            node.fieldNames = names.fieldNames;
          } catch {
            /* Same optional structural enrichment as the legacy pipeline. */
          }
        }
        const state = { contentHash: input.contentHash, chunks: 0, ended: false };
        generated.set(node.id, state);
        const chunks = isShortLabel(node.label)
          ? [
              {
                text: node.content,
                chunkIndex: 0,
                startLine: node.startLine ?? 0,
                endLine: node.endLine ?? 0,
              },
            ]
          : iterateNodeChunks(
              node.label,
              node.content,
              node.filePath,
              node.startLine ?? 0,
              node.endLine ?? 0,
              config.chunkSize,
              config.overlap,
            );
        let prevTail = '';
        for await (const chunk of chunks) {
          if (failed.has(node.id) || abort) break;
          const text = generateEmbeddingText(node, chunk.text, config, chunk.chunkIndex, prevTail);
          for (const inputText of splitEmbeddingText(text, config.maxInputChars)) {
            const bytes = rowBytes(inputText.length, node.id.length);
            if (
              batch.length &&
              (batch.length >= maximumBatchRows || budget.usedBytes + bytes > budget.limit)
            )
              await flush();
            if (failed.has(node.id) || abort) break;
            const release = budget.reserve(bytes);
            // A sliced string can pin an entire oversized generated declaration.
            // UTF-16 detachment preserves even unpaired surrogate code units.
            const detached =
              text.length > config.maxInputChars
                ? Buffer.from(inputText, 'utf16le').toString('utf16le')
                : inputText;
            batch.push({
              ...input,
              chunkIndex: state.chunks++,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              text: detached,
              release,
            });
          }
          prevTail = config.overlap > 0 ? chunk.text.slice(-config.overlap) : '';
        }
        state.ended = !failed.has(node.id) && !abort;
        node.methodNames = undefined;
        node.fieldNames = undefined;
        if (abort) break;
      }
      if (!abort) await flush();
      const finished = [...generated]
        .filter(([id, node]) => node.ended && !failed.has(id))
        .map(([nodeId, node]) => ({ nodeId, contentHash: node.contentHash, chunks: node.chunks }));
      if (finished.length)
        for (const receipt of await store.finishNodes(finished))
          complete.set(receipt.nodeId, receipt);
      if (complete.size) {
        if (options.revalidateStoredInputs)
          await store.markSelected(journal.snapshot().identity, [...complete.keys()]);
        await store.checkpointUnit([...complete.values()]);
      }
      if (complete.size === unit.nodes.length) {
        await journal.acknowledge({
          reusedNodes,
          chunks: [...complete.values()].reduce((n, r) => n + r.chunks, 0),
        });
      } else await journal.fail(failureCause);
      progress();
      if (abort) throw abort;
    } finally {
      for (const row of batch) row.release();
      releaseScratch();
      fetched.release();
    }
  };

  const replay = async (intent: EmbeddingUnitIntent): Promise<void> => {
    const units = readEmbeddingWorkUnits(directory, manifest, intent.start);
    try {
      const first = await units.next();
      if (
        first.done ||
        first.value.next.offset !== intent.next.offset ||
        first.value.unit.nodes.length !== intent.nodes
      )
        throw new Error('Embedding recovery intent does not match the manifest');
      await processUnit(first.value.unit, intent);
    } finally {
      await units.return(undefined);
    }
  };

  if (journal.snapshot().phase === 'embedding') {
    const active = journal.snapshot().active;
    if (active) await replay(active);
    for await (const intent of journal.failed()) await replay(intent);
    let cursor = journal.snapshot().cursor;
    for await (const { unit, next } of readEmbeddingWorkUnits(directory, manifest, cursor)) {
      await processUnit(unit, {
        start: cursor,
        next,
        nodes: unit.nodes.length,
        origin: 'manifest',
      });
      cursor = next;
    }
    if (journal.snapshot().failedUnits)
      return { state: journal.snapshot(), peakQueueBytes: budget.peakBytes };
    await journal.indexing();
    progress();
  }
  signal?.throwIfAborted();
  if (options.revalidateStoredInputs && !store.isSealed)
    await store.pruneUnselected(journal.snapshot().identity, manifest.totalNodes);
  signal?.throwIfAborted();
  const indexKind = await store.seal(manifest.totalNodes, journal.snapshot().chunks);
  return { state: journal.snapshot(), peakQueueBytes: budget.peakBytes, indexKind };
}
