/**
 * Eligible test files of the scenario map (U3, R1).
 *
 * Normal runs: the mutation-eligible files are the gate 1 envelope's `accepted.files`
 * (`gitnexus/test/fixtures/mutation-oracle/envelope.json`) that a fresh run of the Phase 0
 * classifier (tools/mutation/classify) still accepts; every other test is Out of scope for
 * mutation. The scenario fingerprint needs no mutation run: it covers every `*.test.ts` under
 * `test/unit` and `test/integration` ({@link FINGERPRINT_ROOTS}; fingerprint plan F8). The
 * delta lists files the classifier accepts that the envelope does not hold (not validated by
 * gate 1) and envelope files it no longer accepts, with its reasons (`not found` for a file it
 * did not see, such as a deleted one).
 *
 * `controls` runs: both sets are the `*.case.ts` files under the fixture project, its
 * `src/` modules become production files through the extra root (KTD7), and neither the envelope
 * nor the classifier is consulted.
 *
 * Library only; the scenario-map CLI (U14) calls {@link resolveEligibility}.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { classify, type Classification } from '../../mutation/classify/classify.js';
import { buildPathMap } from '../../mutation/prepare/path-map.js';
import { readJsonFile } from '../../mutation/shared/fs.js';
import {
  extraRootsOf,
  normalizeRelativePath,
  toPackagePath,
  type Eligibility,
  type RunMode,
} from '../types.js';
import { byText, isRecord } from '../util.js';

/** Package paths of the directories whose `*.test.ts` files the fingerprint covers. */
export const FINGERPRINT_ROOTS: readonly string[] = ['test/unit', 'test/integration'];

/** Repo path of the gate 1 envelope. */
export const ENVELOPE_FILE = 'gitnexus/test/fixtures/mutation-oracle/envelope.json';

/** The classifier output eligibility needs. */
export type ClassifierVerdicts = Pick<Classification, 'accepted' | 'rejected'>;

/** The envelope's `accepted.files` (package paths); a malformed envelope throws. */
export function parseEnvelopeFiles(data: unknown): string[] {
  const accepted = isRecord(data) ? data.accepted : undefined;
  const files = isRecord(accepted) ? accepted.files : undefined;
  if (!Array.isArray(files)) throw new Error('envelope: accepted.files must be an array');
  const seen = new Set<string>();
  return files.map((file: unknown): string => {
    if (typeof file !== 'string') throw new Error('envelope: accepted.files must hold strings');
    if (seen.has(file)) throw new Error(`envelope: accepted.files lists ${file} twice`);
    seen.add(file);
    return file;
  });
}

const sorted = (files: Iterable<string>): string[] => [...files].sort(byText);

/**
 * R1 for a normal run: envelope files the classifier accepts, plus the delta, and the
 * fingerprint's files (`testFiles` with every mutation-eligible file added); pure.
 */
export function computeEligibility(
  envelopeFiles: readonly string[],
  verdicts: ClassifierVerdicts,
  testFiles: readonly string[] = [],
): Eligibility {
  const envelope = new Set(envelopeFiles);
  const accepted = new Set(verdicts.accepted);
  const reasons = new Map(verdicts.rejected.map(({ file, reasons: why }) => [file, why]));
  const files = sorted(envelopeFiles.filter((file) => accepted.has(file)));
  return {
    mode: 'normal',
    files,
    fingerprintFiles: sorted(new Set([...testFiles, ...files])),
    delta: {
      notValidated: sorted(verdicts.accepted.filter((file) => !envelope.has(file))),
      rejected: sorted(envelopeFiles.filter((file) => !accepted.has(file))).map((file) => ({
        file,
        reasons: reasons.get(file) ?? ['not found'],
      })),
    },
    extraRoots: [],
  };
}

/** Package paths of the files under `root` (a repo path) whose name ends with `suffix`, sorted. */
function listFiles(repoRoot: string, root: string, suffix: string): string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== 'node_modules') visit(child);
      else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(toPackagePath(child));
    }
  };
  visit(root);
  return sorted(found);
}

/** Package paths of the `*.case.ts` files under a fixture project (repo path), sorted. */
export function listCaseFiles(repoRoot: string, fixtureRoot: string): string[] {
  return listFiles(repoRoot, normalizeRelativePath(fixtureRoot).replace(/\/+$/, ''), '.case.ts');
}

/** Package paths of every `*.test.ts` under {@link FINGERPRINT_ROOTS} that exist, sorted. */
export function listFingerprintFiles(repoRoot: string): string[] {
  return sorted(
    FINGERPRINT_ROOTS.map((root) => `gitnexus/${root}`)
      .filter((root) => existsSync(path.join(repoRoot, root)))
      .flatMap((root) => listFiles(repoRoot, root, '.test.ts')),
  );
}

export interface ResolveEligibilityOptions {
  /** Directory holding `gitnexus/` and `gitnexus-shared/`. */
  repoRoot: string;
  mode: RunMode;
  /** Classifies the package's unit tests; defaults to a fresh `classify()` over `test/unit`. */
  classifyTests?: (repoRoot: string) => ClassifierVerdicts;
}

const classifyUnitTests = (repoRoot: string): ClassifierVerdicts => classify({ repoRoot });

/**
 * The fingerprint's test files and extra roots, without the classifier: all Layer 1 needs, as it
 * never mutates. In normal mode these are the files {@link resolveEligibility} gives, whose
 * mutation-eligible files are unit tests the fingerprint roots already hold.
 */
export function fingerprintScope(options: {
  repoRoot: string;
  mode: RunMode;
}): Pick<Eligibility, 'fingerprintFiles' | 'extraRoots'> {
  const { repoRoot, mode } = options;
  const extraRoots = extraRootsOf(mode);
  if (mode.kind === 'normal')
    return { fingerprintFiles: listFingerprintFiles(repoRoot), extraRoots };
  buildPathMap(extraRoots); // throws for a root outside gitnexus/test/fixtures/mutation-<name>
  return { fingerprintFiles: listCaseFiles(repoRoot, mode.fixtureRoot), extraRoots };
}

/** The eligible set of a run (R1; `controls` mode enrols the fixture instead). */
export function resolveEligibility(options: ResolveEligibilityOptions): Eligibility {
  const { repoRoot, mode } = options;
  const { fingerprintFiles, extraRoots } = fingerprintScope({ repoRoot, mode });
  if (mode.kind === 'controls') {
    return { mode: 'controls', files: fingerprintFiles, fingerprintFiles, delta: null, extraRoots };
  }
  const envelopeFiles = parseEnvelopeFiles(readJsonFile(path.join(repoRoot, ENVELOPE_FILE)));
  return computeEligibility(
    envelopeFiles,
    (options.classifyTests ?? classifyUnitTests)(repoRoot),
    fingerprintFiles,
  );
}
