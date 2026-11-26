/**
 * `classifyIndexedImages` (#4136): which side of each modified file's diff the
 * index holds, decided from `meta.fileHashes` against a real git repository.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { parseDiffWithPreImage } from '../../src/storage/git.js';
import { classifyIndexedImages } from '../../src/storage/indexed-image.js';
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

async function classify(dir: string, scope: string, fileHashes: Record<string, string>) {
  const diff = execFileSync('git', diffArgsFor(scope), { cwd: dir, encoding: 'utf-8' });
  const { files, preImages } = parseDiffWithPreImage(diff);
  const { preImage, neither } = await classifyIndexedImages(
    dir,
    scope,
    fileHashes,
    files,
    preImages,
  );
  return {
    pre: files.filter((f) => preImage.has(f)).map((f) => f.filePath),
    neither: neither.map((f) => f.filePath),
  };
}

describe('classifyIndexedImages', () => {
  it('picks the old side when the index holds the analyzed pre-image', async () => {
    const dir = editedRepo();
    expect(await classify(dir, 'unstaged', { 'f.ts': sha256(BEFORE) })).toEqual({
      pre: ['f.ts'],
      neither: [],
    });
  });

  it('keeps the new side when the index already holds the edit', async () => {
    const dir = editedRepo();
    expect(await classify(dir, 'unstaged', { 'f.ts': sha256(AFTER) })).toEqual({
      pre: [],
      neither: [],
    });
  });

  it('reports a file whose recorded hash matches neither side', async () => {
    const dir = editedRepo();
    expect(await classify(dir, 'unstaged', { 'f.ts': sha256('other\n') })).toEqual({
      pre: [],
      neither: ['f.ts'],
    });
  });

  it('makes no claim about a file with no recorded hash (legacy metadata)', async () => {
    const dir = editedRepo();
    expect(await classify(dir, 'unstaged', {})).toEqual({ pre: [], neither: [] });
  });

  it('does not read an inherited object key as a recorded hash', async () => {
    const dir = tempDirs.dir();
    initGitRepo(dir);
    writeFileSync(path.join(dir, 'constructor'), BEFORE);
    commitAll(dir, 'init');
    writeFileSync(path.join(dir, 'constructor'), AFTER);
    // Parsed from JSON like real metadata, so `constructor` is inherited.
    const fileHashes = JSON.parse(JSON.stringify({ 'f.ts': sha256(BEFORE) }));
    expect(await classify(dir, 'unstaged', fileHashes)).toEqual({ pre: [], neither: [] });
  });

  it('hashes the old side under the pre-rename path', async () => {
    const dir = tempDirs.dir();
    initGitRepo(dir);
    const lines = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`);
    const before = lines.join('\n') + '\n';
    writeFileSync(path.join(dir, 'old.ts'), before);
    commitAll(dir, 'init');
    execFileSync('git', ['mv', 'old.ts', 'new.ts'], { cwd: dir });
    writeFileSync(path.join(dir, 'new.ts'), before.replace('v5 = 5', 'v5 = 55'));
    execFileSync('git', ['add', 'new.ts'], { cwd: dir });
    // The index was built before the rename: only the old path has a hash.
    expect(await classify(dir, 'staged', { 'old.ts': sha256(before) })).toEqual({
      pre: ['new.ts'],
      neither: [],
    });
  });

  it('compares the staged blob, not the working tree, for staged scope', async () => {
    const dir = editedRepo();
    execFileSync('git', ['add', 'f.ts'], { cwd: dir });
    writeFileSync(path.join(dir, 'f.ts'), 'unrelated working-tree edit\n');
    expect((await classify(dir, 'staged', { 'f.ts': sha256(BEFORE) })).pre).toEqual(['f.ts']);
    expect(await classify(dir, 'staged', { 'f.ts': sha256(AFTER) })).toEqual({
      pre: [],
      neither: [],
    });
  });

  it('hashes the checked-out bytes under core.autocrlf, as analyze read them', async () => {
    const dir = editedRepo((d) =>
      execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: d }),
    );
    // Re-checkout so the committed file is written through the EOL filter.
    execFileSync('git', ['checkout', '-q', 'HEAD', '--', 'f.ts'], { cwd: dir });
    const analyzed = readFileSync(path.join(dir, 'f.ts'));
    writeFileSync(path.join(dir, 'f.ts'), AFTER.replace(/\n/g, '\r\n'));
    expect((await classify(dir, 'unstaged', { 'f.ts': sha256(analyzed) })).pre).toEqual(['f.ts']);
  });
});
