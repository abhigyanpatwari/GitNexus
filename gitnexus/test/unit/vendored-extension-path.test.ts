import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  nodePlatformTuple,
  readFtsArtifactManifest,
  resolveVendoredFtsPath,
} from '../../src/core/lbug/vendored-extension-path.js';

const tmpRoots: string[] = [];

const makeVendorRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'gn-fts-vendor-'));
  tmpRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveVendoredFtsPath', () => {
  it('returns null when the tuple directory has no artifact', () => {
    const vendorRoot = makeVendorRoot();
    expect(resolveVendoredFtsPath({ vendorRoot, tuple: 'linux-x64' })).toBeNull();
  });

  it('returns the absolute artifact path when the file exists', () => {
    const vendorRoot = makeVendorRoot();
    const tuple = 'linux-x64';
    const dir = join(vendorRoot, 'lbug-fts', 'prebuilds', tuple);
    mkdirSync(dir, { recursive: true });
    const artifact = join(dir, 'libfts.lbug_extension');
    writeFileSync(artifact, 'placeholder');

    expect(resolveVendoredFtsPath({ vendorRoot, tuple })).toBe(artifact);
  });

  it('reads the filename from manifest.json when present', () => {
    const vendorRoot = makeVendorRoot();
    mkdirSync(join(vendorRoot, 'lbug-fts'), { recursive: true });
    writeFileSync(
      join(vendorRoot, 'lbug-fts', 'manifest.json'),
      JSON.stringify({ filename: 'custom-fts.bin' }),
    );
    const dir = join(vendorRoot, 'lbug-fts', 'prebuilds', 'darwin-arm64');
    mkdirSync(dir, { recursive: true });
    const artifact = join(dir, 'custom-fts.bin');
    writeFileSync(artifact, 'placeholder');

    expect(resolveVendoredFtsPath({ vendorRoot, tuple: 'darwin-arm64' })).toBe(artifact);
    expect(readFtsArtifactManifest(vendorRoot).filename).toBe('custom-fts.bin');
  });

  it('joins Node platform and arch as the tuple', () => {
    expect(nodePlatformTuple('win32', 'x64')).toBe('win32-x64');
    expect(nodePlatformTuple('linux', 'arm64')).toBe('linux-arm64');
  });
});
