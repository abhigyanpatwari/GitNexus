import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Behavioral coverage for the postinstall activation script
 * `scripts/build-tree-sitter-swift.cjs`.
 *
 * Swift is a vendored grammar, unified with Kotlin/Dart/Proto/C: the script
 * prefers a committed prebuild for this platform-arch (toolchain-free); if none
 * matches it source-builds from the vendored grammar source. Its hard invariant
 * is that it MUST NEVER exit non-zero — it runs in `gitnexus`'s postinstall, so a
 * non-zero exit would break `npm install gitnexus` for every user. This suite
 * executes the real script bytes across its branches and asserts exit code 0
 * every time (mirrors build-tree-sitter-kotlin-probe.test.ts).
 *
 * The script is copied into an isolated temp `scripts/` dir so its
 * `__dirname`-relative `../node_modules/tree-sitter-swift` resolves under our
 * control. The temp dir has no reachable `node-gyp-build` / `node-addon-api`, so
 * the source-build path stops at the "hoisted build deps not resolvable" guard
 * (still exit 0) instead of invoking a real compile.
 */

const probeSource = readFileSync(
  fileURLToPath(new URL('../../scripts/build-tree-sitter-swift.cjs', import.meta.url)),
  'utf8',
);

// Catch-branch sentinel (only printed when an actual node-gyp build is attempted
// and throws) — must NOT appear on the deps-unavailable guard path.
const CATCH_UNAVAILABLE = 'Swift (.swift) parsing will be unavailable';

let tmpRoot: string;
let scriptPath: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'gn-swift-build-'));
  mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
  scriptPath = path.join(tmpRoot, 'scripts', 'build-tree-sitter-swift.cjs');
  writeFileSync(scriptPath, probeSource);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runProbe(overrides: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8', timeout: 30_000 });
}

describe('build-tree-sitter-swift.cjs vendored grammar activation', () => {
  it('exits 0 and reports skipping when GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1', () => {
    const r = runProbe({ GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1' });
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stderr).toContain('Skipping build');
    expect(r.stderr).not.toContain(CATCH_UNAVAILABLE);
  });

  it('exits 0 silently when the materialized package is absent (no binding.gyp)', () => {
    // No node_modules/tree-sitter-swift next to the script — materialize was
    // skipped/failed, so there is no binding.gyp to build. Silent exit 0.
    const r = runProbe({});
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stderr).not.toContain(CATCH_UNAVAILABLE);
  });

  it('exits 0 (warning) when the package has a binding.gyp but no prebuild/build deps', () => {
    // Materialize a package with binding.gyp present but no prebuild and no
    // build/Release/*.node. The script falls through prefer-prebuild to the
    // source-build path; in this temp env node-gyp-build/node-addon-api are not
    // resolvable, so it stops at the deps guard (or, if they were resolvable,
    // the node-gyp build would fail) — either way it warns and exits 0.
    const pkg = path.join(tmpRoot, 'node_modules', 'tree-sitter-swift');
    mkdirSync(path.join(pkg, 'bindings', 'node'), { recursive: true });
    writeFileSync(path.join(pkg, 'binding.gyp'), '{ "targets": [] }');
    writeFileSync(path.join(pkg, 'bindings', 'node', 'index.js'), '');
    try {
      const r = runProbe({});
      expect(r.status).toBe(0);
      expect(r.signal).toBeNull();
      expect(r.stderr).toMatch(/hoisted build deps not resolvable|Could not build native binding/);
      expect(r.stderr).not.toContain('built successfully');
    } finally {
      rmSync(path.join(tmpRoot, 'node_modules'), { recursive: true, force: true });
    }
  });

  it('never exits non-zero across env permutations (postinstall hard invariant)', () => {
    for (const overrides of [{ GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1' }, {}]) {
      const r = runProbe(overrides);
      expect(r.status).toBe(0);
      expect(r.signal).toBeNull();
    }
  });
});
