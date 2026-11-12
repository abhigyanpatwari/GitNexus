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
import type { Dirent } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import ignore, { type Ignore } from 'ignore';

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
const TOKEN = /`([^`\n]+)`|[A-Za-z.][A-Za-z0-9._]*/g;

function tokens(text: string): string[] {
  const words = new Set<string>();
  for (const match of text.matchAll(TOKEN)) words.add(match[1] ?? match[0]);
  return [...words].sort();
}

/** The repository's `.gitnexusignore` rules (the user's explicit "not mine"), if any. */
async function gitnexusIgnore(repoRoot: string): Promise<Ignore | undefined> {
  try {
    const file = path.join(repoRoot, '.gitnexusignore');
    if (!(await fs.lstat(file)).isFile()) return undefined;
    return ignore().add(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
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
        if ((await fs.stat(absolute)).size > MAX_UNINDEXED_R_SOURCE_BYTES) {
          result.push({ path: relative, words: [], unreadable: true });
          continue;
        }
        result.push({ path: relative, words: tokens(await fs.readFile(absolute, 'utf8')) });
      } catch {
        result.push({ path: relative, words: [], unreadable: true });
      }
    }
  }
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
