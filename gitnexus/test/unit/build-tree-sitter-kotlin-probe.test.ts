import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Behavioral coverage for the postinstall probe `scripts/build-tree-sitter-kotlin.cjs`.
 *
 * Kotlin is a vendored grammar (like Swift): the probe calls `node-gyp-build`
 * against the materialized package to surface a single install-time warning when
 * no prebuild matches this platform-arch, instead of a first-use runtime error.
 * Its hard invariant is that it MUST NEVER exit non-zero — it runs in
 * `gitnexus`'s postinstall, so a non-zero exit would break `npm install gitnexus`
 * for every user. This suite executes the real script bytes across its branches
 * and asserts exit code 0 every time.
 *
 * The probe is copied into an isolated temp `scripts/` dir so its
 * `__dirname`-relative `../node_modules/tree-sitter-kotlin` resolves under our
 * control (absent dir, or a present-but-no-prebuild dir) without touching the
 * repo's real node_modules.
 */

const probeSource = readFileSync(
  fileURLToPath(new URL('../../scripts/build-tree-sitter-kotlin.cjs', import.meta.url)),
  'utf8',
);

const UNAVAILABLE = 'Kotlin (.kt/.kts) parsing will be unavailable';

let tmpRoot: string;
let scriptPath: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'gn-kotlin-probe-'));
  mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
  scriptPath = path.join(tmpRoot, 'scripts', 'build-tree-sitter-kotlin.cjs');
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
  return spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8', timeout: 10_000 });
}

describe('build-tree-sitter-kotlin.cjs vendored prebuild probe', () => {
  it('exits 0 and reports skipping when GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1', () => {
    const r = runProbe({ GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1' });
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stderr).toContain('Skipping prebuild probe');
    expect(r.stderr).not.toContain(UNAVAILABLE);
  });

  it('exits 0 silently when the materialized package is absent', () => {
    // No node_modules/tree-sitter-kotlin next to the script — nothing to probe
    // (materialize was skipped/failed). Swift-style: silent exit 0.
    const r = runProbe({});
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stderr).not.toContain(UNAVAILABLE);
  });

  it('warns (and exits 0) when the package is present but no prebuild loads', () => {
    // Materialize a package shell (bindings/node/index.js present) with no
    // loadable prebuild → node-gyp-build throws → the probe must warn, not exit
    // non-zero. (Here the throw is a missing node-gyp-build resolution, an
    // equivalent trigger of the catch branch's never-fail guarantee.)
    const pkg = path.join(tmpRoot, 'node_modules', 'tree-sitter-kotlin', 'bindings', 'node');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'index.js'), '');
    try {
      const r = runProbe({});
      expect(r.status).toBe(0);
      expect(r.signal).toBeNull();
      expect(r.stderr).toContain('Prebuild probe failed');
      expect(r.stderr).toContain(UNAVAILABLE);
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
