/**
 * Shared mini-repo fixture setup for `runFullAnalysis`-level integration
 * tests (incremental-orchestration, pdg-mode-flip). Copies the
 * `test/fixtures/mini-repo/src` files into a fresh git-initialized temp
 * directory so each test owns a real repo with a real history. Extracted
 * from incremental-orchestration.test.ts when pdg-mode-flip.test.ts became
 * its second verbatim consumer (#2099) — the fixture file list must live in
 * exactly one place.
 */

import { execSync } from 'child_process';
import { copyFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTempDir } from './test-db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.resolve(HERE, '..', 'fixtures', 'mini-repo', 'src');

const MINI_REPO_FILES = [
  'index.ts',
  'handler.ts',
  'validator.ts',
  'formatter.ts',
  'middleware.ts',
  'logger.ts',
  'db.ts',
];

/**
 * Copy the mini-repo fixture into a fresh git-initialized temp directory.
 * Returns the temp handle so the caller owns cleanup.
 */
export async function setupMiniRepo(
  prefix = 'gitnexus-mini-repo-',
): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
  const tmp = await createTempDir(prefix);
  const dest = path.join(tmp.dbPath, 'src');
  await mkdir(dest, { recursive: true });
  for (const n of MINI_REPO_FILES) {
    await copyFile(path.join(FIXTURE_SRC, n), path.join(dest, n));
  }
  execSync('git init', { cwd: tmp.dbPath, stdio: 'pipe' });
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A', {
    cwd: tmp.dbPath,
    stdio: 'pipe',
  });
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m initial', {
    cwd: tmp.dbPath,
    stdio: 'pipe',
  });
  return tmp;
}
