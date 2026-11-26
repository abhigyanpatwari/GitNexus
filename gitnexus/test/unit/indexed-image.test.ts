/**
 * `filesIndexedAsPreImage` (#4136): which side of each modified file's diff the
 * index holds, decided from `meta.fileHashes` against a real git repository.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { parseDiffWithPreImage } from '../../src/storage/git.js';
import { filesIndexedAsPreImage } from '../../src/storage/indexed-image.js';
import { diffArgsFor } from '../helpers/detect-changes-diff-args.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

const tempDirs = createTempDirPool('gnx-indexed-image-');
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

const BEFORE = 'a\nb\nc\n';
const AFTER = 'a\nc\n';

/** A repo with `f.ts` committed as BEFORE and edited to AFTER. */
function editedRepo(configure?: (dir: string) => void): string {
  const dir = tempDirs.dir();
  initGitRepo(dir);
  configure?.(dir);
  writeFileSync(path.join(dir, 'f.ts'), BEFORE);
  commitAll(dir, 'init');
  writeFileSync(path.join(dir, 'f.ts'), AFTER);
  return dir;
}

async function preImageFiles(dir: string, scope: string, fileHashes: Record<string, string>) {
  const diff = execFileSync('git', diffArgsFor(scope), { cwd: dir, encoding: 'utf-8' });
  const { files, preImages } = parseDiffWithPreImage(diff);
  const picked = await filesIndexedAsPreImage(dir, scope, fileHashes, files, preImages);
  return files.filter((f) => picked.has(f)).map((f) => f.filePath);
}

describe('filesIndexedAsPreImage', () => {
  it('picks the old side when the index holds the analyzed pre-image', async () => {
    const dir = editedRepo();
    expect(await preImageFiles(dir, 'unstaged', { 'f.ts': sha256(BEFORE) })).toEqual(['f.ts']);
  });

  it('keeps the new side when the index already holds the edit', async () => {
    const dir = editedRepo();
    expect(await preImageFiles(dir, 'unstaged', { 'f.ts': sha256(AFTER) })).toEqual([]);
  });

  it('keeps the new side when the index holds neither image or has no hash', async () => {
    const dir = editedRepo();
    expect(await preImageFiles(dir, 'unstaged', { 'f.ts': sha256('other\n') })).toEqual([]);
    expect(await preImageFiles(dir, 'unstaged', {})).toEqual([]);
  });

  it('compares the staged blob, not the working tree, for staged scope', async () => {
    const dir = editedRepo();
    execFileSync('git', ['add', 'f.ts'], { cwd: dir });
    writeFileSync(path.join(dir, 'f.ts'), 'unrelated working-tree edit\n');
    expect(await preImageFiles(dir, 'staged', { 'f.ts': sha256(BEFORE) })).toEqual(['f.ts']);
    expect(await preImageFiles(dir, 'staged', { 'f.ts': sha256(AFTER) })).toEqual([]);
  });

  it('hashes the checked-out bytes under core.autocrlf, as analyze read them', async () => {
    const dir = editedRepo((d) =>
      execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: d }),
    );
    // Re-checkout so the committed file is written through the EOL filter.
    execFileSync('git', ['checkout', '-q', 'HEAD', '--', 'f.ts'], { cwd: dir });
    const analyzed = readFileSync(path.join(dir, 'f.ts'));
    writeFileSync(path.join(dir, 'f.ts'), AFTER.replace(/\n/g, '\r\n'));
    expect(await preImageFiles(dir, 'unstaged', { 'f.ts': sha256(analyzed) })).toEqual(['f.ts']);
  });
});
