import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { load } from 'js-yaml';

/**
 * Coverage for the FTS pairing gate `scripts/assert-publish-fts-coverage.cjs`.
 *
 * U13: a core bump must not ship a skewed extension artifact. The gate is CJS
 * with a pure pairing predicate; this suite imports that predicate and also
 * asserts the Dependabot ignore over the parsed config so removing it fails
 * a test rather than silently re-enabling daily bumps.
 */
const requireCjs = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(
  new URL('../../scripts/assert-publish-fts-coverage.cjs', import.meta.url),
);
const { findPairingProblems } = requireCjs(SCRIPT);

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GITNEXUS_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('findPairingProblems (pure pairing core)', () => {
  it('passes when the manifest pin matches the installed core', () => {
    expect(
      findPairingProblems({
        installedCoreVersion: '0.18.3',
        manifestCoreVersion: '0.18.3',
        manifestExtensionVersion: '0.18.1',
      }),
    ).toEqual([]);
  });

  it('fails when the installed core is bumped without a manifest update, naming both versions', () => {
    const problems = findPairingProblems({
      installedCoreVersion: '0.18.4',
      manifestCoreVersion: '0.18.3',
      manifestExtensionVersion: '0.18.1',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('0.18.4');
    expect(problems[0]).toContain('0.18.3');
  });
});

describe('Dependabot ignore for @ladybugdb/core', () => {
  it('ignores the core package in the gitnexus npm ecosystem so daily bumps stay off', () => {
    const raw = readFileSync(path.join(REPO_ROOT, '.github/dependabot.yml'), 'utf8');
    const parsed = load(raw) as {
      updates?: Array<{
        'package-ecosystem'?: string;
        directory?: string;
        ignore?: Array<{ 'dependency-name'?: string }>;
      }>;
    };
    const gitnexusNpm = (parsed.updates ?? []).find(
      (u) => u['package-ecosystem'] === 'npm' && u.directory === '/gitnexus',
    );
    expect(gitnexusNpm, 'expected an npm ecosystem entry for /gitnexus').toBeDefined();
    const names = (gitnexusNpm?.ignore ?? []).map((i) => i['dependency-name']);
    expect(names).toContain('@ladybugdb/core');
  });
});

describe('real repo pairing (guards against a silent core bump)', () => {
  it('the script exits 0 against the committed repo state', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 20_000 });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain('[fts-pairing] OK');
  });

  it('reads the installed core from package.json, not from a network pin', () => {
    const pkg = JSON.parse(readFileSync(path.join(GITNEXUS_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const manifest = JSON.parse(
      readFileSync(path.join(GITNEXUS_ROOT, 'vendor/lbug-fts/manifest.json'), 'utf8'),
    ) as { coreVersion: string; extensionVersion: string };
    expect(pkg.dependencies['@ladybugdb/core']).toBe(manifest.coreVersion);
    expect(manifest.extensionVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
