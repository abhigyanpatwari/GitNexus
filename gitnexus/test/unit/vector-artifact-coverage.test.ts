import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveVendoredVectorPath } from '../../src/core/lbug/vendored-extension-path.js';

const vendorRoot = fileURLToPath(new URL('../../vendor/', import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL('../../vendor/lbug-vector/manifest.json', import.meta.url), 'utf8'),
) as {
  coreVersion: string;
  artifacts: Array<{ tuple: string; sha256: string }>;
};
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
  files: string[];
};

describe('packaged VECTOR artifacts', () => {
  it('pins the artifacts to the installed core version and includes their provenance in npm', () => {
    expect(manifest.coreVersion).toBe(pkg.dependencies['@ladybugdb/core']);
    expect(pkg.files).toContain('vendor/lbug-vector/manifest.json');
    expect(manifest.artifacts.map(({ tuple }) => tuple).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
  });

  it.each(manifest.artifacts)('ships the verified $tuple binary', ({ tuple, sha256 }) => {
    const artifact = resolveVendoredVectorPath({ vendorRoot, tuple });
    if (artifact === null) throw new Error(`Missing packaged VECTOR artifact for ${tuple}`);
    expect(createHash('sha256').update(readFileSync(artifact)).digest('hex')).toBe(sha256);
  });
});
