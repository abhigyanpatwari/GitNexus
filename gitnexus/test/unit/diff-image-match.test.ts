/**
 * `matchIndexedDiffImages`: which side of a diff the index holds, decided by
 * hashing each side the way a checkout writes it and comparing with the
 * SHA-256 `analyze` recorded in `meta.fileHashes`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashRawBlobs, matchIndexedDiffImages } from '../../src/storage/diff-image-match.js';
import { parseDiffHunksResult } from '../../src/storage/git.js';
import { diffArgsFor } from '../helpers/detect-changes-diff-args.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

const SOURCE = [
  'export function first() { return 0; }',
  'export function helper() { return 1; }',
  'export function second() { return 2; }',
  '',
].join('\n');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(autocrlf = 'false'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gnx-image-match-'));
  dirs.push(dir);
  initGitRepo(dir);
  execFileSync('git', ['config', 'core.autocrlf', autocrlf], { cwd: dir });
  return dir;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const hashOnDisk = (dir: string, file: string) => sha256(readFileSync(path.join(dir, file)));

async function classify(dir: string, scope: string, fileHashes: Record<string, string>) {
  const diff = execFileSync('git', diffArgsFor(scope), { cwd: dir, encoding: 'utf8' });
  const { files } = parseDiffHunksResult(diff, { withPreImage: true });
  const images = await matchIndexedDiffImages({ cwd: dir, scope, files, fileHashes });
  return Object.fromEntries(files.map((file) => [file.filePath, images.get(file)]));
}

describe('matchIndexedDiffImages', () => {
  it.each(['unstaged', 'all'])('%s: pre-image when the index predates the edit', async (scope) => {
    const dir = repo();
    writeFileSync(path.join(dir, 'util.ts'), SOURCE);
    commitAll(dir, 'init');
    const indexed = hashOnDisk(dir, 'util.ts');
    writeFileSync(path.join(dir, 'util.ts'), SOURCE.replace(/^.*helper.*\n/m, ''));
    expect(await classify(dir, scope, { 'util.ts': indexed })).toEqual({ 'util.ts': 'pre' });
  });

  it('post-image when the index was rebuilt after the edit', async () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'util.ts'), SOURCE);
    commitAll(dir, 'init');
    writeFileSync(path.join(dir, 'util.ts'), `// header\n${SOURCE}`);
    const indexed = hashOnDisk(dir, 'util.ts');
    expect(await classify(dir, 'unstaged', { 'util.ts': indexed })).toEqual({ 'util.ts': 'post' });
  });

  it('staged: compares the HEAD and index blobs, not the work tree', async () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'util.ts'), SOURCE);
    commitAll(dir, 'init');
    const head = hashOnDisk(dir, 'util.ts');
    const staged = `// staged\n${SOURCE}`;
    writeFileSync(path.join(dir, 'util.ts'), staged);
    execFileSync('git', ['add', 'util.ts'], { cwd: dir });
    // A further unstaged edit must not affect the staged comparison.
    writeFileSync(path.join(dir, 'util.ts'), `// work tree\n${staged}`);
    expect(await classify(dir, 'staged', { 'util.ts': head })).toEqual({ 'util.ts': 'pre' });
    expect(await classify(dir, 'staged', { 'util.ts': sha256(staged) })).toEqual({
      'util.ts': 'post',
    });
  });

  it('neither when the indexed bytes match no side', async () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'util.ts'), SOURCE);
    commitAll(dir, 'init');
    writeFileSync(path.join(dir, 'util.ts'), `// edit\n${SOURCE}`);
    expect(await classify(dir, 'unstaged', { 'util.ts': sha256('something else') })).toEqual({
      'util.ts': 'neither',
    });
  });

  it('leaves files without a recorded hash unclassified (legacy behaviour)', async () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'util.ts'), SOURCE);
    commitAll(dir, 'init');
    writeFileSync(path.join(dir, 'util.ts'), `// edit\n${SOURCE}`);
    expect(await classify(dir, 'unstaged', {})).toEqual({ 'util.ts': undefined });
  });

  it('matches a path with a space and non-ASCII characters', async () => {
    const dir = repo();
    const file = 'dir with space/ütil 文件.ts';
    execFileSync('git', ['config', 'core.quotePath', 'true'], { cwd: dir });
    const abs = path.join(dir, file);
    execFileSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(path.dirname(abs))})`]);
    writeFileSync(abs, SOURCE);
    commitAll(dir, 'init');
    const indexed = hashOnDisk(dir, file);
    writeFileSync(abs, SOURCE.replace(/^.*helper.*\n/m, ''));
    expect(await classify(dir, 'unstaged', { [file]: indexed })).toEqual({ [file]: 'pre' });
  });

  it('core.autocrlf=true: hashes the checked-out CRLF bytes, not the LF blob', async () => {
    const dir = repo('true');
    writeFileSync(path.join(dir, 'util.ts'), SOURCE.replace(/\n/g, '\r\n'));
    commitAll(dir, 'init');
    // What `analyze` read: CRLF on disk, while the blob stores LF.
    const indexed = hashOnDisk(dir, 'util.ts');
    expect(indexed).not.toBe(sha256(SOURCE));
    writeFileSync(
      path.join(dir, 'util.ts'),
      SOURCE.replace(/^.*helper.*\n/m, '').replace(/\n/g, '\r\n'),
    );
    expect(await classify(dir, 'unstaged', { 'util.ts': indexed })).toEqual({ 'util.ts': 'pre' });
  });

  it('runs from a subdirectory of the work tree', async () => {
    const dir = repo();
    execFileSync('node', [
      '-e',
      `require('fs').mkdirSync(${JSON.stringify(path.join(dir, 'sub'))})`,
    ]);
    writeFileSync(path.join(dir, 'util.ts'), SOURCE);
    commitAll(dir, 'init');
    writeFileSync(path.join(dir, 'util.ts'), `// edit\n${SOURCE}`);
    const indexed = hashOnDisk(dir, 'util.ts');
    const diff = execFileSync('git', diffArgsFor('unstaged'), { cwd: dir, encoding: 'utf8' });
    const { files } = parseDiffHunksResult(diff, { withPreImage: true });
    const images = await matchIndexedDiffImages({
      cwd: path.join(dir, 'sub'),
      scope: 'unstaged',
      files,
      fileHashes: { 'util.ts': indexed },
    });
    expect(images.get(files[0])).toBe('post');
  });
});

describe('hashRawBlobs', () => {
  it('hashes stored blob bytes by id and omits objects git cannot produce', async () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'a.ts'), 'alpha\n');
    writeFileSync(path.join(dir, 'b.ts'), '');
    commitAll(dir, 'init');
    const oid = (rev: string) =>
      execFileSync('git', ['rev-parse', rev], { cwd: dir, encoding: 'utf8' }).trim();
    const missing = 'f'.repeat(40);
    // A tree carries a body too; it must be skipped without desyncing the stream.
    const hashes = await hashRawBlobs(dir, [
      oid('HEAD:a.ts'),
      missing,
      oid('HEAD^{tree}'),
      oid('HEAD:b.ts'),
    ]);
    expect(Object.fromEntries(hashes)).toEqual({
      [oid('HEAD:a.ts')]: sha256('alpha\n'),
      [oid('HEAD:b.ts')]: sha256(''),
    });
  });
});
