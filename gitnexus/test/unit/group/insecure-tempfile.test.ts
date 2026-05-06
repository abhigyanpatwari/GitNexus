/**
 * Security tests for insecure tempfile remediation (#1318 U6).
 *
 * CodeQL js/insecure-temporary-file flags predictable temp filenames
 * (e.g. Date.now() suffix) because an attacker with write access to
 * the same directory can win a symlink race. The fix replaces all
 * predictable suffixes with crypto.randomBytes(8).
 *
 * Two layers:
 *   1. Structural — source-grep confirms randomBytes, not Date.now().
 *   2. Behavioural — writeContractRegistry produces no leftover tmp files
 *      and the final file is correctly written.
 */
import { beforeAll, describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeContractRegistry, readContractRegistry } from '../../../src/core/group/storage.js';
import type { ContractRegistry } from '../../../src/core/group/types.js';

// ---------------------------------------------------------------------------
// Structural: source files use randomBytes, not Date.now(), for temp paths
// ---------------------------------------------------------------------------

describe('insecure tempfile — structural guards (#1318 U6)', () => {
  let bridgeSource: string;
  let storageSource: string;

  beforeAll(async () => {
    bridgeSource = await fsp.readFile(
      path.join(__dirname, '..', '..', '..', 'src', 'core', 'group', 'bridge-db.ts'),
      'utf-8',
    );
    storageSource = await fsp.readFile(
      path.join(__dirname, '..', '..', '..', 'src', 'core', 'group', 'storage.ts'),
      'utf-8',
    );
  });

  it('bridge-db.ts imports randomBytes from node:crypto', () => {
    expect(bridgeSource).toMatch(/import\s*\{[^}]*randomBytes[^}]*\}\s*from\s*'node:crypto'/);
  });

  it('bridge-db.ts uses randomBytes for bridge.lbug temp path', () => {
    expect(bridgeSource).toMatch(/bridge\.lbug\.tmp\.\$\{randomBytes/);
  });

  it('bridge-db.ts uses randomBytes for meta.json temp path', () => {
    expect(bridgeSource).toMatch(/\.tmp\.\$\{randomBytes\(8\)\.toString\('hex'\)\}/);
  });

  it('bridge-db.ts does not use Date.now() in any temp path', () => {
    // Match Date.now() specifically in tmp-path contexts — not in unrelated code.
    const tmpDateNow = bridgeSource.match(/\.tmp\.\$\{Date\.now\(\)\}/g) ?? [];
    expect(tmpDateNow.length).toBe(0);
  });

  it('storage.ts imports randomBytes from node:crypto', () => {
    expect(storageSource).toMatch(/import\s*\{[^}]*randomBytes[^}]*\}\s*from\s*'node:crypto'/);
  });

  it('storage.ts uses randomBytes for contracts.json temp path', () => {
    expect(storageSource).toMatch(/\.tmp\.\$\{randomBytes\(8\)\.toString\('hex'\)\}/);
  });

  it('storage.ts does not use Date.now() in any temp path', () => {
    const tmpDateNow = storageSource.match(/\.tmp\.\$\{Date\.now\(\)\}/g) ?? [];
    expect(tmpDateNow.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Behavioural: writeContractRegistry atomic write leaves no tmp files
// ---------------------------------------------------------------------------

describe('insecure tempfile — behavioural (#1318 U6)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-u6-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleRegistry: ContractRegistry = {
    version: 1,
    generatedAt: '2026-05-06T00:00:00Z',
    repoSnapshots: {},
    missingRepos: [],
    contracts: [],
    crossLinks: [],
  };

  it('writeContractRegistry leaves no .tmp files after completion', async () => {
    await writeContractRegistry(tmpDir, sampleRegistry);

    const files = await fsp.readdir(tmpDir);
    const tmpFiles = files.filter((f) => f.includes('.tmp.'));
    expect(tmpFiles).toEqual([]);
  });

  it('writeContractRegistry writes correct data to final path', async () => {
    await writeContractRegistry(tmpDir, sampleRegistry);

    const loaded = await readContractRegistry(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.generatedAt).toBe('2026-05-06T00:00:00Z');
  });

  it('concurrent writes do not collide (randomBytes prevents same-ms race)', async () => {
    // Fire two writes simultaneously — with Date.now() these could collide
    // if they land in the same millisecond. With randomBytes they can't.
    await Promise.all([
      writeContractRegistry(tmpDir, { ...sampleRegistry, generatedAt: 'A' }),
      writeContractRegistry(tmpDir, { ...sampleRegistry, generatedAt: 'B' }),
    ]);

    const loaded = await readContractRegistry(tmpDir);
    expect(loaded).not.toBeNull();
    // One of the two writes wins the rename — we just verify no crash.
    expect(['A', 'B']).toContain(loaded!.generatedAt);
  });
});
