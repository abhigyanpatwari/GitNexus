import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Behavioral coverage for the consolidated activation script
 * `scripts/build-tree-sitter-grammars.cjs` (replaces the per-grammar
 * build-tree-sitter-<name>.cjs files).
 *
 * For each grammar it prefers a committed prebuild (toolchain-free); if none
 * matches it source-builds from the vendored source. Its hard invariant is that
 * it MUST NEVER exit non-zero — it runs in `gitnexus`'s postinstall, so a
 * non-zero exit would break `npm install gitnexus`. This suite runs the real
 * script bytes (targeting one grammar via the CLI arg) across its branches and
 * asserts exit code 0 every time, plus the required-vs-optional opt-out split.
 *
 * The script is copied into an isolated temp `scripts/` dir so its
 * `__dirname`-relative `../vendor/tree-sitter-<name>` resolves under our
 * control. The temp dir has no reachable `node-gyp-build` / `node-addon-api`, so
 * the source-build path stops at the "hoisted build deps not resolvable" guard
 * (still exit 0) instead of invoking a real compile.
 */

const scriptSource = readFileSync(
  fileURLToPath(new URL('../../scripts/build-tree-sitter-grammars.cjs', import.meta.url)),
  'utf8',
);

let tmpRoot: string;
let scriptPath: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'gn-grammars-build-'));
  mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
  scriptPath = path.join(tmpRoot, 'scripts', 'build-tree-sitter-grammars.cjs');
  writeFileSync(scriptPath, scriptSource);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runBuild(grammar: string, overrides: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, [scriptPath, grammar], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function materializeShell(grammar: string) {
  // A vendored grammar shell with a binding.gyp present but no prebuild / built
  // binary — mirrors `vendor/tree-sitter-<name>/` (the script's build target).
  const pkg = path.join(tmpRoot, 'vendor', `tree-sitter-${grammar}`);
  mkdirSync(path.join(pkg, 'bindings', 'node'), { recursive: true });
  writeFileSync(path.join(pkg, 'binding.gyp'), '{ "targets": [] }');
  writeFileSync(path.join(pkg, 'bindings', 'node', 'index.js'), '');
}

describe('build-tree-sitter-grammars.cjs consolidated activation', () => {
  it('optional grammar: exits 0 and reports skipping under GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1', () => {
    const r = runBuild('swift', { GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1' });
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stderr).toContain('[tree-sitter-swift] Skipping build');
    expect(r.stderr).not.toContain('Swift (.swift) parsing will be unavailable');
  });

  it('REQUIRED grammar (c): ignores GITNEXUS_SKIP_OPTIONAL_GRAMMARS (no skip message)', () => {
    // c is required — the opt-out must NOT short-circuit it. With nothing
    // materialized it silently exits 0 at the binding.gyp-absent check.
    const r = runBuild('c', { GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1' });
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stderr).not.toContain('Skipping build (GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1)');
  });

  it('exits 0 silently when the materialized package is absent (no binding.gyp)', () => {
    const r = runBuild('kotlin', {});
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stderr).not.toContain('Kotlin (.kt/.kts) parsing will be unavailable');
  });

  it('exits 0 (warning) when a grammar has a binding.gyp but no prebuild/build deps', () => {
    materializeShell('kotlin');
    try {
      const r = runBuild('kotlin', {});
      expect(r.status).toBe(0);
      expect(r.signal).toBeNull();
      expect(r.stderr).toMatch(/hoisted build deps not resolvable|Could not build native binding/);
      expect(r.stderr).not.toContain('built successfully');
    } finally {
      rmSync(path.join(tmpRoot, 'vendor'), { recursive: true, force: true });
    }
  });

  it('unknown grammar arg: warns and exits 0', () => {
    const r = runBuild('haskell', {});
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stderr).toContain("Unknown grammar 'haskell'");
  });

  it('never exits non-zero across grammars and env permutations (postinstall hard invariant)', () => {
    for (const grammar of ['c', 'dart', 'proto', 'swift', 'kotlin']) {
      for (const overrides of [{ GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1' }, {}]) {
        const r = runBuild(grammar, overrides);
        expect(r.status, `${grammar} ${JSON.stringify(overrides)}`).toBe(0);
        expect(r.signal).toBeNull();
      }
    }
  });
});
