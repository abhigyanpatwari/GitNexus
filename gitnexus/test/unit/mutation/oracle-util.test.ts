/**
 * Locks the oracle's shared helpers (oracle/util.ts): the object guard of its JSON readers and the
 * temp-file-and-rename write that freeze.ts, launch-single.ts, command-wrapper.ts and
 * oracle-setup.ts use for manifests, launch files, wrapper records and probe files.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isObject, writeFileAtomicSync } from '../../../tools/mutation/oracle/util.js';

describe('isObject', () => {
  it.each([
    { label: 'a plain object', value: {}, expected: true },
    { label: 'null', value: null, expected: false },
    { label: 'an array', value: [], expected: false },
    { label: 'a string', value: 'x', expected: false },
  ])('$label is an object: $expected', ({ value, expected }) => {
    expect(isObject(value)).toBe(expected);
  });
});

describe('writeFileAtomicSync', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-oracle-util-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the file and leaves no temp file beside it', () => {
    const file = path.join(dir, 'probe.json');
    writeFileSync(file, 'old\n');
    writeFileAtomicSync(file, '{"complete":true}\n');
    expect(readFileSync(file, 'utf8')).toBe('{"complete":true}\n');
    expect(readdirSync(dir)).toEqual(['probe.json']);
  });
});
