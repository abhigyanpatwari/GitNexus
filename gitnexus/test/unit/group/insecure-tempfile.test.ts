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
import { writeBridgeMeta, readBridgeMeta } from '../../../src/core/group/bridge-db.js';
import type { ContractRegistry, BridgeMeta } from '../../../src/core/group/types.js';

// ---------------------------------------------------------------------------
// Structural: source files use randomBytes, not Date.now(), for temp paths
// ---------------------------------------------------------------------------

describe('insecure tempfile — structural guards (#1318 U6)', () => {
  let bridgeSource: string;
  let storageSource: string;
  let fsAtomicSource: string;

  beforeAll(async () => {
    bridgeSource = await fsp.readFile(
      path.join(__dirname, '..', '..', '..', 'src', 'core', 'group', 'bridge-db.ts'),
      'utf-8',
    );
    storageSource = await fsp.readFile(
      path.join(__dirname, '..', '..', '..', 'src', 'core', 'group', 'storage.ts'),
      'utf-8',
    );
    // The single-file writers below delegate their tmp-path handling to the
    // shared primitive (#2888), so the randomBytes/'wx'/0o600 guards now
    // belong to it.
    fsAtomicSource = await fsp.readFile(
      path.join(__dirname, '..', '..', '..', 'src', 'storage', 'fs-atomic.ts'),
      'utf-8',
    );
  });

  it('fs-atomic.ts imports randomBytes from crypto', () => {
    expect(fsAtomicSource).toMatch(/import\s*\{[^}]*randomBytes[^}]*\}\s*from\s*'crypto'/);
  });

  it('bridge-db.ts uses mkdtemp staging directory for bridge.lbug', () => {
    // Follow-up to the original randomBytes pattern: stage inside a
    // mkdtemp-created directory so the suffix is OS-supplied, the
    // directory contents are empty by construction, and concurrent
    // writers cannot collide. The bridge.lbug filename inside that
    // directory is fixed; uniqueness comes from the directory name.
    expect(bridgeSource).toMatch(/fsp\.mkdtemp\(path\.join\(groupDir,\s*['"]bridge-tmp-['"]\)\)/);
    expect(bridgeSource).toMatch(/path\.join\(stagingDir,\s*['"]bridge\.lbug['"]\)/);
  });

  it('fs-atomic.ts uses randomBytes for every atomic-write temp path', () => {
    expect(fsAtomicSource).toMatch(/\.tmp\.\$\{randomBytes\(8\)\.toString\('hex'\)\}/);
  });

  it('fs-atomic.ts opens the tmp file via fsp.open(..., "wx", 0o600)', () => {
    // O_EXCL via `'wx'` flag closes the symlink-race; explicit `0o600`
    // mode closes the permissions exposure CodeQL's
    // `isSecureMode` predicate inspects (low 6 bits must be zero).
    // Both arguments are required to fully clear the
    // `js/insecure-temporary-file` alert — flags alone are ignored by
    // the analyzer, mode alone leaves the symlink window open. The
    // resulting file mode and the tmp cleanup are asserted for real in
    // test/unit/storage/fs-atomic.test.ts.
    expect(fsAtomicSource).toMatch(/fsp\.open\(tmpPath,\s*['"]wx['"],\s*0o600\)/);
  });

  it('bridge-db.ts publishes meta.json through the shared primitive', () => {
    expect(bridgeSource).toMatch(/writeFileAtomic\(path\.join\(groupDir,\s*['"]meta\.json['"]\),/);
    // No private tmp path left in this module's meta.json writer.
    expect(bridgeSource).not.toMatch(/const tmp = `\$\{target\}\.tmp/);
  });

  it('bridge-db.ts does not use Date.now() in any active temp path', () => {
    // Strip block AND line comments first so the historical
    // "prior `${target}.tmp.${Date.now()}` shape." explanation does not
    // register as an active call site. Block strip runs first so a future
    // multi-line `/* ...Date.now()... */` doc comment is also handled.
    const codeOnly = bridgeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const tmpDateNow = codeOnly.match(/\.tmp\.\$\{Date\.now\(\)\}/g) ?? [];
    expect(tmpDateNow.length).toBe(0);
  });

  it('bridge-db.ts removes the mkdtemp staging directory in finally', () => {
    // Whether writeBridge succeeds or throws, the random staging dir
    // must be cleaned up — otherwise the group dir accumulates
    // bridge-tmp-* directories. The removal is idempotent (force: true).
    expect(bridgeSource).toMatch(
      /fsp\.rm\(stagingDir,\s*\{[^}]*recursive:\s*true[^}]*force:\s*true/,
    );
  });

  it('storage.ts publishes contracts.json through the shared primitive', () => {
    // Was a local `tmpSuffix()` helper duplicating the same randomBytes +
    // 'wx' + 0o600 + retryRename sequence; the sequence now lives once in
    // fs-atomic.ts, guarded above (#2888). The Date.now() guard this module
    // used to carry is gone with its temp path — it has none to get wrong.
    expect(storageSource).toMatch(/writeFileAtomic\(path\.join\(groupDir,\s*CONTRACTS_FILE\),/);
    const codeOnly = storageSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(codeOnly).not.toMatch(/\.tmp/);
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

// ---------------------------------------------------------------------------
// Behavioural: writeBridgeMeta atomic write leaves no tmp files
// ---------------------------------------------------------------------------

describe('insecure tempfile — writeBridgeMeta behavioural (#1318 U6)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-u6-meta-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleMeta: BridgeMeta = {
    version: 1,
    generatedAt: '2026-05-06T00:00:00Z',
    missingRepos: ['repo-x'],
  };

  it('writeBridgeMeta leaves no .tmp files after completion', async () => {
    await writeBridgeMeta(tmpDir, sampleMeta);

    const files = await fsp.readdir(tmpDir);
    const tmpFiles = files.filter((f) => f.includes('.tmp.'));
    expect(tmpFiles).toEqual([]);
  });

  it('writeBridgeMeta writes correct data to meta.json', async () => {
    await writeBridgeMeta(tmpDir, sampleMeta);

    const loaded = await readBridgeMeta(tmpDir);
    expect(loaded.version).toBe(1);
    expect(loaded.generatedAt).toBe('2026-05-06T00:00:00Z');
    expect(loaded.missingRepos).toEqual(['repo-x']);
  });

  it('concurrent writeBridgeMeta calls do not collide', async () => {
    await Promise.all([
      writeBridgeMeta(tmpDir, { ...sampleMeta, generatedAt: 'A' }),
      writeBridgeMeta(tmpDir, { ...sampleMeta, generatedAt: 'B' }),
    ]);

    const loaded = await readBridgeMeta(tmpDir);
    expect(['A', 'B']).toContain(loaded.generatedAt);
  });
});
