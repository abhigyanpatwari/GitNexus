import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { slotNameForCanonicalPath } from '../../src/storage/storage-slot.js';

/**
 * #3352 — the Claude hook resolves a shared-store checkout to the commit
 * graph it reads, mirroring `resolveGraphPath` in src/storage/shared-store.ts.
 */
const HOOK_COPIES = [
  path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'registry-query.cjs'),
  path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'gitnexus-claude-plugin',
    'hooks',
    'registry-query.cjs',
  ),
  path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'gitnexus-cursor-integration',
    'hooks',
    'registry-query.cjs',
  ),
  path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'gitnexus-factory-plugin',
    'hooks',
    'registry-query.cjs',
  ),
];

type HookRepo = { storagePath: string; lbugPath: string } | null;
const load = (file: string) =>
  createRequire(import.meta.url)(file) as { findRegisteredRepo: (cwd: string) => HookRepo };

describe('registry-query shared store graph (#3352)', () => {
  let tmp: string;
  let home: string;
  let checkout: string;
  let slot: string;
  let commitGraph: string;
  const savedHome = process.env.GITNEXUS_HOME;
  // Either storage override takes precedence over the registry row in the hook.
  const savedStoragePath = process.env.GITNEXUS_STORAGE_PATH;
  const savedStorageRoot = process.env.GITNEXUS_STORAGE_ROOT;

  const writeSlot = (meta: Record<string, unknown>) => {
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(
      path.join(slot, 'gitnexus.json'),
      JSON.stringify({ repoPath: checkout, storagePath: slot, lastCommit: 'abc', ...meta }),
    );
  };

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-hook-shared-')));
    home = path.join(tmp, 'home');
    checkout = path.join(tmp, 'wt');
    fs.mkdirSync(checkout, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: checkout, stdio: 'ignore' });
    const store = path.join(home, 'stores', 'repo-0123456789ab');
    slot = path.join(store, 'checkouts', 'wt-0123456789ab');
    commitGraph = path.join(store, 'commits', 'abc1234-deadbeefdeadbeef', 'lbug');
    fs.mkdirSync(path.dirname(commitGraph), { recursive: true });
    fs.writeFileSync(commitGraph, 'graph');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'registry.json'),
      JSON.stringify([
        { name: 'wt', path: checkout, storagePath: slot, indexedAt: '', lastCommit: '' },
      ]),
    );
    process.env.GITNEXUS_HOME = home;
    delete process.env.GITNEXUS_STORAGE_PATH;
    delete process.env.GITNEXUS_STORAGE_ROOT;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    if (savedStoragePath === undefined) delete process.env.GITNEXUS_STORAGE_PATH;
    else process.env.GITNEXUS_STORAGE_PATH = savedStoragePath;
    if (savedStorageRoot === undefined) delete process.env.GITNEXUS_STORAGE_ROOT;
    else process.env.GITNEXUS_STORAGE_ROOT = savedStorageRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps the four hook copies byte-identical', () => {
    const [primary, ...copies] = HOOK_COPIES.map((f) => fs.readFileSync(f, 'utf-8'));
    for (const copy of copies) expect(copy).toBe(primary);
  });

  it.each(HOOK_COPIES)('returns the commit graph a shared slot records (%s)', (file) => {
    writeSlot({ graphPath: commitGraph });
    expect(load(file).findRegisteredRepo(checkout)?.lbugPath).toBe(commitGraph);
  });

  it('returns the slot graph when none is recorded', () => {
    writeSlot({});
    expect(load(HOOK_COPIES[0]).findRegisteredRepo(checkout)?.lbugPath).toBe(
      path.join(slot, 'lbug'),
    );
  });

  it.each([
    ['outside the store', () => '/etc/lbug'],
    ['a sibling slot', () => path.join(path.dirname(slot), 'other-000000000000', 'lbug')],
    ['a relative path', () => 'commits/abc1234-deadbeefdeadbeef/lbug'],
  ])('ignores a recorded graphPath %s', (_label, graphPath) => {
    writeSlot({ graphPath: graphPath() });
    expect(load(HOOK_COPIES[0]).findRegisteredRepo(checkout)?.lbugPath).toBe(
      path.join(slot, 'lbug'),
    );
  });
});

/**
 * #3374 — the hook's slot name must match `slotNameForCanonicalPath` for
 * device-name basenames on both platform branches, or a GITNEXUS_STORAGE_ROOT
 * index is invisible to the hook. The checkout itself is never created (the
 * hook falls back to the resolved path); only the slot is written. A real
 * Windows host cannot create the POSIX-branch slot (`CON.txt-<hash>`), so the
 * stubbed rows run on POSIX hosts, which exercise both branches.
 */
describe.skipIf(process.platform === 'win32')('registry-query slot name parity (#3374)', () => {
  const realPlatform = process.platform;
  const savedHome = process.env.GITNEXUS_HOME;
  const savedStoragePath = process.env.GITNEXUS_STORAGE_PATH;
  const savedStorageRoot = process.env.GITNEXUS_STORAGE_ROOT;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-hook-slot-')));
    process.env.GITNEXUS_HOME = path.join(tmp, 'home');
    process.env.GITNEXUS_STORAGE_ROOT = path.join(tmp, 'root');
    delete process.env.GITNEXUS_STORAGE_PATH;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    if (savedStoragePath === undefined) delete process.env.GITNEXUS_STORAGE_PATH;
    else process.env.GITNEXUS_STORAGE_PATH = savedStoragePath;
    if (savedStorageRoot === undefined) delete process.env.GITNEXUS_STORAGE_ROOT;
    else process.env.GITNEXUS_STORAGE_ROOT = savedStorageRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const basenames = [
    'CON',
    'con.txt',
    'NUL.tar.gz',
    'COM1',
    'LPT9.log',
    'aux',
    'prn.',
    'normal',
    'CONSOLE',
    'com0.txt',
  ];
  const rows = (['win32', 'linux'] as const).flatMap((platform) =>
    basenames.map((basename) => [platform, basename] as const),
  );

  it.each(rows)('on %s resolves the slot storage-slot.ts names for %s', (platform, basename) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    const checkout = path.join(tmp, 'repos', basename);
    const slot = path.join(tmp, 'root', slotNameForCanonicalPath(checkout));
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(
      path.join(slot, 'gitnexus.json'),
      JSON.stringify({ repoPath: checkout, storagePath: slot, lastCommit: 'abc' }),
    );
    fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'home', 'registry.json'),
      JSON.stringify([{ name: basename, path: checkout, indexedAt: '', lastCommit: '' }]),
    );
    expect(load(HOOK_COPIES[0]).findRegisteredRepo(checkout)?.storagePath).toBe(slot);
  });
});
