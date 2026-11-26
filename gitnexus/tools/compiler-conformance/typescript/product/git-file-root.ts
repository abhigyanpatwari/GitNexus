import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { findGitRootByDotGit } from '../../../../src/storage/git.js';

it('finds the Git root from a source file without starting a subprocess', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-fileinput-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exec = t.mock.method(childProcess, 'execSync');
  syncBuiltinESMExports();
  t.after(() => {
    exec.mock.restore();
    syncBuiltinESMExports();
  });

  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'pkg'));
  const source = path.join(root, 'pkg', 'index.ts');
  fs.writeFileSync(source, 'export {};\n');
  assert.equal(findGitRootByDotGit(source), path.resolve(root));
  assert.equal(exec.mock.callCount(), 0);
});
