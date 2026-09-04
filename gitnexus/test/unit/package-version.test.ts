import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { packageVersion } from '../../src/core/package-version.js';

const fromManifest = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version;

describe('packageVersion', () => {
  it('returns the same string as gitnexus/package.json#version', () => {
    expect(packageVersion()).toBe(fromManifest);
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
