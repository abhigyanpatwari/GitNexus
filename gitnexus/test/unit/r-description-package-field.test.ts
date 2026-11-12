/**
 * The `Package:` field of a `DESCRIPTION` file names a package even when the file starts with a
 * UTF-8 byte-order mark, and a field with an empty value names nothing rather than capturing the
 * name of the next line's field. Both discovery paths read the field the same way: the package
 * walk (`loadRPackageConfig`) and the hidden-package scan (`hidesUndiscoveredPackage`).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  hidesUndiscoveredPackage,
  loadRPackageConfig,
} from '../../src/core/ingestion/languages/r/package-config.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';

const pool = createTempDirPool('gn-r-desc-');

const repoWith = (description: string): string => {
  const root = pool.dir();
  fs.writeFileSync(path.join(root, 'DESCRIPTION'), description);
  return root;
};

describe('DESCRIPTION Package: field', () => {
  it('discovers a package whose DESCRIPTION starts with a UTF-8 byte-order mark', async () => {
    const config = await loadRPackageConfig(repoWith('﻿Package: bompkg\nVersion: 1.0\n'));
    expect([...(config?.packages ?? [])]).toEqual([['bompkg', '']]);
  });

  it('sees a byte-order-marked package when scanning for a hidden one', async () => {
    const root = repoWith('﻿Package: bompkg\nVersion: 1.0\n');
    expect(await hidesUndiscoveredPackage([root], new Set())).toBe(true);
    expect(await hidesUndiscoveredPackage([root], new Set(['bompkg']))).toBe(false);
  });

  it('does not take the next line as the value of an empty Package: field', async () => {
    const config = await loadRPackageConfig(repoWith('Package:\nVersion: 1.0\n'));
    expect([...(config?.packages.keys() ?? [])]).toEqual([]);
    const root = repoWith('Package:\nVersion: 1.0\n');
    expect(await hidesUndiscoveredPackage([root], new Set())).toBe(false);
  });

  it('still reads an ordinary field, with CRLF line endings and extra blanks', async () => {
    const config = await loadRPackageConfig(repoWith('Package:   spaced\r\nVersion: 1.0\r\n'));
    expect([...(config?.packages.keys() ?? [])]).toEqual(['spaced']);
  });
});
