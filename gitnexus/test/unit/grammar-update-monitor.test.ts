import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Unit coverage for the ABI gate in the vendored-grammar update monitor
 * (.github/scripts/update-vendored-grammars.mjs). The gate is load-bearing: every
 * grammar is pinned to tree-sitter@0.21.1 (LANGUAGE_VERSION 13–14), so an update
 * is only auto-applied when the candidate parser.c's ABI is 13 or 14 — otherwise
 * the monitor would open PRs that can't build. We test the pure pieces (no
 * network): reading the ABI from a parser.c and the compatibility set. The module
 * is import-safe (its CLI is guarded behind an isMain check).
 */
const MOD = pathToFileURL(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../.github/scripts/update-vendored-grammars.mjs',
  ),
).href;

let mod: {
  readAbi: (root: string) => number | null;
  COMPATIBLE_ABI: Set<number>;
  GRAMMARS: Record<string, { name: string; npm?: string; github?: string }>;
};
let tmp: string;

beforeAll(async () => {
  mod = await import(MOD);
  tmp = mkdtempSync(path.join(tmpdir(), 'gum-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fixture(abiLine: string): string {
  const root = mkdtempSync(path.join(tmp, 'g-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'parser.c'), `${abiLine}\n#define STATE_COUNT 10\n`);
  return root;
}

describe('readAbi', () => {
  it('reads LANGUAGE_VERSION 14 from src/parser.c', () => {
    expect(mod.readAbi(fixture('#define LANGUAGE_VERSION 14'))).toBe(14);
  });
  it('reads LANGUAGE_VERSION 15 (an incompatible upstream)', () => {
    expect(mod.readAbi(fixture('#define LANGUAGE_VERSION 15'))).toBe(15);
  });
  it('returns null when parser.c is absent (generated-at-build-time grammars)', () => {
    expect(mod.readAbi(mkdtempSync(path.join(tmp, 'empty-')))).toBeNull();
  });
});

describe('COMPATIBLE_ABI gate', () => {
  it('accepts ABI 13 and 14, rejects 12 and 15', () => {
    expect(mod.COMPATIBLE_ABI.has(13)).toBe(true);
    expect(mod.COMPATIBLE_ABI.has(14)).toBe(true);
    expect(mod.COMPATIBLE_ABI.has(12)).toBe(false);
    expect(mod.COMPATIBLE_ABI.has(15)).toBe(false);
  });
});

describe('GRAMMARS registry', () => {
  it('covers swift/kotlin (npm) + dart/proto (github) and EXCLUDES the ABI-pinned c', () => {
    expect(Object.keys(mod.GRAMMARS).sort()).toEqual(['dart', 'kotlin', 'proto', 'swift']);
    expect(mod.GRAMMARS.swift.npm).toBe('tree-sitter-swift');
    expect(mod.GRAMMARS.dart.github).toContain('tree-sitter-dart');
    expect(mod.GRAMMARS).not.toHaveProperty('c');
  });
});
