/**
 * Read a folder that was dragged and dropped onto the analyzer.
 *
 * The `webkitdirectory` picker hands us a `FileList` whose entries carry
 * `webkitRelativePath` (`<folder>/<rest>`). A drop hands us
 * `DataTransferItem`s instead, and the `File`s behind them report an empty
 * `webkitRelativePath`, so the tree has to be walked with the File and
 * Directory Entries API (`webkitGetAsEntry`). This module does that walk and
 * returns real `File` objects shaped exactly like the picker's, so the result
 * goes through the unchanged `filterRepoFiles -> uploadFolder` path and the
 * server sees the same manifest either way.
 *
 * Two platform constraints shape the API:
 *  - `dataTransfer.items` is readable only synchronously inside the drop
 *    handler, so `collectDropEntries` is sync and must run before the first
 *    `await`; `readDroppedFolder` does the async walk afterwards.
 *  - `FileSystemDirectoryReader.readEntries` returns batches (Chromium caps a
 *    batch at 100 entries) and signals the end with an empty array, so it is
 *    called in a loop.
 *
 * Directories on the shared exclusion list are pruned before they are read:
 * `node_modules` is never enumerated, which is the point of dropping over
 * picking on a large checkout (the picker enumerates everything first and
 * only then filters).
 */

import { EXCLUDED_DIRS, MAX_FILE_BYTES } from './upload-filter';

/** Matches the server's `maxFiles` (DEFAULT_INGEST_LIMITS in upload-ingest.ts). */
export const MAX_DROP_FILES = 20000;

/**
 * Matches the server's MAX_PATH_DEPTH: a manifest entry may have at most 64
 * `/`-separated segments including the folder name and the file name.
 */
export const MAX_PATH_SEGMENTS = 64;

/** How many files are collected between two `onProgress` calls. */
const PROGRESS_EVERY = 50;

export type DropRejectionReason = 'unsupported' | 'notSingleFolder' | 'tooManyFiles';

/** Thrown when a drop cannot be turned into a single-folder upload. */
export class DropRejection extends Error {
  constructor(
    readonly reason: DropRejectionReason,
    readonly max?: number,
  ) {
    super(`Folder drop rejected: ${reason}`);
    this.name = 'DropRejection';
  }
}

export interface ReadDroppedFolderOptions {
  signal?: AbortSignal;
  /** Called with the running number of files collected so far. */
  onProgress?: (filesFound: number) => void;
}

export interface DroppedFolder {
  /** Every file under the dropped folder, `webkitRelativePath` set to `<folder>/<rest>`. */
  files: File[];
  /**
   * Directories left out of `files`: pruned because their name is on the
   * exclusion list, deeper than the server accepts, or unreadable. Their
   * contents were never enumerated, so this is a directory count, not a file
   * count. Unreadable single files are counted here as well.
   */
  skipped: number;
  /**
   * Readable files omitted because they exceed MAX_FILE_BYTES. They do not
   * count toward MAX_DROP_FILES; the drop summary adds this to droppedCount
   * so it matches the picker (filterRepoFiles) skip count.
   */
  oversized: number;
}

/**
 * True when the browser can hand out directory entries for a drop. A missing
 * `DataTransferItem` global (test environments) counts as supported; only an
 * engine that has the class without `webkitGetAsEntry` cannot read folders.
 */
export function isFolderDropSupported(): boolean {
  return (
    typeof DataTransferItem === 'undefined' || 'webkitGetAsEntry' in DataTransferItem.prototype
  );
}

/**
 * Take the `FileSystemEntry` of every dropped item. Synchronous on purpose:
 * call it first thing in the drop handler, before any `await`. Throws
 * `DropRejection('unsupported')` when the browser has no `webkitGetAsEntry`;
 * the picker button keeps working there.
 */
export function collectDropEntries(dataTransfer: DataTransfer): FileSystemEntry[] {
  const items = dataTransfer.items;
  if (!items || items.length === 0) return [];
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item.webkitGetAsEntry !== 'function') throw new DropRejection('unsupported');
    const entry = item.webkitGetAsEntry();
    // Non-file items (dragged text, URLs) yield null and are simply ignored.
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Walk exactly one dropped directory into `File`s. Rejects with
 * `DropRejection('notSingleFolder')` for loose files, no folder, or several
 * roots (the server accepts one top-level folder per upload), with
 * `DropRejection('tooManyFiles')` past MAX_DROP_FILES, and with the signal's
 * reason (an `AbortError`) when aborted mid-walk.
 */
export async function readDroppedFolder(
  entries: FileSystemEntry[],
  { signal, onProgress }: ReadDroppedFolderOptions = {},
): Promise<DroppedFolder> {
  if (entries.length !== 1 || !entries[0].isDirectory) {
    throw new DropRejection('notSingleFolder');
  }
  const root = entries[0] as FileSystemDirectoryEntry;
  const files: File[] = [];
  let skipped = 0;
  let oversized = 0;

  // A folder that is itself named like build output (`dist`, `out`, ...) would
  // lose every file to filterRepoFiles anyway (the root is a path segment
  // too); answer without walking it.
  if (EXCLUDED_DIRS.has(root.name)) return { files, skipped: 1, oversized: 0 };

  const throwIfAborted = () => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  };
  const report = (count: number) => {
    if (!signal?.aborted) onProgress?.(count);
  };

  // Paths are joined from entry names, never taken from `entry.fullPath`: the
  // result is `<root>/<rest>` with forward slashes in every browser and never
  // carries a leading slash, which the server rejects.
  const walk = async (dir: FileSystemDirectoryEntry, prefix: string, segments: number) => {
    // Files inside this directory would have `segments + 1` path segments.
    if (segments + 1 > MAX_PATH_SEGMENTS) {
      skipped++;
      return;
    }
    const reader = dir.createReader();
    for (;;) {
      throwIfAborted();
      let batch: FileSystemEntry[];
      try {
        batch = await readBatch(reader);
      } catch {
        // An unreadable subtree (permissions) is skipped, like the picker
        // silently omits files it cannot read; the rest of the drop proceeds.
        skipped++;
        return;
      }
      if (batch.length === 0) return;
      for (const child of batch) {
        throwIfAborted();
        const rel = `${prefix}/${child.name}`;
        if (child.isDirectory) {
          if (EXCLUDED_DIRS.has(child.name)) {
            skipped++;
            continue;
          }
          await walk(child as FileSystemDirectoryEntry, rel, segments + 1);
        } else if (child.isFile) {
          let file: File;
          try {
            file = await getFile(child as FileSystemFileEntry);
          } catch {
            // Deleted or renamed mid-walk, a dangling symlink, a locked file:
            // skip it the same way an unreadable directory is skipped.
            skipped++;
            continue;
          }
          throwIfAborted();
          // Do not push oversized files: they used to count toward
          // MAX_DROP_FILES, so a tree the picker accepts (20k keepers +
          // oversized siblings) was rejected as tooManyFiles. Count them so
          // the drop summary's droppedCount still matches the picker.
          if (file.size > MAX_FILE_BYTES) {
            oversized++;
            continue;
          }
          // A dropped File reports '' here while the picker reports
          // `<folder>/<rest>`. An own property shadows the prototype getter, so
          // filterRepoFiles (and therefore the server) sees one shape.
          Object.defineProperty(file, 'webkitRelativePath', { value: rel, configurable: true });
          files.push(file);
          if (files.length > MAX_DROP_FILES) {
            throw new DropRejection('tooManyFiles', MAX_DROP_FILES);
          }
          if (files.length % PROGRESS_EVERY === 0) report(files.length);
        }
      }
    }
  };

  await walk(root, root.name, 1);
  throwIfAborted();
  report(files.length);
  return { files, skipped, oversized };
}

const readBatch = (reader: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));

const getFile = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));
