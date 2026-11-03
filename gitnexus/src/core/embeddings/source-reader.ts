import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ContentRetention } from '../../storage/repo-meta.js';
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
  (!isShortLabel(node.label) &&
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
}

const CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_FILES = 64;

/** Per-run, bounded source cache. Constructed only after the fresh-node filter. */
export class EmbeddingSourceReader {
  private readonly files = new Map<string, SourceFile>();
  private bytes = 0;
  private root: Promise<string> | undefined;

  constructor(private readonly source: EmbeddingSourceContext) {}

  async read(node: EmbeddableNode): Promise<string> {
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
      this.files.delete(node.filePath);
      this.files.set(node.filePath, file);
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
        const buffer = await readFile(resolved);
        if (createHash('sha256').update(buffer).digest('hex') !== expectedHash) {
          throw new Error('checkout content differs from the indexed snapshot');
        }
        const content = buffer.toString('utf8');
        const lines = buildLineIndex(content);
        file = { content, lines, bytes: content.length * 2 + lines.byteLength };
        if (file.bytes <= CACHE_BYTES) {
          while (this.files.size >= CACHE_FILES || this.bytes + file.bytes > CACHE_BYTES) {
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
