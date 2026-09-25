import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  embeddingsFromGitnexusRc,
  AutoSyncGitnexusRcError,
} from '../../src/core/gitnexus-rc-embeddings.js';

describe('embeddingsFromGitnexusRc', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rc-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty when no rc file exists', async () => {
    await expect(embeddingsFromGitnexusRc(tempDir())).resolves.toEqual({});
  });

  it('reads embeddings true from a committed rc', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.gitnexusrc'), '{"embeddings": true}');
    await expect(embeddingsFromGitnexusRc(dir)).resolves.toEqual({ embeddings: true });
  });

  it('prefers nested analyze.embeddings over a conflicting top-level value', async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, '.gitnexusrc'),
      '{"embeddings": false, "analyze": {"embeddings": 100}}',
    );
    await expect(embeddingsFromGitnexusRc(dir)).resolves.toEqual({
      embeddings: true,
      embeddingsNodeLimit: 100,
    });
  });

  it('fails closed on invalid JSON', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.gitnexusrc'), '{');
    await expect(embeddingsFromGitnexusRc(dir)).rejects.toThrow(AutoSyncGitnexusRcError);
  });

  it('refuses a symlink .gitnexusrc', async () => {
    const dir = tempDir();
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(outside, '{"embeddings": true}');
    fs.symlinkSync(outside, path.join(dir, '.gitnexusrc'));
    await expect(embeddingsFromGitnexusRc(dir)).rejects.toThrow(/symbolic link/);
  });
});
