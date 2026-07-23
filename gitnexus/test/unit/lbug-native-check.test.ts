import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { checkLbugNative } from '../../src/core/lbug/native-check.js';

describe('checkLbugNative', () => {
  it('returns ok:true when the real @ladybugdb/core binary is present', () => {
    const result = checkLbugNative();
    expect(result.ok).toBe(true);
    expect(result.binaryPath).toBeDefined();
    expect(result.message).toBeUndefined();
  });

  it('returns ok:false with repair instructions when lbugjs.node is missing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-check-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'install.js'), '');

      const result = checkLbugNative(tmpDir);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('missing');
      expect(result.message).toContain('install.js');
      expect(result.message).toContain('trustedDependencies');
      expect(result.message).toContain('ignore-scripts');
      expect(result.message).toContain('--allow-build=@ladybugdb/core');
      expect(result.message).toContain('pnpm add -g --allow-build=@ladybugdb/core');
      const allowBuildIdx = result.message!.indexOf('--allow-build=@ladybugdb/core');
      const dlxIdx = result.message!.indexOf('dlx gitnexus');
      expect(allowBuildIdx).toBeGreaterThanOrEqual(0);
      expect(dlxIdx).toBeGreaterThan(allowBuildIdx);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns ok:false when lbugjs.node exists but is unloadable (zero-byte)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-check-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'lbugjs.node'), Buffer.alloc(0));

      const result = checkLbugNative(tmpDir);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('failed to load');
      expect(result.message).toContain('install.js');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns ok:false when lbugjs.node is truncated (loader crashes with a signal)', async () => {
    // A partially written .node (valid header, missing pages) SIGBUSes dlopen — a
    // signal, not a catchable throw. The out-of-process probe must observe the
    // crash and report it, instead of the whole process dying with exit 135 (#2441).
    const realPath = checkLbugNative().binaryPath;
    expect(realPath).toBeDefined();
    const truncated = (await fs.readFile(realPath!)).subarray(0, 300_000);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-check-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'install.js'), '');
      await fs.writeFile(path.join(tmpDir, 'lbugjs.node'), truncated);

      const result = checkLbugNative(tmpDir);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('failed to load');
      expect(result.message).toContain('install.js');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns ok:true when the load probe cannot be spawned (inconclusive, not a broken binary)', async () => {
    // The binary is present, but the child probe cannot launch — a sandbox that
    // forbids subprocesses, or a non-Node execPath. We could not test the binary,
    // so a healthy one must not be condemned; the command's own load stays
    // authoritative. (Binary content is irrelevant here — the probe never runs.)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-check-'));
    const originalExecPath = process.execPath;
    try {
      await fs.writeFile(path.join(tmpDir, 'lbugjs.node'), Buffer.from('content-irrelevant'));
      await fs.writeFile(path.join(tmpDir, 'install.js'), '');
      process.execPath = path.join(tmpDir, 'definitely-not-node');

      const result = checkLbugNative(tmpDir);

      expect(result.ok).toBe(true);
      expect(result.message).toBeUndefined();
    } finally {
      process.execPath = originalExecPath;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
