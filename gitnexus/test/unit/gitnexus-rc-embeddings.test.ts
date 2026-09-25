import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  embeddingsFromGitnexusRc,
  AutoSyncGitnexusRcError,
} from '../../src/core/gitnexus-rc-embeddings.js';

describe('embeddingsFromGitnexusRc', () => {
  it('returns empty when no rc file exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rc-'));
    await expect(embeddingsFromGitnexusRc(dir)).resolves.toEqual({});
  });

  it('reads embeddings true from a committed rc', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rc-'));
    fs.writeFileSync(path.join(dir, '.gitnexusrc'), '{"embeddings": true}');
    await expect(embeddingsFromGitnexusRc(dir)).resolves.toEqual({ embeddings: true });
  });

  it('prefers nested analyze.embeddings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rc-'));
    fs.writeFileSync(path.join(dir, '.gitnexusrc'), '{"analyze": {"embeddings": 100}}');
    await expect(embeddingsFromGitnexusRc(dir)).resolves.toEqual({
      embeddings: true,
      embeddingsNodeLimit: 100,
    });
  });

  it('fails closed on invalid JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rc-'));
    fs.writeFileSync(path.join(dir, '.gitnexusrc'), '{');
    await expect(embeddingsFromGitnexusRc(dir)).rejects.toThrow(AutoSyncGitnexusRcError);
  });

  it('refuses a symlink .gitnexusrc', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rc-'));
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(outside, '{"embeddings": true}');
    fs.symlinkSync(outside, path.join(dir, '.gitnexusrc'));
    await expect(embeddingsFromGitnexusRc(dir)).rejects.toThrow(/symbolic link/);
  });
});
