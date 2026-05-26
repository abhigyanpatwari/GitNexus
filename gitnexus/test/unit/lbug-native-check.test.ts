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
      expect(result.message).toContain('lbugjs.node');
      expect(result.message).toContain('install.js');
      expect(result.message).toContain('trustedDependencies');
      expect(result.message).toContain('ignore-scripts');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns ok:true when lbugjs.node exists at the override path', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-check-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'lbugjs.node'), Buffer.alloc(0));

      const result = checkLbugNative(tmpDir);

      expect(result.ok).toBe(true);
      expect(result.binaryPath).toBe(path.join(tmpDir, 'lbugjs.node'));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
