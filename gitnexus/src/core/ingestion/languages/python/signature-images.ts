import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readSafeBounded } from '../../../group/extractors/fs-utils.js';
import { isPythonSourceFile } from './query-provider.js';

const run = promisify(execFile);
const timeout = 15_000;
const sourceLimit = 4 * 1024 * 1024;
// A missing file is an ordinary addition/deletion. An unavailable file leaves
// the compatibility check incomplete in every image.
export type Image = string | null | undefined;

export async function readImage(
  cwd: string,
  rev: string | undefined,
  file: string,
): Promise<Image> {
  if (rev === undefined) {
    const text = await readSafeBounded(cwd, file, sourceLimit);
    if (text !== null) return text;
    const relative = path.relative(cwd, path.resolve(cwd, file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    try {
      await lstat(path.resolve(cwd, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    }
    return undefined;
  }
  try {
    return (
      await run('git', ['cat-file', 'blob', rev + ':' + file], {
        cwd,
        timeout,
        maxBuffer: sourceLimit,
        env: { ...process.env, LC_ALL: 'C' },
      })
    ).stdout;
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 128) {
      // Git also uses 128 for corrupt objects and invalid revisions. Only a
      // missing path in an otherwise valid image is a normal addition/deletion.
      return /^fatal: path '[\s\S]*' (?:does not exist|exists on disk, but not in)/.test(
        (error as { stderr?: string }).stderr ?? '',
      )
        ? null
        : undefined;
    }
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return undefined;
    throw error;
  }
}

// Use the line-delimited protocol supported by older Git versions. Exceptional
// paths containing line breaks are read with a single argv-based lookup.
function gitBatch(
  cwd: string,
  option: string,
  specs: string[],
  maxBuffer: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['cat-file', option],
      { cwd, timeout, maxBuffer, encoding: 'buffer' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(specs.join('\n') + '\n');
  });
}

// cat-file also returns "missing" for an unmerged index or an inaccessible
// object. Only the selected tree/index can confirm an ordinary absent path.
async function confirmedMissing(cwd: string, rev: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  try {
    const list = rev
      ? ['ls-tree', '-z', '--full-tree', '--name-only', rev]
      : ['ls-files', '-z', '--cached'];
    const { stdout } = await run('git', ['--literal-pathspecs', ...list, '--', ...paths], {
      cwd,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
    const present = new Set(stdout.split('\0'));
    return paths.filter((file) => !present.has(file));
  } catch {
    return [];
  }
}

export async function* callerImages(
  cwd: string,
  rev: string | undefined,
  files: string[],
): AsyncGenerator<[string, Image]> {
  const size = rev === undefined ? 8 : 128;
  for (let i = 0; i < files.length; i += size) {
    const group = files.slice(i, i + size);
    if (rev === undefined) {
      const images = await Promise.all(group.map((file) => readImage(cwd, rev, file)));
      for (const [index, file] of group.entries()) yield [file, images[index]];
      continue;
    }
    const regular = group.filter((file) => !/[\r\n]/.test(file));
    const lines = regular.length
      ? (
          await gitBatch(
            cwd,
            '--batch-check',
            regular.map((file) => rev + ':' + file),
            2 * 1024 * 1024,
          )
        )
          .toString()
          .split('\n')
      : [];
    const headers = new Map<string, { oid: string; bytes: number } | null>();
    const missing: string[] = [];
    for (const [index, file] of regular.entries()) {
      const header = /^([a-f\d]+) blob (\d+)$/.exec(lines[index]);
      if (header && Number(header[2]) <= sourceLimit)
        headers.set(file, { oid: header[1], bytes: Number(header[2]) });
      else if (lines[index]?.endsWith(' missing')) missing.push(file);
    }
    for (const file of await confirmedMissing(cwd, rev, missing)) headers.set(file, null);
    // Emit in request order, including missing and unusual paths, so two
    // revisions can be compared in lockstep without retaining whole images.
    for (let index = 0; index < group.length; ) {
      const file = group[index];
      const header = headers.get(file);
      if (!header) {
        const missing = header === null ? null : undefined;
        yield [file, /[\r\n]/.test(file) ? await readImage(cwd, rev, file) : missing];
        index++;
        continue;
      }
      const batch: { file: string; oid: string; bytes: number }[] = [];
      let bytes = 0;
      while (index < group.length) {
        const header = headers.get(group[index]);
        if (!header || bytes + header.bytes > sourceLimit) break;
        batch.push({ file: group[index++], ...header });
        bytes += header.bytes;
      }
      // Object IDs pin content to the sizes just checked even if the index moves.
      const contents = await gitBatch(
        cwd,
        '--batch',
        batch.map((blob) => blob.oid),
        bytes + 128 * batch.length,
      );
      let offset = 0;
      for (const blob of batch) {
        const headerEnd = contents.indexOf(10, offset);
        if (
          headerEnd < offset ||
          contents.toString('ascii', offset, headerEnd) !== `${blob.oid} blob ${blob.bytes}`
        ) {
          throw new Error('Incomplete Git response while reading Python caller images');
        }
        offset = headerEnd + 1;
        yield [blob.file, contents.toString('utf8', offset, offset + blob.bytes)];
        offset += blob.bytes + 1;
      }
    }
  }
}

/** Preserve rename pairs while keeping only a bounded batch from each revision in memory. */
export async function* definitionImages(
  cwd: string,
  before: string,
  after: string | undefined,
  paths: string[],
  oldPaths: ReadonlyMap<string, string>,
): AsyncGenerator<[string, Image, Image]> {
  if (paths.length === 1) {
    const file = paths[0];
    const [oldText, newText] = await Promise.all([
      readImage(cwd, before, oldPaths.get(file) ?? file),
      readImage(cwd, after, file),
    ]);
    yield [file, oldText, newText];
    return;
  }
  const old = callerImages(
    cwd,
    before,
    paths.map((file) => oldPaths.get(file) ?? file),
  );
  try {
    for await (const [file, newText] of callerImages(cwd, after, paths)) {
      const entry = await old.next();
      if (entry.done || entry.value[0] !== (oldPaths.get(file) ?? file))
        throw new Error('Git returned mismatched definition paths');
      yield [file, entry.value[1], newText];
    }
  } finally {
    await old.return(undefined);
  }
}

export interface PythonModuleFiles {
  /** Paths used by the import resolver, which probes a literal .py suffix. */
  paths: Set<string>;
  /** Original Git spelling of a nonstandard suffix, or null for competing spellings. */
  mixedCasePaths: Map<string, string | null>;
}

// ls-tree cannot filter by extension. Discard non-Python paths as they arrive
// so a huge unrelated tree cannot overflow execFile's stdout buffer.
export async function pythonFiles(
  cwd: string,
  revision: string | undefined,
): Promise<PythonModuleFiles | null> {
  const args = revision
    ? ['ls-tree', '-rz', '--name-only', revision]
    : [
        'ls-files',
        '-z',
        '--cached',
        ...(revision === undefined ? ['--others', '--exclude-standard'] : []),
        // Custom pathspec modes can change the wildcard or its directory reach.
        ...(process.env.GIT_LITERAL_PATHSPECS ||
        process.env.GIT_NOGLOB_PATHSPECS ||
        process.env.GIT_GLOB_PATHSPECS
          ? []
          : ['--', '*.[pP][yY]']),
      ];
  const child = spawn('git', args, { cwd, timeout, stdio: ['ignore', 'pipe', 'ignore'] });
  const files = new Set<string>();
  const mixedCasePaths = new Map<string, string | null>();
  let pathBytes = 0;
  let pathCount = 0;
  let limited = false;
  const collect = async () => {
    let pending = '';
    child.stdout.setEncoding('utf8');
    for await (const chunk of child.stdout) {
      const parts = (pending + chunk).split('\0');
      pending = parts.pop() ?? '';
      for (const file of parts) {
        if (!isPythonSourceFile(file)) continue;
        pathBytes += Buffer.byteLength(file);
        if (++pathCount > 250_000 || pathBytes > 32 * 1024 * 1024) {
          limited = true;
          child.kill();
          return;
        }
        if (file.endsWith('.py')) {
          // The exact module wins even if a case variant appeared earlier in Git's listing.
          files.add(file);
          mixedCasePaths.delete(file);
        } else {
          const modulePath = file.slice(0, -3) + '.py';
          if (!files.has(modulePath)) {
            files.add(modulePath);
            mixedCasePaths.set(modulePath, file);
          } else if (mixedCasePaths.has(modulePath) && mixedCasePaths.get(modulePath) !== file) {
            mixedCasePaths.set(modulePath, null);
          }
        }
      }
    }
  };
  const [[code]] = await Promise.all([once(child, 'close'), collect()]);
  if (limited || code !== 0) return null;
  return { paths: files, mixedCasePaths };
}
