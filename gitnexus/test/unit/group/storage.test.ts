import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  getGroupDir,
  getGroupsBaseDir,
  listGroups,
  createGroupDir,
  validateGroupName,
  openBridgeOrFallback,
} from '../../../src/core/group/storage.js';
import { writeBridge, closeBridgeDb } from '../../../src/core/group/bridge-db.js';
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

  describe('openBridgeOrFallback', () => {
    it('test_openBridgeOrFallback_bridge_exists_returns_bridge', async () => {
      const groupDir = path.join(tmpDir, 'bridge-test');
      fs.mkdirSync(groupDir, { recursive: true });

      await writeBridge(groupDir, {
        contracts: [],
        crossLinks: [],
        repoSnapshots: {},
        missingRepos: [],
      });

      const result = await openBridgeOrFallback(groupDir);
      expect(result.type).toBe('bridge');
      if (result.type === 'bridge') {
        expect(result.handle).toBeDefined();
        expect(result.meta).toBeDefined();
        await closeBridgeDb(result.handle);
      }
    });

    it('test_openBridgeOrFallback_json_only_returns_json_with_deprecation', async () => {
      const groupDir = path.join(tmpDir, 'json-test');
      fs.mkdirSync(groupDir, { recursive: true });

      const registry: ContractRegistry = {
        version: 1,
        generatedAt: '2026-04-01T00:00:00Z',
        repoSnapshots: {},
        missingRepos: [],
        contracts: [],
        crossLinks: [],
      };
      fs.writeFileSync(
        path.join(groupDir, 'contracts.json'),
        JSON.stringify(registry, null, 2),
        'utf-8',
      );

      const result = await openBridgeOrFallback(groupDir);
      expect(result.type).toBe('json');
      if (result.type === 'json') {
        expect(result.registry.version).toBe(1);
        expect(result.deprecationWarning).toContain('deprecated');
        expect(result.deprecationWarning).toContain('bridge.lbug');
      }
    });

    it('test_openBridgeOrFallback_neither_exists_returns_none', async () => {
      const groupDir = path.join(tmpDir, 'empty-test');
      fs.mkdirSync(groupDir, { recursive: true });

      const result = await openBridgeOrFallback(groupDir);
      expect(result.type).toBe('none');
    });
  });
});
