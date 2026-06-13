import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

type Grammar = { name: string; npm?: string; github?: string; hold?: string };
type Upstream = { version: string; ref: string; kind: 'npm' | 'github' };
type DetectDeps = {
  vendoredVersion?: (g: Grammar) => string;
  resolveUpstream?: (g: Grammar) => Upstream;
  fetchSource?: (g: Grammar, ref: string) => string;
  readAbi?: (root: string) => number | null;
};
let mod: {
  readAbi: (root: string) => number | null;
  COMPATIBLE_ABI: Set<number>;
  GRAMMARS: Record<string, Grammar>;
  detect: (deps?: DetectDeps) => Array<Record<string, unknown>>;
  apply: (key: string, opts?: { dryRun?: boolean; deps?: DetectDeps }) => string;
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
  it('covers all five grammars (swift/kotlin npm, dart/proto github, c npm)', () => {
    expect(Object.keys(mod.GRAMMARS).sort()).toEqual(['c', 'dart', 'kotlin', 'proto', 'swift']);
    expect(mod.GRAMMARS.swift.npm).toBe('tree-sitter-swift');
    expect(mod.GRAMMARS.dart.github).toContain('tree-sitter-dart');
  });

  it('monitors c but marks it report-only (ABI-pinned hold); the rest are auto-updatable', () => {
    expect(mod.GRAMMARS.c.npm).toBe('tree-sitter-c');
    expect(mod.GRAMMARS.c.hold).toBeTruthy(); // detected/reported, never auto-applied
    for (const k of ['swift', 'kotlin', 'dart', 'proto']) {
      expect(mod.GRAMMARS[k].hold).toBeUndefined();
    }
  });
});

describe('shared vendored-grammars manifest', () => {
  // The vendored set is sourced from .github/vendored-grammars.json — the single
  // source of truth shared with check-tree-sitter-upgrade-readiness.py. This guards
  // against the loader silently skewing from the manifest file (#858 alignment).
  const manifestPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../.github/vendored-grammars.json',
  );
  const manifest: {
    grammars: Record<
      string,
      { name: string; upstream: { npm?: string; github?: string }; hold?: string }
    >;
  } = JSON.parse(readFileSync(manifestPath, 'utf8'));

  it('reshapes every manifest entry into the GRAMMARS shape, losing no information', () => {
    expect(Object.keys(mod.GRAMMARS).sort()).toEqual(Object.keys(manifest.grammars).sort());
    for (const [key, g] of Object.entries(manifest.grammars)) {
      const entry = mod.GRAMMARS[key];
      expect(entry.name).toBe(g.name);
      expect(entry.npm).toBe(g.upstream.npm); // undefined === undefined for github grammars
      expect(entry.github).toBe(g.upstream.github);
      expect(entry.hold).toBe(g.hold);
    }
  });

  it('each grammar has exactly one upstream source (npm xor github)', () => {
    for (const g of Object.values(mod.GRAMMARS)) {
      expect(Boolean(g.npm) !== Boolean(g.github)).toBe(true);
    }
  });
});

describe('detect() classification (offline, injected deps)', () => {
  // Drive the real detect() loop with faked network/fs seams so the load-bearing
  // gates — newer-detection, the ABI gate, and the policy hold — are exercised
  // deterministically without touching live npm/GitHub.
  const deps: DetectDeps = {
    vendoredVersion: (g) => (g.name === 'tree-sitter-kotlin' ? '9.9.9' : '0.0.0'),
    resolveUpstream: (g) =>
      g.npm
        ? { version: '9.9.9', ref: '9.9.9', kind: 'npm' }
        : { version: '1.0.0-gabc1234', ref: 'abc1234def0', kind: 'github' },
    fetchSource: (g) => g.name, // pass the name through to the fake readAbi
    readAbi: (name) => (name === 'tree-sitter-swift' ? 15 : 14),
  };
  let report: Array<Record<string, unknown>>;
  const byKey = (k: string) => report.find((r) => r.grammar === k)!;
  beforeAll(() => {
    report = mod.detect(deps);
  });

  it('flags newer npm + github grammars as updates', () => {
    expect(byKey('swift').update).toBe(true); // npm 9.9.9 != vendored 0.0.0
    expect(byKey('dart').update).toBe(true); // github sha differs from vendored
  });

  it('does not flag a same-version grammar, and skips its ABI fetch', () => {
    expect(byKey('kotlin').update).toBe(false); // vendored == upstream 9.9.9
    expect(byKey('kotlin').abi).toBeNull();
    expect(byKey('kotlin').applicable).toBe(false);
  });

  it('holds tree-sitter-c: update detected, ABI-compatible, but never applicable', () => {
    const c = byKey('c');
    expect(c.update).toBe(true);
    expect(c.abi).toBe(14);
    expect(c.abiCompatible).toBe(true);
    expect(c.hold).toBeTruthy();
    expect(c.applicable).toBe(false); // policy-hold gate
  });

  it('refuses an ABI-incompatible candidate (15) — not applicable', () => {
    const s = byKey('swift');
    expect(s.abi).toBe(15);
    expect(s.abiCompatible).toBe(false);
    expect(s.applicable).toBe(false); // ABI gate
  });

  it('marks a newer, un-held, ABI-14 grammar applicable', () => {
    const d = byKey('dart');
    expect(d.abi).toBe(14);
    expect(d.applicable).toBe(true);
  });
});

describe('apply(--dry-run): resolves + validates but writes nothing', () => {
  it('returns the candidate version without mutating the vendored package.json', () => {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../vendor/tree-sitter-dart/package.json',
    );
    const before = readFileSync(pkgPath, 'utf8');
    const version = mod.apply('dart', {
      dryRun: true,
      deps: {
        vendoredVersion: () => '0.0.0',
        resolveUpstream: () => ({ version: '9.9.9', ref: '9.9.9abc', kind: 'github' }),
        fetchSource: () => 'unused',
        readAbi: () => 14,
      },
    });
    expect(version).toBe('9.9.9');
    expect(readFileSync(pkgPath, 'utf8')).toBe(before); // untouched
  });
});
