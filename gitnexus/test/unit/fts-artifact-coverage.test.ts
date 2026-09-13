import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
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
const {
  findPairingProblems,
  findArtifactProblems,
  filesCoverFtsArtifacts,
  parseSha256Sums,
  supportedTuplesFromManifest,
} = requireCjs(SCRIPT);

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
      files: string[];
    };
    const manifest = JSON.parse(
      readFileSync(path.join(GITNEXUS_ROOT, 'vendor/lbug-fts/manifest.json'), 'utf8'),
    ) as { coreVersion: string; extensionVersion: string };
    expect(pkg.dependencies['@ladybugdb/core']).toBe(manifest.coreVersion);
    expect(manifest.extensionVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.files).toContain('vendor');
  });
});

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const FILENAME = 'libfts.lbug_extension';
const TUPLES = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'] as const;

const presentArtifacts = Object.fromEntries(
  TUPLES.map((tuple) => [tuple, { exists: true, hash: HASH_A, sizeBytes: 100 }]),
);
const matchingChecksums = Object.fromEntries(
  TUPLES.map((tuple) => [`${tuple}/${FILENAME}`, HASH_A]),
);

describe('findArtifactProblems (U1 integrity gate)', () => {
  it('passes when every tuple exists, hashes match, files cover vendor, and win32-arm64 is unsupported', () => {
    expect(
      findArtifactProblems({
        tuples: [...TUPLES],
        unsupportedTuples: ['win32-arm64'],
        filesField: ['dist', 'vendor'],
        checksumByRelPath: matchingChecksums,
        artifactByTuple: presentArtifacts,
        filename: FILENAME,
      }),
    ).toEqual([]);
  });

  it('fails when a tuple directory is removed', () => {
    const { 'linux-arm64': _removed, ...rest } = presentArtifacts;
    const problems = findArtifactProblems({
      tuples: [...TUPLES],
      unsupportedTuples: ['win32-arm64'],
      filesField: ['vendor'],
      checksumByRelPath: matchingChecksums,
      artifactByTuple: rest,
      filename: FILENAME,
    });
    expect(problems.some((p) => p.includes('missing artifact for linux-arm64'))).toBe(true);
  });

  it('fails when a checksum is edited to a wrong value', () => {
    const problems = findArtifactProblems({
      tuples: [...TUPLES],
      unsupportedTuples: ['win32-arm64'],
      filesField: ['vendor'],
      checksumByRelPath: { ...matchingChecksums, [`linux-x64/${FILENAME}`]: HASH_B },
      artifactByTuple: presentArtifacts,
      filename: FILENAME,
    });
    expect(problems.some((p) => p.includes('checksum mismatch for linux-x64'))).toBe(true);
    expect(problems.some((p) => p.includes(HASH_B) && p.includes(HASH_A))).toBe(true);
  });

  it('passes with win32-arm64 absent because it is declared unsupported', () => {
    expect(presentArtifacts['win32-arm64']).toBeUndefined();
    expect(
      findArtifactProblems({
        tuples: [...TUPLES],
        unsupportedTuples: ['win32-arm64'],
        filesField: ['vendor'],
        checksumByRelPath: matchingChecksums,
        artifactByTuple: presentArtifacts,
        filename: FILENAME,
      }),
    ).toEqual([]);
  });

  it('fails when a files entry stops covering the artifact path', () => {
    const problems = findArtifactProblems({
      tuples: [...TUPLES],
      unsupportedTuples: ['win32-arm64'],
      filesField: ['dist', 'vendor/**/package.json'],
      checksumByRelPath: matchingChecksums,
      artifactByTuple: presentArtifacts,
      filename: FILENAME,
    });
    expect(problems.some((p) => p.includes('files no longer covers'))).toBe(true);
  });
});

describe('filesCoverFtsArtifacts', () => {
  it('accepts a broad vendor entry and the lean-publish prebuilds glob', () => {
    expect(filesCoverFtsArtifacts(['vendor'])).toBe(true);
    expect(filesCoverFtsArtifacts(['vendor/**/prebuilds/**'])).toBe(true);
    expect(filesCoverFtsArtifacts(['dist'])).toBe(false);
  });
});

describe('committed FTS artifacts and fetch-script placement', () => {
  it('every manifest-listed file exists with a matching SHA-256', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(GITNEXUS_ROOT, 'vendor/lbug-fts/manifest.json'), 'utf8'),
    );
    const tuples = supportedTuplesFromManifest(manifest);
    const sums = parseSha256Sums(
      readFileSync(path.join(GITNEXUS_ROOT, 'vendor/lbug-fts/prebuilds/SHA256SUMS'), 'utf8'),
    );
    expect(tuples).toEqual([...TUPLES]);
    for (const tuple of tuples) {
      const rel = `${tuple}/${manifest.filename}`;
      const filePath = path.join(GITNEXUS_ROOT, 'vendor/lbug-fts/prebuilds', rel);
      expect(existsSync(filePath), rel).toBe(true);
      const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex');
      expect(sums[rel], rel).toBe(actual);
      expect(readFileSync(filePath).byteLength).toBeGreaterThan(1024 * 1024);
    }
  });

  it('keeps the fetch script outside the published package', () => {
    const pkg = JSON.parse(readFileSync(path.join(GITNEXUS_ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).not.toContain('.github');
    expect(pkg.files.some((f) => String(f).includes('fetch-lbug-fts'))).toBe(false);
    expect(
      readFileSync(path.join(REPO_ROOT, '.github/scripts/fetch-lbug-fts-artifacts.mjs'), 'utf8'),
    ).toContain('vendor/lbug-fts/prebuilds');
  });
});
