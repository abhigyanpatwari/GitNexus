import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getPackagedRendererEntry,
  getRequestedPath,
  normalizeStaticPath,
} from '../src/main/runtime-paths.js';

describe('normalizeStaticPath', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-desktop-static-'));
    writeFileSync(path.join(rootDir, 'index.html'), '<html></html>');
    writeFileSync(path.join(rootDir, 'asset.js'), 'console.log("ok");');
  });

  afterEach(() => {
    rmSync(rootDir, { force: true, recursive: true });
  });

  it('rejects directory traversal attempts', () => {
    expect(normalizeStaticPath(rootDir, '/../../etc/passwd')).toBeNull();
  });

  it('rejects null-byte paths', () => {
    expect(normalizeStaticPath(rootDir, '/\0asset.js')).toBeNull();
  });

  it('returns a real asset path when the file exists', () => {
    expect(normalizeStaticPath(rootDir, '/asset.js')).toBe(path.join(rootDir, 'asset.js'));
  });

  it('falls back to index.html for extensionless routes', () => {
    expect(normalizeStaticPath(rootDir, '/desktop')).toBe(path.join(rootDir, 'index.html'));
  });
});

describe('getRequestedPath', () => {
  it('returns null for malformed percent-encoding', () => {
    expect(getRequestedPath('/%GG')).toBeNull();
  });

  it('returns null for decoded null bytes', () => {
    expect(getRequestedPath('/%00')).toBeNull();
  });
});

describe('getPackagedRendererEntry', () => {
  it('resolves the packaged renderer relative to dist/main', () => {
    const rendererEntry = getPackagedRendererEntry(path.join('dist', 'main'));

    expect(path.normalize(rendererEntry)).toBe(
      path.normalize(path.join('dist', 'renderer', 'index.html')),
    );
  });
});
