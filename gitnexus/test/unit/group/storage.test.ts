import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  getGroupDir,
  getGroupsBaseDir,
  writeContractRegistry,
  readContractRegistry,
  listGroups,
  createGroupDir,
  validateGroupName,
} from '../../../src/core/group/storage.js';
import type { ContractRegistry } from '../../../src/core/group/types.js';

describe('Group storage', () => {
  const tmpDir = path.join(os.tmpdir(), `gitnexus-test-storage-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getGroupsBaseDir returns ~/.gitnexus/groups/', () => {
    const base = getGroupsBaseDir(tmpDir);
    expect(base).toBe(path.join(tmpDir, 'groups'));
  });

  it('getGroupDir returns correct path for group name', () => {
    const dir = getGroupDir(tmpDir, 'company');
    expect(dir).toBe(path.join(tmpDir, 'groups', 'company'));
  });

  it('writeContractRegistry writes atomically and readContractRegistry reads back', async () => {
    const groupDir = path.join(tmpDir, 'groups', 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const registry: ContractRegistry = {
      version: 1,
      generatedAt: '2026-03-31T10:00:00Z',
      repoSnapshots: {},
      missingRepos: [],
      contracts: [],
      crossLinks: [],
    };

    await writeContractRegistry(groupDir, registry);

    const filePath = path.join(groupDir, 'contracts.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = await readContractRegistry(groupDir);
    expect(loaded?.version).toBe(1);
    expect(loaded?.generatedAt).toBe('2026-03-31T10:00:00Z');
  });

  it('readContractRegistry returns null when file does not exist', async () => {
    const groupDir = path.join(tmpDir, 'groups', 'nonexistent');
    fs.mkdirSync(groupDir, { recursive: true });
    const result = await readContractRegistry(groupDir);
    expect(result).toBeNull();
  });

  it('listGroups returns group names', async () => {
    const groupsDir = path.join(tmpDir, 'groups');
    fs.mkdirSync(path.join(groupsDir, 'company'), { recursive: true });
    fs.writeFileSync(
      path.join(groupsDir, 'company', 'group.yaml'),
      'version: 1\nname: company\nrepos:\n  a: b',
    );
    fs.mkdirSync(path.join(groupsDir, 'personal'), { recursive: true });
    fs.writeFileSync(
      path.join(groupsDir, 'personal', 'group.yaml'),
      'version: 1\nname: personal\nrepos:\n  c: d',
    );

    const groups = await listGroups(tmpDir);
    expect(groups.sort()).toEqual(['company', 'personal']);
  });

  describe('validateGroupName', () => {
    it('test_validateGroupName_traversal_path_throws', () => {
      expect(() => validateGroupName('../../evil')).toThrow(/Invalid group name/);
    });

    it('test_validateGroupName_slash_in_name_throws', () => {
      expect(() => validateGroupName('foo/bar')).toThrow(/Invalid group name/);
    });

    it('test_validateGroupName_empty_string_throws', () => {
      expect(() => validateGroupName('')).toThrow(/Invalid group name/);
    });

    it('test_validateGroupName_starts_with_dash_throws', () => {
      expect(() => validateGroupName('-leading-dash')).toThrow(/Invalid group name/);
    });

    it('test_validateGroupName_starts_with_underscore_throws', () => {
      expect(() => validateGroupName('_leading')).toThrow(/Invalid group name/);
    });

    it('test_validateGroupName_dots_throws', () => {
      expect(() => validateGroupName('com.example')).toThrow(/Invalid group name/);
    });

    it('test_validateGroupName_valid_alphanumeric_passes', () => {
      expect(() => validateGroupName('my-group_01')).not.toThrow();
    });

    it('test_validateGroupName_single_char_passes', () => {
      expect(() => validateGroupName('A')).not.toThrow();
    });

    it('test_validateGroupName_all_digits_passes', () => {
      expect(() => validateGroupName('123')).not.toThrow();
    });
  });

  describe('getGroupDir rejects invalid names', () => {
    it('test_getGroupDir_traversal_throws', () => {
      expect(() => getGroupDir(tmpDir, '../../etc')).toThrow(/Invalid group name/);
    });

    it('test_getGroupDir_valid_name_returns_path', () => {
      const dir = getGroupDir(tmpDir, 'company');
      expect(dir).toBe(path.join(tmpDir, 'groups', 'company'));
    });
  });

  describe('createGroupDir rejects invalid names', () => {
    it('test_createGroupDir_traversal_throws', async () => {
      await expect(createGroupDir(tmpDir, '../evil')).rejects.toThrow(/Invalid group name/);
    });
  });
});
