import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  embeddingsFromGitnexusRc,
  AutoSyncGitnexusRcError,
} from '../../src/core/gitnexus-rc-embeddings.js';

describe('embeddingsFromGitnexusRc', () => {
  it('returns empty when no rc file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rc-'));
    expect(embeddingsFromGitnexusRc(dir)).toEqual({});
  });

  it('reads embeddings true from a committed rc', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rc-'));
    fs.writeFileSync(path.join(dir, '.gitnexusrc'), '{"embeddings": true}');
    expect(embeddingsFromGitnexusRc(dir)).toEqual({ embeddings: true });
  });

  it('prefers nested analyze.embeddings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rc-'));
    fs.writeFileSync(path.join(dir, '.gitnexusrc'), '{"analyze": {"embeddings": 100}}');
    expect(embeddingsFromGitnexusRc(dir)).toEqual({
      embeddings: true,
      embeddingsNodeLimit: 100,
    });
  });

  it('fails closed on invalid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rc-'));
    fs.writeFileSync(path.join(dir, '.gitnexusrc'), '{');
    expect(() => embeddingsFromGitnexusRc(dir)).toThrow(AutoSyncGitnexusRcError);
  });
});
