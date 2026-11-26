import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { resolveSharedStore, type SharedStoreLayout } from '../../src/storage/shared-store.js';

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();

export function commitAll(cwd: string, message: string): void {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
}

export function layoutOf(checkout: string): SharedStoreLayout {
  const layout = resolveSharedStore(checkout);
  assert.ok(layout, 'Expected a shared store for ' + checkout);
  return layout;
}

export const listCommitDirs = async (layout: SharedStoreLayout): Promise<string[]> =>
  (await fs.readdir(layout.commitsDir).catch(() => [] as string[])).filter(
    (name) => !name.startsWith('.'),
  );
