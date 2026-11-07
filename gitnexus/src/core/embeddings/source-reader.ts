import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ContentRetention } from '../../storage/repo-meta.js';
import { openEmbeddingJobFile } from '../../storage/embedding-job.js';
import { isNotebookPath, notebookPythonSnippet } from '../ingestion/ipynb-extractor.js';
import { buildLineIndex } from './line-index.js';
import {
  DEFAULT_EMBEDDING_CONFIG,
  isShortLabel,
  type EmbeddableNode,
  type EmbeddingConfig,
} from './types.js';

/** Source identity belongs to the indexed snapshot, not the live checkout. */
export interface EmbeddingSourceContext {
  repoPath: string;
  fileHashes: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined;
  contentRetention: ContentRetention;
}

export const needsEmbeddingSource = (
  node: EmbeddableNode,
  config: Partial<EmbeddingConfig>,
): boolean =>
  node.label === 'Class' ||
  // Fallback File content has synthetic ranges over normalized retained text.
  (node.label !== 'File' &&
    !isShortLabel(node.label) &&
    (node.content.length >
      Math.min(
        config.chunkSize ?? DEFAULT_EMBEDDING_CONFIG.chunkSize,
        DEFAULT_EMBEDDING_CONFIG.chunkSize,
      ) ||
      node.content.endsWith('... [truncated]')));

export const indexedSourceHash = (
  source: EmbeddingSourceContext,
  filePath: string,
): string | undefined => {
  const hashes = source.fileHashes;
  if (hashes instanceof Map) return hashes.get(filePath);
  const record = hashes as Readonly<Record<string, string>> | undefined;
  return record && Object.hasOwn(record, filePath) ? record[filePath] : undefined;
};

interface SourceFile {
  content: string;
  lines: Int32Array;
  bytes: number;
  sourceBytes: number;
}

const CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_FILES = 64;

/** Per-run, bounded source cache. Constructed only after the fresh-node filter. */
export class EmbeddingSourceReader {
  private readonly files = new Map<string, SourceFile>();
  private bytes = 0;
  private root: Promise<string> | undefined;

  constructor(
    private readonly source: EmbeddingSourceContext,
    private cacheBytes = CACHE_BYTES,
  ) {}

  /** Release optional retained sources when the caller needs their reservation. */
  disableCache(): void {
    this.files.clear();
    this.bytes = 0;
    this.cacheBytes = 0;
  }

  /** Admission runs before allocation, including on cache hits. The caller
   * holds its reservation until it finishes using/parsing the returned text. */
  async read(
    node: EmbeddableNode,
    admit?: (sourceBytes: number) => Promise<void>,
  ): Promise<string> {
    if (this.source.contentRetention !== 'full') {
      throw new Error('Original embedding source requires full content retention');
    }
    const fail = (reason: string): Error =>
      new Error(
        `Embedding source unavailable for ${node.filePath}: ${reason}. Run gitnexus analyze before generating embeddings.`,
      );
    const expectedHash = indexedSourceHash(this.source, node.filePath);
    if (!expectedHash) throw fail('the index has no file fingerprint');
    const { startLine, endLine } = node;
    if (
      typeof startLine !== 'number' ||
      typeof endLine !== 'number' ||
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 0 ||
      endLine < startLine
    ) {
      throw fail('invalid indexed source range');
    }

    let file = this.files.get(node.filePath);
    if (file) {
      await admit?.(file.sourceBytes);
      this.files.delete(node.filePath);
      if (this.cacheBytes > 0) this.files.set(node.filePath, file);
    } else {
      if (
        !node.filePath ||
        path.isAbsolute(node.filePath) ||
        node.filePath.includes('\\') ||
        node.filePath.split('/').some((part) => !part || part === '..' || part === '.')
      ) {
        throw fail('source path is not repository-relative');
      }
      try {
        const root = await (this.root ??= realpath(this.source.repoPath));
        const resolved = await realpath(path.join(root, node.filePath));
        const relative = path.relative(root, resolved);
        if (
          !relative ||
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          throw new Error('source path leaves the repository');
        }
        const { handle, stat } = await openEmbeddingJobFile(resolved);
        let buffer: Buffer;
        try {
          if (!Number.isSafeInteger(stat.size) || stat.size < 0)
            throw new Error('invalid source file size');
          await admit?.(stat.size);
          // Bound the read to the admitted size, plus one byte to detect growth.
          buffer = Buffer.alloc(stat.size + 1);
          let offset = 0;
          while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          if (offset !== stat.size) throw new Error('source size changed during the read');
          buffer = buffer.subarray(0, offset);
        } finally {
          await handle.close();
        }
        if (createHash('sha256').update(buffer).digest('hex') !== expectedHash) {
          throw new Error('checkout content differs from the indexed snapshot');
        }
        const content = buffer.toString('utf8');
        const lines = buildLineIndex(content);
        file = {
          content,
          lines,
          bytes: content.length * 2 + lines.byteLength,
          sourceBytes: buffer.length,
        };
        if (file.bytes <= this.cacheBytes) {
          while (this.files.size >= CACHE_FILES || this.bytes + file.bytes > this.cacheBytes) {
            const entry = this.files.entries().next().value;
            if (!entry) break;
            const [oldest, cached] = entry;
            this.bytes -= cached.bytes;
            this.files.delete(oldest);
          }
          this.files.set(node.filePath, file);
          this.bytes += file.bytes;
        }
      } catch (error) {
        throw fail(error instanceof Error ? error.message : String(error));
      }
    }

    if (endLine >= file.lines.length) throw fail('source range exceeds the indexed file');
    if (isNotebookPath(node.filePath)) {
      const snippet = notebookPythonSnippet(file.content, startLine, endLine, node.filePath);
      if (snippet === null) throw fail('notebook source range cannot be reconstructed');
      return snippet;
    }
    const start = file.lines[startLine];
    const end = endLine + 1 < file.lines.length ? file.lines[endLine + 1] - 1 : file.content.length;
    return file.content.slice(start, end);
  }
}
