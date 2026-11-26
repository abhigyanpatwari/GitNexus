import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { expect } from 'expect';
import { copyBuildOutput } from '../../../scenario-map/path-coverage/partitions.js';

it('gives inventory guards a private index without sharing Git configuration or writes', (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-git-inventory-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const checkout = path.join(base, 'checkout');
  const prepared = path.join(base, 'prepared');
  for (const root of [checkout, prepared]) {
    mkdirSync(path.join(root, 'gitnexus'), { recursive: true });
    writeFileSync(path.join(root, 'gitnexus', 'case.ts'), 'export const value = 1;');
  }
  writeFileSync(path.join(checkout, 'public-manifest.json'), '{}');
  writeFileSync(path.join(checkout, '.env'), 'fixture-only-private-value');
  writeFileSync(path.join(prepared, 'gitnexus', 'case.ts'), 'export const value = 2;');
  execFileSync('git', ['init', '--quiet', checkout]);
  const git = (root: string, ...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git(checkout, 'add', '--force', '--', 'gitnexus/case.ts', 'public-manifest.json', '.env');
  git(checkout, 'remote', 'add', 'origin', 'https://example.com/source.git');
  copyBuildOutput('normal', path.join(checkout, 'gitnexus'), path.join(prepared, 'gitnexus'));
  expect(git(prepared, 'rev-parse', '--show-toplevel')).toBe(prepared.split(path.sep).join('/'));
  expect(git(prepared, 'ls-files', '--stage')).toBe(
    git(checkout, 'ls-files', '--stage', '--', 'gitnexus/case.ts', 'public-manifest.json'),
  );
  expect(git(prepared, 'remote')).toBe('');
  expect(existsSync(path.join(prepared, '.env'))).toBe(false);
  expect(readFileSync(path.join(prepared, 'public-manifest.json'), 'utf8')).toBe('{}');
  expect(readFileSync(path.join(prepared, 'gitnexus', 'case.ts'), 'utf8')).toContain('value = 2');
  git(prepared, 'update-index', '--force-remove', 'gitnexus/case.ts');
  expect(git(checkout, 'ls-files').split('\n')).toEqual([
    '.env',
    'gitnexus/case.ts',
    'public-manifest.json',
  ]);
});
