import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';

export const gitExecutable = (() => {
  if (process.platform !== 'win32') return 'git';
  try {
    return (
      execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean) ?? 'git'
    );
  } catch {
    return 'git';
  }
})();

const isolatedTmpRoot = (() => {
  const root =
    process.platform === 'win32'
      ? path.join(path.parse(os.tmpdir()).root, 'gitnexus-outside-git')
      : path.join(os.tmpdir(), 'gitnexus-outside-git');
  fs.mkdirSync(root, { recursive: true });
  return root;
})();

export const makeIsolatedTempDir = (prefix = 'gitnexus-test-'): string =>
  fs.mkdtempSync(path.join(isolatedTmpRoot, prefix));

export function makeIsolatedGitRepo(): string {
  const dir = makeIsolatedTempDir('gn-dirty-');
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  // Set a stable identity so commit doesn't fail on environments without
  // global git config (CI containers, fresh sandboxes).
  execSync('git config user.email t@t', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name t', { cwd: dir, stdio: 'ignore' });
  return dir;
}
