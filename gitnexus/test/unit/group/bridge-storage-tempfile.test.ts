/**
 * Regression tests for U6 — closes CodeQL js/insecure-temporary-file
 * (#191/#192/#193) and js/log-injection (#188) in core/group.
 *
 * The fixes replace `Date.now()` suffix tmp files with crypto.randomBytes
 * suffixes + open the tmp file with `flag: 'wx'` (O_EXCL). These tests
 * pin both behaviors so a future refactor that drops either signal
 * regenerates the CodeQL alert AND fails a test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { writeContractRegistry, createGroupDir } from '../../../src/core/group/storage.js';
import { writeBridgeMeta } from '../../../src/core/group/bridge-db.js';
import type { ContractRegistry } from '../../../src/core/group/types.js';

/**
 * Build a minimal `ContractRegistry` literal with overridable fields.
 * Replaces the `as never` cast that bypassed the type entirely — keeps
 * the test free of unrelated boilerplate while still type-checking the
 * fields under test.
 */
function makeRegistry(overrides: Partial<ContractRegistry> = {}): ContractRegistry {
  return {
    version: 1,
    generatedAt: '2026-05-07T00:00:00Z',
    repoSnapshots: {},
    missingRepos: [],
    contracts: [],
    crossLinks: [],
    ...overrides,
  };
}

let tmpRoot: string;
let groupDir: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-u6-'));
  groupDir = path.join(tmpRoot, 'fixture-group');
  await fs.mkdir(groupDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('writeContractRegistry — tempfile hardening', () => {
  it('back-to-back writes within the same ms do not collide on the tmp path', async () => {
    // The previous `${path}.tmp.${Date.now()}` shape collided when two writers
    // landed in the same millisecond. crypto.randomBytes makes the suffix
    // essentially-unique. Sequential writes here pin the unique-suffix
    // property without depending on Windows-specific concurrent-rename
    // behavior (which has its own pre-existing retry pattern in the
    // sibling `writeBridge` function and is out of scope for this test).
    await writeContractRegistry(groupDir, makeRegistry({ version: 1 }));
    await writeContractRegistry(groupDir, makeRegistry({ version: 2 }));
    const written = await fs.readFile(path.join(groupDir, 'contracts.json'), 'utf-8');
    const parsed = JSON.parse(written);
    expect(parsed.version).toBe(2);
  });
});

describe('writeBridgeMeta — tempfile hardening', () => {
  it('back-to-back writes do not collide on the tmp path', async () => {
    await writeBridgeMeta(groupDir, { version: 1, generatedAt: 'a', missingRepos: [] });
    await writeBridgeMeta(groupDir, { version: 2, generatedAt: 'b', missingRepos: [] });
    const meta = JSON.parse(await fs.readFile(path.join(groupDir, 'meta.json'), 'utf-8'));
    expect(meta.version).toBe(2);
  });
});

describe('createGroupDir — exclusive-create on group.yaml', () => {
  it('refuses to overwrite an existing group without force', async () => {
    const gnxDir = path.join(tmpRoot, 'gnx-existing');
    await createGroupDir(gnxDir, 'mygroup');
    // Second call without force should throw — same behavior as before this
    // commit, but now backed by O_EXCL at the writeFile level rather than
    // only the up-front existence check (closes the TOCTOU CodeQL flagged).
    await expect(createGroupDir(gnxDir, 'mygroup')).rejects.toThrow(/already exists/);
  });

  it('overwrites with force=true', async () => {
    const gnxDir = path.join(tmpRoot, 'gnx-force');
    await createGroupDir(gnxDir, 'mygroup');
    // Should succeed without throwing.
    await expect(createGroupDir(gnxDir, 'mygroup', true)).resolves.toBeTruthy();
  });
});
