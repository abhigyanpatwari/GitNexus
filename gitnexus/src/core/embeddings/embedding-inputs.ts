/** Shared streaming input layout for generation and historical-vector validation. */
import { isNotebookPath } from '../ingestion/ipynb-extractor.js';
import { ensureAndParse } from './ast-utils.js';
import { iterateNodeChunks, type EmbeddingChunk } from './chunker.js';
import { extractStructuralNames } from './structural-extractor.js';
import {
  generateEmbeddingText,
  splitEmbeddingText,
  withoutOverlappingContext,
} from './text-generator.js';
import { needsEmbeddingSource, type EmbeddingSourceContext } from './source-reader.js';
import {
  isShortLabel,
  STRUCTURAL_LABELS,
  type EmbeddableNode,
  type EmbeddingConfig,
} from './types.js';

export interface EmbeddingInput {
  text: string;
  startLine: number;
  endLine: number;
}

export interface EmbeddingReuseOptions {
  node: EmbeddableNode;
  prepareInputValidation?: () => Promise<void>;
  inputs?: () => AsyncIterable<EmbeddingInput>;
  matchesHash?: (stored: string) => Promise<boolean>;
}

export async function* iterateEmbeddingInputs(
  indexedNode: EmbeddableNode,
  config: EmbeddingConfig,
  options: {
    source?: EmbeddingSourceContext;
    readSource?: (node: EmbeddableNode) => Promise<{ content: string; release: () => void }>;
    signal?: AbortSignal;
  } = {},
): AsyncGenerator<EmbeddingInput> {
  const hydrate =
    options.source?.contentRetention === 'full' && needsEmbeddingSource(indexedNode, config);
  if (hydrate && !options.readSource)
    throw new Error('Original embedding source needs a budgeted reader');
  const lease = hydrate ? await options.readSource?.(indexedNode) : undefined;
  // Never retain expanded source or structural metadata in the fetched unit.
  const node = { ...indexedNode, content: lease?.content ?? indexedNode.content };
  try {
    options.signal?.throwIfAborted();
    let classTree: Awaited<ReturnType<typeof ensureAndParse>> | undefined;
    if (node.label === 'Class') {
      try {
        classTree = await ensureAndParse(node.content, node.filePath);
      } catch {
        classTree = null;
      }
    }
    if (!isShortLabel(node.label) && STRUCTURAL_LABELS.has(node.label)) {
      try {
        const names = await extractStructuralNames(
          node.content,
          node.filePath,
          classTree,
          node.label === 'Class' ? node.name : undefined,
        );
        node.methodNames = names.methodNames;
        node.fieldNames = names.fieldNames;
      } catch {
        /* Structural enrichment remains optional. */
      }
    }
    const startLine = node.startLine ?? 0,
      endLine = node.endLine ?? 0;
    const chunks: Iterable<EmbeddingChunk> | AsyncIterable<EmbeddingChunk> = isShortLabel(
      node.label,
    )
      ? [
          {
            text: node.content,
            chunkIndex: 0,
            startLine,
            endLine,
            startOffset: 0,
            endOffset: node.content.length,
          },
        ]
      : iterateNodeChunks(
          node.label,
          node.content,
          node.filePath,
          startLine,
          endLine,
          config.chunkSize,
          config.overlap,
          { strategy: config.chunkStrategy, name: node.name, tree: classTree },
        );
    const conservativeRange =
      options.source &&
      (options.source.contentRetention !== 'full' || isNotebookPath(node.filePath));
    let prevTail = '',
      previousEndOffset: number | undefined;
    for await (const chunk of chunks) {
      options.signal?.throwIfAborted();
      node.classDeclaration = chunk.classDeclaration;
      const text = generateEmbeddingText(
        node,
        chunk.text,
        config,
        chunk.chunkIndex,
        withoutOverlappingContext(prevTail, previousEndOffset, chunk.startOffset),
      );
      for (const part of splitEmbeddingText(text, config.maxInputChars)) {
        // Detach slices so queued inputs cannot pin a large declaration/source.
        yield {
          text:
            lease || text.length > config.maxInputChars
              ? Buffer.from(part, 'utf16le').toString('utf16le')
              : part,
          startLine: conservativeRange ? startLine : chunk.startLine,
          endLine: conservativeRange ? endLine : chunk.endLine,
        };
      }
      prevTail = config.overlap > 0 ? chunk.text.slice(-config.overlap) : '';
      previousEndOffset = chunk.endOffset;
    }
  } finally {
    lease?.release();
  }
}
