import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readNpmManifest } from '../../../src/core/group/extractors/manifest-reader.js';

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

  describe('readNpmManifest — dependency list for sibling detection', () => {
    it('lists all dependency names for cross-repo matching', () => {
      writePackageJson('.', {
        name: '@acme/web-app',
        dependencies: {
          '@acme/shared': '^1.0.0',
          '@acme/ui-kit': '^2.0.0',
          lodash: '^4.17.0',
        },
      });

      const result = readNpmManifest(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.dependencies).toContain('@acme/shared');
      expect(result!.dependencies).toContain('@acme/ui-kit');
      expect(result!.dependencies).toContain('lodash');
    });
  });
});
