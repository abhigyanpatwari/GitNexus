import { afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { managedRename } from './managed-rename.js';

export function createRenameFixtureHelpers() {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });
  return managedRename(roots);
}
