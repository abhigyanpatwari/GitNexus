/**
 * U9: injected vendored-root seam. Never an environment variable — an
 * attacker-controlled env would be a path into an in-process native load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extensionManager, resetExtensionState } from '../../src/core/lbug/extension-loader.js';
import { diagnoseExtensionLoad } from '../../src/core/lbug/extension-load-error.js';
import {
  defaultVendorRoot,
  nodePlatformTuple,
} from '../../src/core/lbug/vendored-extension-path.js';
import { cleanupTempDirSync } from '../helpers/test-db.js';

const tmpDirs: string[] = [];

const makeVendorTree = (state: 'valid' | 'truncated'): { vendorRoot: string; dest: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-fts-vendor with space-'));
  tmpDirs.push(dir);
  const vendorRoot = path.join(dir, 'vendor');
  const dest = path.join(
    vendorRoot,
    'lbug-fts',
    'prebuilds',
    nodePlatformTuple(),
    'libfts.lbug_extension',
  );
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const manifestSrc = path.join(defaultVendorRoot(), 'lbug-fts', 'manifest.json');
  if (fs.existsSync(manifestSrc)) {
    fs.copyFileSync(manifestSrc, path.join(vendorRoot, 'lbug-fts', 'manifest.json'));
  }
  const packaged = path.join(
    defaultVendorRoot(),
    'lbug-fts',
    'prebuilds',
    nodePlatformTuple(),
    'libfts.lbug_extension',
  );
  if (state === 'valid' && fs.existsSync(packaged)) fs.copyFileSync(packaged, dest);
  if (state === 'truncated') fs.writeFileSync(dest, Buffer.alloc(64, 0));
  return { vendorRoot, dest };
};

afterEach(() => {
  resetExtensionState();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) cleanupTempDirSync(dir);
  }
});

describe('vendored-root seam (injected parameter, never env)', () => {
  it('loads from an injected vendor tree without attempting a network install', async () => {
    const { vendorRoot, dest } = makeVendorTree('valid');
    expect(fs.existsSync(dest)).toBe(true);
    const query = vi.fn().mockResolvedValue({});
    const ok = await extensionManager.ensure(query, 'fts', 'FTS', {
      vendorRoot,
      policy: 'load-only',
    });
    expect(ok).toBe(true);
    expect(query).toHaveBeenCalled();
    const sql = String(query.mock.calls[0]?.[0] ?? '');
    expect(sql).toMatch(/LOAD/i);
    expect(sql).toMatch(/libfts\.lbug_extension/);
    expect(query.mock.calls.some(([text]) => String(text).includes('INSTALL'))).toBe(false);
  });

  it('reports a corrupt diagnosis when the injected artifact is truncated', async () => {
    const { vendorRoot, dest } = makeVendorTree('truncated');
    const reason = `Failed to load library '${dest}': invalid ELF header`;
    const query = vi.fn().mockRejectedValue(new Error(reason));
    const ok = await extensionManager.ensure(query, 'fts', 'FTS', {
      vendorRoot,
      policy: 'load-only',
    });
    expect(ok).toBe(false);
    expect(diagnoseExtensionLoad(reason).kind).toBe('corrupt_file');
  });
});
