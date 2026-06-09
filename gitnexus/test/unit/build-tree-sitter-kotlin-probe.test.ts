import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Behavioral coverage for the postinstall probe `scripts/build-tree-sitter-kotlin.cjs`.
 *
 * The probe's hard invariant is that it MUST NEVER exit non-zero — it runs in
 * `gitnexus`'s postinstall, so a non-zero exit would break `npm install gitnexus`
 * for every user. The static package.json assertion in `cli-commands.test.ts`
 * only checks wiring (the script is referenced in `postinstall`); it never runs
 * the probe, so a regression that turned an `exit(0)` into `exit(1)`/`throw`
 * would ship undetected. This suite executes the real script bytes across its
 * branches and asserts exit code 0 every time.
 *
 * To exercise the "package absent" branches without mutating the repo's real
 * node_modules, the probe is copied into an isolated temp `scripts/` dir; its
 * `__dirname`-relative `../node_modules/tree-sitter-kotlin` then resolves to a
 * non-existent path — the exact state npm leaves behind after it prunes the
 * failed optional dependency on a toolchain-less host (see #2107 / PR #2110).
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
  const scriptsDir = path.join(tmpRoot, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  scriptPath = path.join(scriptsDir, 'build-tree-sitter-kotlin.cjs');
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
  // Normalize the two variables under test so the case is deterministic even
  // when the test runner itself was launched under npm with these set.
  delete env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS;
  delete env.npm_config_omit;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8', timeout: 10_000 });
}

describe('build-tree-sitter-kotlin.cjs install probe', () => {
  it('exits 0 and reports skipping when GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1', () => {
    const r = runProbe({ GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1' });
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stderr).toContain('Skipping native-binding probe');
    expect(r.stderr).not.toContain(UNAVAILABLE);
  });

  it('warns (and exits 0) when the package is absent and optionals were not omitted', () => {
    // Regression guard for #2107 / PR #2110: npm prunes the failed optional
    // dependency on a toolchain-less host, so the probe must surface its guidance
    // on the dir-absent branch rather than silently exiting.
    const r = runProbe({});
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stderr).toContain(UNAVAILABLE);
  });

  it('stays silent (and exits 0) when optionals were deliberately omitted (omit=optional)', () => {
    const r = runProbe({ npm_config_omit: 'optional' });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain(UNAVAILABLE);
  });

  it('treats a comma-joined list (dev,optional) as an opt-out and stays silent', () => {
    const r = runProbe({ npm_config_omit: 'dev,optional' });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain(UNAVAILABLE);
  });

  it('still warns when only non-optional groups are omitted (omit=dev)', () => {
    const r = runProbe({ npm_config_omit: 'dev' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(UNAVAILABLE);
  });

  it('never exits non-zero across env permutations (postinstall hard invariant)', () => {
    const permutations: Record<string, string | undefined>[] = [
      { GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1' },
      {},
      { npm_config_omit: 'optional' },
      { npm_config_omit: 'dev,optional' },
      { npm_config_omit: 'dev' },
    ];
    for (const overrides of permutations) {
      const r = runProbe(overrides);
      expect(r.status).toBe(0);
      expect(r.signal).toBeNull();
    }
  });
});
