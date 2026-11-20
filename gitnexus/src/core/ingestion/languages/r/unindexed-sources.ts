/**
 * R files of a repository that the index does not cover, for the rename guard.
 *
 * The indexer skips whole directories (`bin/`, `build/`, `tmp/`, ...), `.gitignore`d paths and
 * files over its size cap, and indexes only `.R`/`.r` files, so a script there that calls a
 * function would keep the old name after a rename. R itself still runs such files (`Rscript
 * bin/run.R`, `.Rprofile`, the `.S`/`.q`/`.s` code files R installs from `R/`). The rename preview
 * reloads its configuration (`refreshResolutionConfig`), which records each such file with the
 * identifier tokens it contains (tokens, not text, to keep the retained plan small); the guard
 * refuses a rename whose old name one of them uses, and the plan's resolution snapshot makes an
 * edit of such a file between preview and apply a `resolution_changed`.
 */
import { constants as fsConstants, type Dirent } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import ignore, { type Ignore } from 'ignore';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { walkNamedNodes } from '../rename-tree-sitter.js';
import { rBareName } from './bare-name.js';
import { rStringValue } from './export-pattern.js';
import { getRParser } from './query.js';

export interface RUnindexedSource {
  /** POSIX path relative to the repository root. */
  readonly path: string;
  /** The distinct identifier tokens of the file, sorted (backticks removed). */
  readonly words: readonly string[];
  /** The file is over {@link MAX_UNINDEXED_R_SOURCE_BYTES} or could not be read. */
  readonly unreadable?: true;
}

/** Larger files are not read; the guard then fails closed. */
export const MAX_UNINDEXED_R_SOURCE_BYTES = 8 * 1024 * 1024;

/** A repository-relative path as graph File nodes spell it: forward slashes, no leading `./`. */
export function rPosixRelativePath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

/** `.R`/`.r` files, `.Rprofile`, and the `.S`/`.q`/`.s` code files under an `R/` directory. */
export function isRSourcePath(relative: string): boolean {
  const base = relative.slice(relative.lastIndexOf('/') + 1);
  return (
    /\.[Rr]$/.test(base) || base === '.Rprofile' || /(^|\/)R\/(.*\/)?[^/]*\.[Sqs]$/.test(relative)
  );
}

/**
 * Directories that hold no code of this repository: version control, the index store, installed
 * packages (`node_modules`, `renv/library`, `packrat/lib*`) and `R CMD check` output (`*.Rcheck`,
 * which holds a copy of the package's own sources).
 */
function isSkippedDirectory(relative: string): boolean {
  const segments = relative.split('/');
  const name = segments[segments.length - 1];
  const parent = segments[segments.length - 2];
  return (
    name === '.git' ||
    name === '.gitnexus' ||
    name === 'node_modules' ||
    name.endsWith('.Rcheck') ||
    (parent === 'renv' && name === 'library') ||
    (parent === 'packrat' && name.startsWith('lib'))
  );
}

/** Identifier tokens: plain names (`helper`, `.helper`, `to.json`) and backticked ones. */
const TOKEN = /`([^`\n]+)`|[\p{L}.][\p{L}\p{M}\p{N}._]*/gu;

function tokens(text: string): string[] {
  const words = new Set<string>();
  const collectWords = (value: string) => {
    for (const match of value.matchAll(TOKEN)) words.add(match[1] ?? match[0]);
  };
  if (!/["'`#]/.test(text)) {
    collectWords(text);
  } else {
    const root = parseSourceSafe(getRParser(), text).rootNode;
    if (root.hasError) throw new Error('incomplete R syntax');
    for (const node of walkNamedNodes(root)) {
      if (node.type === 'identifier') {
        words.add(rBareName(node.text));
      } else if (node.type === 'string') {
        const value = rStringValue(node.text);
        if (value === null) throw new Error('unrecognized R string');
        // A whole string can name a binding, including a backticked name with spaces.
        words.add(value);
        // Keep possible code strings. Plain words separated only by spaces are prose.
        if (!/^[\p{L}\p{N}._]+(?:[ \t]+[\p{L}\p{N}._]+)+$/u.test(value)) collectWords(value);
      } else if (node.type === 'comment' && /^#'\s*@/.test(node.text)) {
        collectWords(node.text);
      }
    }
  }
  return [...words].sort();
}

/** The repository's `.gitnexusignore` rules (the user's explicit "not mine"), if any. */
async function gitnexusIgnore(repoRoot: string): Promise<Ignore | undefined> {
  try {
    // If the rules exceed the read budget, keep checking every unindexed R source.
    const text = await readRegularFile(
      path.join(repoRoot, '.gitnexusignore'),
      MAX_UNINDEXED_R_SOURCE_BYTES,
    );
    return text === undefined ? undefined : ignore().add(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads `file` through one handle, so the checks and the read cannot see the file change type.
 * Returns `undefined` when it is not a regular file (a symbolic link, a directory, a FIFO) or is
 * larger than `maxBytes`; rejects when it cannot be opened or read.
 *
 * POSIX: the kernel refuses a final symbolic link (`O_NOFOLLOW`) and the open does not block on a
 * FIFO (`O_NONBLOCK`); the type and size come from the handle's own `stat`, so they are exact.
 * Windows has neither flag: the handle's `stat` still rejects directories and oversize files, and
 * an `lstat` after the open rejects a symbolic link, but a link swapped in between the open and
 * the `lstat` is a narrow window this does not close (same as `readNestedGitignore`). No device
 * or inode comparison is made, because Windows reports different `dev` values for `stat(path)`
 * and `fstat(fd)`.
 */
async function readRegularFile(file: string, maxBytes: number): Promise<string | undefined> {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK = 0 } = fsConstants;
  const handle = await fs.open(file, O_RDONLY | (O_NOFOLLOW ?? 0) | O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) return undefined;
    if (O_NOFOLLOW === undefined) {
      const link = await fs.lstat(file);
      if (!link.isFile()) return undefined;
    }
    // Bounded read: the file may have grown since the `stat`, so read at most `maxBytes + 1`
    // bytes in chunks and treat anything over `maxBytes` as unreadable.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(64 * 1024, maxBytes + 1 - total);
      if (want <= 0) return undefined;
      const chunk = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(chunk, 0, want, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return undefined;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Every regular R file under `repoRoot` that is not in `indexedPaths`, with its tokens. The walk
 * does not follow symbolic links, skips the directories of {@link isSkippedDirectory} and what
 * `.gitnexusignore` excludes, and deliberately ignores the indexer's built-in ignore list,
 * `.gitignore` and its size cap (those are what hide the files). Sorted by path.
 */
export async function collectRUnindexedSources(
  repoRoot: string,
  indexedPaths: readonly string[],
): Promise<RUnindexedSource[]> {
  const indexed = new Set(indexedPaths.map(rPosixRelativePath));
  const ignored = await gitnexusIgnore(repoRoot);
  const result: RUnindexedSource[] = [];
  const pending: string[] = [''];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.join(repoRoot, directory), { withFileTypes: true });
    } catch {
      // It may hold R files: fail closed.
      result.push({ path: directory, words: [], unreadable: true });
      continue;
    }
    for (const entry of entries) {
      const relative = directory === '' ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isSkippedDirectory(relative) || ignored?.ignores(`${relative}/`)) continue;
        pending.push(relative);
        continue;
      }
      if (!entry.isFile() || !isRSourcePath(relative) || indexed.has(relative)) continue;
      if (ignored?.ignores(relative)) continue;
      const absolute = path.join(repoRoot, relative);
      try {
        const text = await readRegularFile(absolute, MAX_UNINDEXED_R_SOURCE_BYTES);
        result.push(
          text === undefined
            ? { path: relative, words: [], unreadable: true }
            : { path: relative, words: tokens(text) },
        );
      } catch {
        result.push({ path: relative, words: [], unreadable: true });
      }
    }
  }
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
