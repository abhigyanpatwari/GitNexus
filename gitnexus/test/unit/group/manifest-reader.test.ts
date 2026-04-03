import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readNpmManifest,
  buildPackageMap,
  findSiblingDependencies,
} from '../../../src/core/group/extractors/manifest-reader.js';

describe('manifest-reader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gitnexus-manifest-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePackageJson(dir: string, content: Record<string, unknown>): void {
    const full = path.join(tmpDir, dir);
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(path.join(full, 'package.json'), JSON.stringify(content, null, 2));
  }

  describe('readNpmManifest', () => {
    it('reads package name and dependencies from package.json', () => {
      writePackageJson('.', {
        name: '@acme/shared-utils',
        version: '1.0.0',
        dependencies: { lodash: '^4.17.0', express: '^4.18.0' },
        devDependencies: { vitest: '^1.0.0' },
      });

      const result = readNpmManifest(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('@acme/shared-utils');
      expect(result!.dependencies).toContain('lodash');
      expect(result!.dependencies).toContain('express');
      expect(result!.dependencies).toContain('vitest');
    });

    it('reads scoped package names correctly', () => {
      writePackageJson('.', { name: '@org/my-lib', dependencies: {} });
      const result = readNpmManifest(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('@org/my-lib');
    });

    it('reads unscoped package names', () => {
      writePackageJson('.', { name: 'simple-lib', dependencies: { react: '*' } });
      const result = readNpmManifest(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('simple-lib');
      expect(result!.dependencies).toEqual(['react']);
    });

    it('returns null when no package.json exists', () => {
      const result = readNpmManifest(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null when package.json has no name field', () => {
      writePackageJson('.', { version: '1.0.0', dependencies: { foo: '1.0.0' } });
      const result = readNpmManifest(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null when package.json name is empty string', () => {
      writePackageJson('.', { name: '', dependencies: {} });
      const result = readNpmManifest(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null when package.json name is whitespace', () => {
      writePackageJson('.', { name: '  ', dependencies: {} });
      const result = readNpmManifest(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      const pkgDir = tmpDir;
      fs.writeFileSync(path.join(pkgDir, 'package.json'), '{ invalid json }');
      const result = readNpmManifest(pkgDir);
      expect(result).toBeNull();
    });

    it('returns empty dependencies when no dep fields exist', () => {
      writePackageJson('.', { name: 'no-deps' });
      const result = readNpmManifest(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.dependencies).toEqual([]);
    });

    it('includes peerDependencies', () => {
      writePackageJson('.', {
        name: 'with-peers',
        peerDependencies: { react: '>=18.0.0' },
      });
      const result = readNpmManifest(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.dependencies).toContain('react');
    });

    it('deduplicates dependencies across fields', () => {
      writePackageJson('.', {
        name: 'dedup-test',
        dependencies: { react: '^18.0.0' },
        peerDependencies: { react: '>=18.0.0' },
      });
      const result = readNpmManifest(tmpDir);
      expect(result).not.toBeNull();
      const reactCount = result!.dependencies.filter((d) => d === 'react').length;
      expect(reactCount).toBe(1);
    });
  });

  describe('buildPackageMap', () => {
    it('maps package names to group paths', () => {
      const repoA = path.join(tmpDir, 'repo-a');
      const repoB = path.join(tmpDir, 'repo-b');
      fs.mkdirSync(repoA, { recursive: true });
      fs.mkdirSync(repoB, { recursive: true });
      fs.writeFileSync(
        path.join(repoA, 'package.json'),
        JSON.stringify({ name: '@acme/shared', dependencies: {} }),
      );
      fs.writeFileSync(
        path.join(repoB, 'package.json'),
        JSON.stringify({ name: '@acme/web-app', dependencies: {} }),
      );

      const repos = { 'libs/shared': 'repo-a', 'apps/web': 'repo-b' };
      const resolve = (name: string) => {
        if (name === 'repo-a') return repoA;
        if (name === 'repo-b') return repoB;
        return null;
      };

      const map = buildPackageMap(repos, resolve);
      expect(map.get('@acme/shared')).toBe('libs/shared');
      expect(map.get('@acme/web-app')).toBe('apps/web');
      expect(map.size).toBe(2);
    });

    it('skips repos that cannot be resolved', () => {
      const repoA = path.join(tmpDir, 'repo-a');
      fs.mkdirSync(repoA, { recursive: true });
      fs.writeFileSync(
        path.join(repoA, 'package.json'),
        JSON.stringify({ name: '@acme/shared', dependencies: {} }),
      );

      const repos = { 'libs/shared': 'repo-a', 'apps/missing': 'repo-missing' };
      const resolve = (name: string) => (name === 'repo-a' ? repoA : null);

      const map = buildPackageMap(repos, resolve);
      expect(map.size).toBe(1);
      expect(map.has('@acme/shared')).toBe(true);
    });

    it('skips repos without package.json', () => {
      const repoA = path.join(tmpDir, 'repo-a');
      fs.mkdirSync(repoA, { recursive: true });
      // No package.json written

      const repos = { 'libs/shared': 'repo-a' };
      const resolve = () => repoA;

      const map = buildPackageMap(repos, resolve);
      expect(map.size).toBe(0);
    });
  });

  describe('findSiblingDependencies', () => {
    it('finds sibling packages in dependencies', () => {
      writePackageJson('.', {
        name: '@acme/web-app',
        dependencies: {
          '@acme/shared': '^1.0.0',
          '@acme/ui-kit': '^2.0.0',
          lodash: '^4.17.0',
        },
      });

      const packageMap = new Map([
        ['@acme/shared', 'libs/shared'],
        ['@acme/ui-kit', 'libs/ui-kit'],
      ]);

      const siblings = findSiblingDependencies(tmpDir, packageMap);
      expect(siblings).toContain('@acme/shared');
      expect(siblings).toContain('@acme/ui-kit');
      expect(siblings).not.toContain('lodash');
    });

    it('returns empty when no siblings found', () => {
      writePackageJson('.', {
        name: '@acme/standalone',
        dependencies: { lodash: '^4.17.0' },
      });

      const packageMap = new Map([['@acme/other', 'libs/other']]);
      const siblings = findSiblingDependencies(tmpDir, packageMap);
      expect(siblings).toEqual([]);
    });

    it('returns empty when no package.json', () => {
      const packageMap = new Map([['@acme/shared', 'libs/shared']]);
      const siblings = findSiblingDependencies(tmpDir, packageMap);
      expect(siblings).toEqual([]);
    });
  });
});
