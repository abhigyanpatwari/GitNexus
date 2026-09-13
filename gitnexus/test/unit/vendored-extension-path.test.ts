import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inferExtensionVersionFromPath,
  isPathInsideRoot,
  nodePlatformTuple,
  readFtsArtifactManifest,
  resolveFtsVersionPair,
  resolveVendoredFtsPath,
  validateVendoredExtensionPath,
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
      JSON.stringify({ filename: 'custom.lbug_extension' }),
    );
    const dir = join(vendorRoot, 'lbug-fts', 'prebuilds', 'darwin-arm64');
    mkdirSync(dir, { recursive: true });
    const artifact = join(dir, 'custom.lbug_extension');
    writeFileSync(artifact, 'placeholder');

    expect(resolveVendoredFtsPath({ vendorRoot, tuple: 'darwin-arm64' })).toBe(artifact);
    expect(readFtsArtifactManifest(vendorRoot).filename).toBe('custom.lbug_extension');
  });

  it('joins Node platform and arch as the tuple', () => {
    expect(nodePlatformTuple('win32', 'x64')).toBe('win32-x64');
    expect(nodePlatformTuple('linux', 'arm64')).toBe('linux-arm64');
  });

  it('rejects a sibling directory that only shares the vendor prefix', () => {
    const parent = makeVendorRoot();
    const vendorRoot = join(parent, 'vendor');
    const evil = join(parent, 'vendor-evil', 'libfts.lbug_extension');
    mkdirSync(join(parent, 'vendor-evil'), { recursive: true });
    mkdirSync(vendorRoot, { recursive: true });
    writeFileSync(evil, 'placeholder');
    expect(isPathInsideRoot(vendorRoot, evil)).toBe(false);
    expect(validateVendoredExtensionPath(evil, vendorRoot)).toBeNull();
  });
});

describe('resolveFtsVersionPair', () => {
  it('reads expected from the manifest and found from a Ladybug home path', () => {
    const vendorRoot = makeVendorRoot();
    mkdirSync(join(vendorRoot, 'lbug-fts'), { recursive: true });
    writeFileSync(
      join(vendorRoot, 'lbug-fts', 'manifest.json'),
      JSON.stringify({ extensionVersion: '0.18.1' }),
    );
    expect(
      inferExtensionVersionFromPath(
        '/home/alice/.lbdb/extension/0.17.0/linux_amd64/fts/libfts.lbug_extension',
      ),
    ).toBe('0.17.0');
    expect(
      resolveFtsVersionPair(
        'C:\\Users\\bob\\.lbdb\\extension\\0.17.0\\win_amd64\\fts\\libfts.lbug_extension',
        vendorRoot,
      ),
    ).toEqual({ expected: '0.18.1', found: '0.17.0' });
  });

  it('treats a packaged lbug-fts path as the expected version when home inference is empty', () => {
    const vendorRoot = makeVendorRoot();
    mkdirSync(join(vendorRoot, 'lbug-fts'), { recursive: true });
    writeFileSync(
      join(vendorRoot, 'lbug-fts', 'manifest.json'),
      JSON.stringify({ extensionVersion: '0.18.1' }),
    );
    expect(
      resolveFtsVersionPair(
        join(vendorRoot, 'lbug-fts', 'prebuilds', 'linux-x64', 'libfts.lbug_extension'),
        vendorRoot,
      ),
    ).toEqual({ expected: '0.18.1', found: '0.18.1' });
  });
});
