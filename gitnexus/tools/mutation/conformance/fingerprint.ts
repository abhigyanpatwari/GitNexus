/**
 * Input fingerprint of a gate 2 conformance run. `--compare-only` reads results an earlier run
 * left in `--out`, so before it compares them it checks that they still describe this checkout:
 * every run records the fingerprint of its inputs in its conformance-run.json, and compare-only
 * recomputes it and reports the run as stale on any difference.
 *
 * Inputs, relative to the `gitnexus/` package ({@link FINGERPRINT_ROOTS}): every file of the
 * conformance fixture project except its expected.json (compare-only is how observed facts are
 * re-checked against an edited expected file), tools/mutation/{runner,driver,prepare,shared}/,
 * tools/mutation/scope-file.ts and tools/mutation/vitest.mutation.config.ts, plus the installed
 * @stryker-mutator/core and vitest versions. The fingerprint keeps each file's sha256, so a stale
 * report can name what changed; its digest is a sha256 over the sorted file hashes and versions.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile } from '../shared/fs.js';

/** The conformance fixture project, relative to the `gitnexus/` package. */
export const FIXTURE_ROOT = 'test/fixtures/mutation-conformance';

/** Package-relative directories and files whose content decides a conformance run. */
export const FINGERPRINT_ROOTS: readonly string[] = [
  FIXTURE_ROOT,
  'tools/mutation/driver',
  'tools/mutation/prepare',
  'tools/mutation/runner',
  'tools/mutation/shared',
  'tools/mutation/scope-file.ts',
  'tools/mutation/vitest.mutation.config.ts',
];

/** Under a root, but compared rather than run: editing it does not make a run stale. */
const EXCLUDED: readonly string[] = [`${FIXTURE_ROOT}/expected.json`];

/** The start of the message for stale artefacts. */
export const STALE_ARTEFACTS = 'stale conformance artefacts; re-run without --compare-only';

const MAX_NAMED = 5;

export interface ToolVersions {
  stryker: string;
  vitest: string;
}

export interface InputFingerprint {
  /** sha256 over {@link files} and {@link versions}. */
  digest: string;
  /** Package-relative POSIX path to the sha256 of its content. */
  files: Record<string, string>;
  versions: ToolVersions;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Whether a package-relative POSIX path is a fingerprint input; pure. */
export function isFingerprintInput(file: string): boolean {
  if (EXCLUDED.includes(file)) return false;
  return FINGERPRINT_ROOTS.some((root) => file === root || file.startsWith(`${root}/`));
}

/** The fingerprint of the given file hashes and versions; pure and independent of key order. */
export function fingerprintOf(
  files: Readonly<Record<string, string>>,
  versions: ToolVersions,
): InputFingerprint {
  const sorted = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const ordered = { stryker: versions.stryker, vitest: versions.vitest };
  return {
    digest: sha256(JSON.stringify({ files: sorted, versions: ordered })),
    files: sorted,
    versions: ordered,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A recorded fingerprint, or null when the value is not one. */
export function parseFingerprint(value: unknown): InputFingerprint | null {
  if (!isRecord(value) || typeof value.digest !== 'string') return null;
  const { files, versions } = value;
  if (!isRecord(files)) return null;
  const hashes = Object.entries(files).flatMap(([file, hash]): [string, string][] =>
    typeof hash === 'string' ? [[file, hash]] : [],
  );
  if (hashes.length !== Object.keys(files).length) return null;
  if (
    !isRecord(versions) ||
    typeof versions.stryker !== 'string' ||
    typeof versions.vitest !== 'string'
  ) {
    return null;
  }
  return {
    digest: value.digest,
    files: Object.fromEntries(hashes),
    versions: { stryker: versions.stryker, vitest: versions.vitest },
  };
}

/**
 * Null when a run recorded the current fingerprint, else the stale-artefacts message naming what
 * changed (files added, removed or edited since the run, and version changes); pure.
 */
export function staleConformance(recorded: unknown, current: InputFingerprint): string | null {
  const run = parseFingerprint(recorded);
  if (run === null) return `${STALE_ARTEFACTS} (the run records no input fingerprint)`;
  // The recorded digest must also match the recorded files and versions it claims to cover.
  const consistent = fingerprintOf(run.files, run.versions).digest === run.digest;
  if (consistent && run.digest === current.digest) return null;
  const paths = [...new Set([...Object.keys(run.files), ...Object.keys(current.files)])].sort();
  const changed = paths.filter((file) => run.files[file] !== current.files[file]);
  const details = [
    ...(changed.length === 0
      ? []
      : [
          `changed since the run: ${changed.slice(0, MAX_NAMED).join(', ')}` +
            (changed.length > MAX_NAMED ? ` and ${changed.length - MAX_NAMED} more` : ''),
        ]),
    ...(run.versions.stryker === current.versions.stryker
      ? []
      : [`Stryker ${run.versions.stryker} -> ${current.versions.stryker}`]),
    ...(run.versions.vitest === current.versions.vitest
      ? []
      : [`Vitest ${run.versions.vitest} -> ${current.versions.vitest}`]),
  ];
  const detail =
    details.length === 0 ? 'the recorded input digest does not match' : details.join('; ');
  return `${STALE_ARTEFACTS} (${detail})`;
}

/** Every regular file under `dir`, as absolute paths. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() ? [full] : [];
  });
}

function installedVersion(packageDir: string, name: string): string {
  const file = path.join(packageDir, 'node_modules', name, 'package.json');
  const data = readJsonFile(file);
  if (!isRecord(data) || typeof data.version !== 'string') {
    throw new Error(`${file} names no version`);
  }
  return data.version;
}

/** The fingerprint of the checkout's inputs and installed tools (`packageDir` is `gitnexus/`). */
export function currentFingerprint(packageDir: string): InputFingerprint {
  const files: Record<string, string> = {};
  for (const root of FINGERPRINT_ROOTS) {
    const absolute = path.join(packageDir, root);
    const found = root.endsWith('.ts') ? [absolute] : walk(absolute);
    for (const file of found) {
      const relative = path.relative(packageDir, file).split(path.sep).join('/');
      if (isFingerprintInput(relative)) files[relative] = sha256(readFileSync(file));
    }
  }
  return fingerprintOf(files, {
    stryker: installedVersion(packageDir, '@stryker-mutator/core'),
    vitest: installedVersion(packageDir, 'vitest'),
  });
}
