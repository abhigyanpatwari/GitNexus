import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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
  loadManifestGrammars: (raw?: unknown) => Record<string, Grammar>;
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

  it('marks c and kotlin report-only (holds); swift/dart/proto are auto-updatable', () => {
    expect(mod.GRAMMARS.c.npm).toBe('tree-sitter-c');
    expect(mod.GRAMMARS.c.hold).toBeTruthy(); // ABI-pinned: detected/reported, never auto-applied
    // kotlin is pinned to an unreleased fwcd main commit for `fun interface`
    // support (#169); npm latest (0.3.8) lacks it, so the strict-inequality
    // isNewer would auto-revert the pin without this hold.
    expect(mod.GRAMMARS.kotlin.hold).toBeTruthy();
    for (const k of ['swift', 'dart', 'proto']) {
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
      expect(entry.hold).toBe(g.hold);
      // Assert the absent upstream field is explicitly undefined, not just
      // matching the manifest's absent property (avoids an undefined===undefined
      // pass that would miss the loader mis-mapping a github coord into `npm`).
      if (g.upstream.npm) {
        expect(entry.npm).toBe(g.upstream.npm);
        expect(entry.github).toBeUndefined();
      } else {
        expect(entry.github).toBe(g.upstream.github);
        expect(entry.npm).toBeUndefined();
      }
    }
  });

  it('each grammar has exactly one upstream source (npm xor github)', () => {
    for (const g of Object.values(mod.GRAMMARS)) {
      expect(Boolean(g.npm) !== Boolean(g.github)).toBe(true);
    }
  });

  it('the manifest grammar set equals the physical vendor/tree-sitter-* dirs (#858)', () => {
    // Monitor-side mirror of the Python consistency guard. The monitor is the side
    // that WRITES files from manifest `name`, so vendoring a grammar (or removing
    // one) without updating the manifest must fail CI here too.
    const vendorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor');
    const physical = readdirSync(vendorDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('tree-sitter-'))
      .map((d) => d.name)
      .sort();
    const manifestNames = Object.values(manifest.grammars)
      .map((g) => g.name)
      .sort();
    expect(manifestNames).toEqual(physical);
  });

  it('rejects a path-traversal grammar name at load (defense-in-depth)', () => {
    // `name` is joined into vendor/<name> paths and apply() writes there.
    expect(() => mod.loadManifestGrammars({ grammars: { evil: { name: '../etc' } } })).toThrow(
      /invalid grammar name/,
    );
  });
});

// Narrowing accessor: throws a clear error instead of a non-null assertion (`!`),
// which @typescript-eslint/no-non-null-assertion forbids.
function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

describe('detect() classification (offline, injected deps)', () => {
  // Drive the real detect() loop with faked network/fs seams so the load-bearing
  // gates — newer-detection, the ABI gate, and the policy hold — are exercised
  // deterministically without touching live npm/GitHub.
  const baseResolveUpstream = (g: Grammar): Upstream =>
    g.npm
      ? { version: '9.9.9', ref: '9.9.9', kind: 'npm' }
      : { version: '1.0.0-gabc1234', ref: 'abc1234def0', kind: 'github' };
  const deps: DetectDeps = {
    vendoredVersion: (g) => (g.name === 'tree-sitter-kotlin' ? '9.9.9' : '0.0.0'),
    resolveUpstream: baseResolveUpstream,
    fetchSource: (g) => g.name, // pass the name through to the fake readAbi
    readAbi: (name) => (name === 'tree-sitter-swift' ? 15 : 14),
  };
  let report: Array<Record<string, unknown>>;
  const byKey = (k: string) =>
    must(
      report.find((r) => r.grammar === k),
      `no detect row for ${k}`,
    );
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

  it('records a per-grammar error entry when resolveUpstream throws, without skipping siblings', () => {
    const report2 = mod.detect({
      ...deps,
      resolveUpstream: (g) => {
        if (g.name === 'tree-sitter-dart') throw new Error('gh api 503');
        return baseResolveUpstream(g);
      },
    });
    const dart = must(
      report2.find((r) => r.grammar === 'dart'),
      'no detect row for dart',
    );
    expect(dart.error).toContain('gh api 503');
    expect(dart.update).toBeUndefined(); // error entry, not a classification
    // The throw on one grammar must not drop the rest.
    const swift = must(
      report2.find((r) => r.grammar === 'swift'),
      'no detect row for swift',
    );
    expect(swift.update).toBe(true);
    expect(report2).toHaveLength(Object.keys(mod.GRAMMARS).length);
  });
});

describe('detect()/apply() agree on "newer" for github grammars', () => {
  // github grammars carry up.version = `<base>-g<sha7>` (the provenance string apply()
  // writes). detect() must compare the same up.version (not the bare sha7) so it stops
  // reporting a false "update" once the bot has re-vendored once (#2187 review).
  const PROV = '1.0.0-gabc1234';
  // deps for dart (github); other grammars get a harmless npm-shaped upstream so the
  // detect() loop completes — we only inspect dart.
  const dartDeps = (vendored: string): DetectDeps => ({
    vendoredVersion: (g) => (g.name === 'tree-sitter-dart' ? vendored : '0.0.0'),
    resolveUpstream: (g) =>
      g.name === 'tree-sitter-dart'
        ? { version: PROV, ref: 'abc1234def0', kind: 'github' }
        : { version: '9.9.9', ref: '9.9.9', kind: 'npm' },
    fetchSource: (g) => g.name,
    readAbi: () => 14,
  });
  const dartRow = (vendored: string) =>
    must(
      mod.detect(dartDeps(vendored)).find((r) => r.grammar === 'dart'),
      'no detect row for dart',
    );

  it('equal provenance → update:false (the asymmetry that is fixed)', () => {
    expect(dartRow(PROV).update).toBe(false);
  });

  it('first-vendoring (plain version vs provenance) → update:true (not suppressed)', () => {
    // vendored is the plain pre-bot version; up.version is `<base>-g<sha7>` → still newer.
    expect(dartRow('1.0.0').update).toBe(true);
  });

  it('upstream sha advanced → update:true', () => {
    expect(dartRow('1.0.0-g0000000').update).toBe(true);
  });
  // The detect⇄apply agreement on the equal-provenance (already-current) case is
  // asserted in U12's apply() tests — apply()'s not-newer path currently calls
  // process.exit(0), which can't be exercised in-process until U12 makes it return.
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

describe('apply() error branches throw ApplyExit (CLI maps to exit codes)', () => {
  const dartPkg = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../vendor/tree-sitter-dart/package.json',
  );
  // catch + return the thrown error's exit code (apply() throws instead of calling
  // process.exit, so the error branches are exercisable in-process).
  const codeOf = (fn: () => unknown): number => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: number }).code ?? -1;
    }
    throw new Error('expected apply() to throw');
  };

  it('unknown grammar key → exit code 2', () => {
    expect(codeOf(() => mod.apply('nope', { deps: {} }))).toBe(2);
  });

  it('held grammar (c) → exit code 3 (short-circuits before the newer check)', () => {
    expect(codeOf(() => mod.apply('c', { deps: {} }))).toBe(3);
  });

  it('ABI-incompatible candidate (15) → exit code 3', () => {
    const code = codeOf(() =>
      mod.apply('dart', {
        deps: {
          vendoredVersion: () => '0.0.0', // newer than upstream → reaches the ABI gate
          resolveUpstream: () => ({ version: '9.9.9', ref: '9.9.9abc', kind: 'github' }),
          fetchSource: () => 'unused',
          readAbi: () => 15,
        },
      }),
    );
    expect(code).toBe(3);
  });

  it('not-newer (already current) → returns the current version, no throw, no write', () => {
    const before = readFileSync(dartPkg, 'utf8');
    const deps = {
      vendoredVersion: () => '9.9.9-gabc1234',
      resolveUpstream: () => ({
        version: '9.9.9-gabc1234',
        ref: 'abc1234',
        kind: 'github' as const,
      }),
      fetchSource: () => 'unused',
      readAbi: () => 14,
    };
    // No dryRun: the not-newer path returns `have` before any fetch/copy.
    expect(mod.apply('dart', { deps })).toBe('9.9.9-gabc1234');
    expect(readFileSync(dartPkg, 'utf8')).toBe(before); // untouched
  });
});
