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
    it('reads package name from package.json', () => {
      writePackageJson('.', { name: '@acme/shared-utils', version: '1.0.0' });
      const result = readNpmManifest(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('@acme/shared-utils');
    });

    it('reads scoped package names correctly', () => {
      writePackageJson('.', { name: '@org/my-lib' });
      const result = readNpmManifest(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('@org/my-lib');
    });

    it('reads unscoped package names', () => {
      writePackageJson('.', { name: 'simple-lib' });
      const result = readNpmManifest(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('simple-lib');
    });

    it('returns null when no package.json exists', () => {
      const result = readNpmManifest(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null when package.json has no name field', () => {
      writePackageJson('.', { version: '1.0.0' });
      const result = readNpmManifest(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null when package.json name is empty string', () => {
      writePackageJson('.', { name: '' });
      const result = readNpmManifest(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null when package.json name is whitespace', () => {
      writePackageJson('.', { name: '  ' });
      const result = readNpmManifest(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ invalid json }');
      const result = readNpmManifest(tmpDir);
      expect(result).toBeNull();
    });
  });
});
