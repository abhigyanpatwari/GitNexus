import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps the three hook copies byte-identical', () => {
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
