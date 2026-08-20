import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard: no tracked TypeScript source may contain a raw control byte.
 *
 * A NUL written as a literal 0x00 rather than the `\0` escape is invisible in
 * an editor and identical at runtime, but it makes the file test as BINARY:
 * `file(1)` reports `data`, `ugrep` returns empty with exit 1 (indistinguishable
 * from "no match", with no message), and BSD grep replaces the matching lines
 * with `Binary file … matches`. A search that should hit comes back as a
 * confident "not present", which is the worst way for a file to be unreadable.
 *
 * Two files had picked this up before this guard existed — both using NUL as a
 * join delimiter, which is a fine technique written the wrong way.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** Bytes that make a file look binary. Tab, LF and CR are legitimate in source. */
const FORBIDDEN_CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(abs, out);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(abs);
  }
  return out;
}

describe('source hygiene', () => {
  it('has no raw control bytes in any src/ TypeScript file', () => {
    const offenders: string[] = [];

    for (const file of collectTsFiles(SRC_ROOT)) {
      const text = fs.readFileSync(file, 'latin1');
      const match = FORBIDDEN_CONTROL_BYTES.exec(text);
      if (!match) continue;
      const line = text.slice(0, match.index).split('\n').length;
      const byte = `0x${match[0].charCodeAt(0).toString(16).padStart(2, '0')}`;
      offenders.push(`${path.relative(SRC_ROOT, file)}:${line} contains ${byte}`);
    }

    expect(
      offenders,
      [
        'Raw control bytes make a source file test as binary, so some search tools',
        'skip it silently. Write the character as an escape instead (e.g. `\\0`),',
        'which is identical at runtime and keeps the file text:',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });
});
