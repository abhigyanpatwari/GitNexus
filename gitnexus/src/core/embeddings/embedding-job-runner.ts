/** One durable manifest unit, one bounded provider batch, no corpus-sized maps. */
import { createHash } from 'node:crypto';
import { EmbeddingByteBudget } from '../analysis-resource-budget.js';
import type { VectorNodeReceipt, VectorStore, VectorWriteChunk } from '../lbug/vector-store.js';
import {
  embeddingInputFailureKey,
  type EmbeddingJobJournal,
  type EmbeddingJobState,
  type EmbeddingUnitIntent,
} from '../../storage/embedding-job-journal.js';
import {
  fetchEmbeddingWorkUnit,
  readEmbeddingWorkUnits,
  type EmbeddingManifestReceipt,
  type EmbeddingManifestSource,
  type EmbeddingWorkUnit,
} from './embedding-work-manifest.js';
import { contentHashForNode, embedInputRanges, isInputRejection } from './embedding-pipeline.js';
import { iterateEmbeddingInputs, type EmbeddingReuseOptions } from './embedding-inputs.js';
import {
  EmbeddingSourceReader,
  needsEmbeddingSource,
  type EmbeddingSourceContext,
} from './source-reader.js';
import { resolveEmbeddingConfig } from './config.js';
import { type EmbeddingConfig, type EmbeddableNode } from './types.js';
import type { embedBatch } from './embedder.js';

export interface EmbeddingReuseSource {
  options: { batchBytes: number };
  requiresInputValidation?: boolean;
  reusable(
    nodeId: string,
    contentHash: string,
    options: EmbeddingReuseOptions,
  ): Promise<VectorNodeReceipt | null>;
  readChunks: VectorStore['readChunks'];
}

export interface EmbeddingJobRunnerOptions {
  directory: string;
  manifest: EmbeddingManifestReceipt;
  source: EmbeddingManifestSource;
  sourceContext?: EmbeddingSourceContext;
  journal: EmbeddingJobJournal;
  store: VectorStore;
  /** The controller has validated vector/input identities before providing reuse. */
  reuse?: EmbeddingReuseSource;
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
  let sourceReader: EmbeddingSourceReader | undefined;
  let releaseSourceCache: (() => void) | undefined;
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
    const active = journal.snapshot().active ?? intent;
    const history = active.inputFailures ?? {};
    const excluded = new Set<string>();
    if (Object.keys(history).length) {
      const nodesByKey = new Map(
        unit.nodes.map((node) => [
          active.inputFailureKeyFormat === 'sha256' ? embeddingInputFailureKey(node.id) : node.id,
          node.id,
        ]),
      );
      for (const [key, attempts] of Object.entries(history)) {
        const id = nodesByKey.get(key);
        if (id === undefined)
          throw new Error('Embedding rejection history does not match its manifest unit');
        if (attempts >= 3) excluded.add(id);
      }
    }
    const complete = options.revalidateStoredInputs
      ? new Map<string, VectorNodeReceipt>()
      : await store.completedNodes(unit.nodes.map((node) => node.id));
    for (const id of excluded) complete.delete(id);
    const missing = unit.nodes.filter((node) => !complete.has(node.id) && !excluded.has(node.id));
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
    const minimumUnitBatchBytes = rowBytes(config.maxInputChars, maxIdChars);
    const unitBytes = retainedBytes + scratchBytes + minimumUnitBatchBytes;
    if (releaseSourceCache && budget.usedBytes + unitBytes > budget.limit) {
      sourceReader = undefined;
      releaseSourceCache();
      releaseSourceCache = undefined;
    }
    if (budget.usedBytes + unitBytes > budget.limit)
      throw new Error(
        `Embedding unit ${unit.ordinal} requires a larger resource budget; no source text was truncated`,
      );
    if (!journal.snapshot().active) await journal.begin(intent);
    if (excluded.size) await store.excludeNodes([...excluded]);
    progress();
    if (!missing.length) {
      if (complete.size) await store.checkpointUnit([...complete.values()]);
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
    // Retained vector copies share one bounded write buffer, whether their
    // source is a reusable artifact or a newly completed provider request.
    let copyBatch: VectorWriteChunk[] = [];
    let copyBytes = 0;
    let copyReleases: Array<() => void> = [];
    const generated = new Map<
      string,
      { contentHash: string; chunks: number; ended: boolean; inputsDigest?: string }
    >();
    const failed = new Set<string>();
    const rejectedInputs = new Set<string>();
    let failureCause: 'input' | 'provider' = 'input';
    let abort: unknown;
    let reusedNodes = complete.size;

    const flushCopies = async (): Promise<void> => {
      if (!copyBatch.length) return;
      signal?.throwIfAborted();
      try {
        await store.appendBatch(copyBatch);
      } finally {
        for (const release of copyReleases) release();
        copyBatch = [];
        copyBytes = 0;
        copyReleases = [];
      }
    };

    const queueWrites = async (chunks: VectorWriteChunk[]): Promise<void> => {
      const bytes = chunks.reduce(
        (total, chunk) => total + 32 * dimensions + 1024 + 4 * chunk.nodeId.length,
        0,
      );
      if (
        copyBatch.length &&
        (copyBatch.length + chunks.length > 256 ||
          copyBytes + bytes > store.options.batchBytes ||
          budget.usedBytes + bytes > budget.limit)
      )
        await flushCopies();
      // The active provider batch already reserves these vector copies. A
      // tight queue can write immediately without a second retained reservation.
      if (bytes > store.options.batchBytes || budget.usedBytes + bytes > budget.limit) {
        await store.appendBatch(chunks);
        return;
      }
      const release = budget.reserve(bytes);
      copyBatch.push(...chunks);
      copyBytes += bytes;
      copyReleases.push(release);
    };

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
              for (const row of rows) rejectedInputs.add(row.nodeId);
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
          if (updates.length) await queueWrites(updates);
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

    const prepareInputValidation = options.reuse?.requiresInputValidation
      ? async () => {
          // Release a provider batch only when a matching legacy group needs
          // input expansion. Ineligible groups keep normal provider batching.
          await flush();
          if (abort) throw abort;
        }
      : undefined;

    const nodeInputs = (node: EmbeddableNode) =>
      iterateEmbeddingInputs(node, config, {
        source: options.sourceContext,
        signal,
        readSource: async (indexedNode) => {
          const sourceContext = options.sourceContext;
          if (!sourceContext) throw new Error('Missing indexed embedding source context');
          let release: (() => void) | undefined;
          let admissionAbort: unknown;
          try {
            if (!sourceReader) {
              let cacheBytes = Math.min(16 * 1024 * 1024, Math.floor(budget.limit / 8));
              if (budget.usedBytes + cacheBytes + minimumUnitBatchBytes > budget.limit) {
                await flush();
                await flushCopies();
              }
              if (abort) {
                admissionAbort = abort;
                throw abort;
              }
              cacheBytes = Math.min(
                cacheBytes,
                Math.max(0, budget.limit - budget.usedBytes - minimumUnitBatchBytes),
              );
              releaseSourceCache = budget.reserve(cacheBytes);
              sourceReader = new EmbeddingSourceReader(sourceContext, cacheBytes);
            }
            const reader = sourceReader;
            const content = await reader.read(indexedNode, async (fileBytes) => {
              signal?.throwIfAborted();
              // Whole-file decoding/line index, notebook reconstruction, AST and
              // projected declarations live until this node's iterator closes.
              const bytes = 64 * 1024 + 16 * fileBytes;
              if (budget.usedBytes + bytes + minimumUnitBatchBytes > budget.limit) {
                await flush();
                await flushCopies();
              }
              if (abort) {
                admissionAbort = abort;
                throw abort;
              }
              if (
                releaseSourceCache &&
                budget.usedBytes + bytes + minimumUnitBatchBytes > budget.limit
              ) {
                reader.disableCache();
                releaseSourceCache();
                releaseSourceCache = undefined;
              }
              if (
                !Number.isSafeInteger(bytes) ||
                budget.usedBytes + bytes + minimumUnitBatchBytes > budget.limit
              )
                throw new Error(
                  'Original embedding source requires a larger resource budget; no source text was truncated',
                );
              release = budget.reserve(bytes);
            });
            if (!release) throw new Error('Original embedding source was not admitted');
            return { content, release };
          } catch (error) {
            release?.();
            if (admissionAbort) throw admissionAbort;
            throw error;
          }
        },
      });

    const sourceAware = (node: EmbeddableNode) =>
      options.sourceContext?.contentRetention === 'full' && needsEmbeddingSource(node, config);
    const inputHasher = () =>
      createHash('sha1').update('embedding-inputs:v1\n').update(JSON.stringify(config.modelId));

    try {
      // Hash once per fetched node; current-job complete groups never fetch/hash.
      const inputs = fetched.nodes.map((node) => ({
        nodeId: node.id,
        contentHash: contentHashForNode(node, config, options.sourceContext),
        sourceStartLine: node.startLine ?? 0,
        sourceEndLine: node.endLine ?? 0,
      }));
      const reusableNodes = new Map<string, VectorNodeReceipt>();
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i],
          node = fetched.nodes[i];
        const baseHash = input.contentHash;
        let digest: string | undefined;
        const matchesHash = async (previous: string): Promise<boolean> => {
          if (!sourceAware(node) || !/^[a-f0-9]{40}:[a-f0-9]{40}$/.test(previous)) return false;
          if (previous.startsWith(`${baseHash}:`)) {
            input.contentHash = previous;
            return true;
          }
          if (!digest) {
            const hash = inputHasher();
            for await (const part of nodeInputs(node))
              hash.update(JSON.stringify([part.text, part.startLine, part.endLine]));
            digest = hash.digest('hex');
          }
          if (!previous.endsWith(`:${digest}`)) return false;
          input.contentHash = `${baseHash}:${digest}`;
          return true;
        };
        if (options.revalidateStoredInputs) {
          const retained = await store.reuseNode(input, async (previous) =>
            (await matchesHash(previous)) ? input.contentHash : undefined,
          );
          if (retained) {
            complete.set(input.nodeId, retained);
            reusedNodes++;
            continue;
          }
        }
        const reusable = await options.reuse?.reusable(node.id, input.contentHash, {
          node,
          prepareInputValidation,
          inputs: () => nodeInputs(node),
          matchesHash,
        });
        if (reusable) reusableNodes.set(node.id, reusable);
        else input.contentHash = baseHash;
      }
      const missingInputs = options.revalidateStoredInputs
        ? inputs.filter((input) => !complete.has(input.nodeId))
        : inputs;
      if (missingInputs.length) await store.beginNodes(missingInputs);
      const copied: Array<{ nodeId: string; contentHash: string; chunks: number }> = [];
      for (let i = 0; i < fetched.nodes.length; i++) {
        const node = fetched.nodes[i];
        const input = inputs[i];
        signal?.throwIfAborted();
        if (options.revalidateStoredInputs && complete.has(node.id)) continue;
        const reuse = options.reuse;
        const reusable = reusableNodes.get(node.id);
        if (reusable && reuse) {
          // Flush before copy so there is only one vector batch in memory.
          await flush();
          if (abort) break;
          const copyRowBytes = 32 * dimensions + 1024 + 4 * node.id.length;
          for (let start = 0; start < reusable.chunks; ) {
            if (
              copyBatch.length &&
              (copyBatch.length === 256 ||
                Math.min(store.options.batchBytes - copyBytes, budget.limit - budget.usedBytes) <
                  copyRowBytes)
            )
              await flushCopies();
            const copyRows = Math.min(
              256 - copyBatch.length,
              Math.floor(
                Math.min(
                  reuse.options.batchBytes,
                  store.options.batchBytes - copyBytes,
                  budget.limit - budget.usedBytes,
                ) / copyRowBytes,
              ),
            );
            if (copyRows < 1)
              throw new Error('Reusable vector batch does not fit the resource budget');
            const length = Math.min(copyRows, reusable.chunks - start);
            // Reuse has no HTTP body or JSON decoder; retain only vector copies.
            const bytes = length * copyRowBytes;
            const release = budget.reserve(bytes);
            try {
              const chunks = await reuse.readChunks(reusable, start, length);
              const delta = input.sourceStartLine - (reusable.sourceStartLine ?? 0);
              copyBatch.push(
                ...chunks.map((chunk) => ({
                  ...chunk,
                  nodeId: node.id,
                  contentHash: input.contentHash,
                  startLine: chunk.startLine + delta,
                  endLine:
                    chunk.endLine === reusable.sourceEndLine
                      ? input.sourceEndLine
                      : chunk.endLine + delta,
                })),
              );
            } catch (error) {
              release();
              throw error;
            }
            copyReleases.push(release);
            copyBytes += bytes;
            start += length;
          }
          copied.push({ nodeId: node.id, contentHash: input.contentHash, chunks: reusable.chunks });
          reusedNodes++;
          continue;
        }
        const state = {
          contentHash: input.contentHash,
          chunks: 0,
          ended: false,
          inputsDigest: undefined as string | undefined,
        };
        generated.set(node.id, state);
        const hash = sourceAware(node) ? inputHasher() : undefined;
        try {
          for await (const generatedInput of nodeInputs(node)) {
            if (failed.has(node.id) || abort) break;
            hash?.update(
              JSON.stringify([
                generatedInput.text,
                generatedInput.startLine,
                generatedInput.endLine,
              ]),
            );
            const bytes = rowBytes(generatedInput.text.length, node.id.length);
            if (
              batch.length &&
              (batch.length >= maximumBatchRows || budget.usedBytes + bytes > budget.limit)
            )
              await flush();
            if (failed.has(node.id) || abort) break;
            if (copyBatch.length && budget.usedBytes + bytes > budget.limit) await flushCopies();
            const release = budget.reserve(bytes);
            batch.push({
              ...input,
              chunkIndex: state.chunks++,
              ...generatedInput,
              release,
            });
          }
        } catch (error) {
          // Source admission can flush a provider batch and raise this unit's
          // abort. Persist completed peers and rejection attempts before exit.
          if (!abort || error !== abort) throw error;
        }
        state.ended = !failed.has(node.id) && !abort;
        if (state.ended) state.inputsDigest = hash?.digest('hex');
        if (abort) break;
      }
      if (!abort) await flush();
      if (copyBatch.length) await flushCopies();
      const attempts = await journal.recordInputRejections([...rejectedInputs]);
      for (const id of rejectedInputs) {
        if (attempts[id] < 3) continue;
        await store.excludeNodes([id]);
        excluded.add(id);
        generated.delete(id);
        failed.delete(id);
      }
      const finished = [
        ...[...generated]
          .filter(([id, node]) => node.ended && !failed.has(id))
          .map(([nodeId, node]) => ({
            nodeId,
            contentHash: node.contentHash,
            chunks: node.chunks,
            inputsDigest: node.inputsDigest,
          })),
        ...copied,
      ];
      if (finished.length)
        for (const receipt of await store.finishNodes(finished))
          complete.set(receipt.nodeId, receipt);
      if (complete.size) {
        if (options.revalidateStoredInputs)
          await store.markSelected(journal.snapshot().identity, [...complete.keys()]);
        await store.checkpointUnit([...complete.values()]);
      }
      if (complete.size + excluded.size === unit.nodes.length) {
        await journal.acknowledge({
          reusedNodes,
          chunks: [...complete.values()].reduce((n, r) => n + r.chunks, 0),
        });
      } else await journal.fail(failureCause);
      progress();
      if (abort) throw abort;
    } finally {
      for (const row of batch) row.release();
      for (const release of copyReleases) release();
      releaseScratch();
      fetched.release();
      // A later, smaller unit can use the optional cache again.
      if (!releaseSourceCache) sourceReader = undefined;
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

  try {
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
      await store.pruneUnselected(
        journal.snapshot().identity,
        manifest.totalNodes - (journal.snapshot().excludedNodes ?? 0),
      );
    signal?.throwIfAborted();
    const indexKind = await store.seal(
      manifest.totalNodes - (journal.snapshot().excludedNodes ?? 0),
      journal.snapshot().chunks,
    );
    return { state: journal.snapshot(), peakQueueBytes: budget.peakBytes, indexKind };
  } finally {
    sourceReader = undefined;
    releaseSourceCache?.();
  }
}
