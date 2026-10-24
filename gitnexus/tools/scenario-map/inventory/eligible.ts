/**
 * Eligible test files of the scenario map (U3, R1).
 *
 * Normal runs: the eligible files are the gate 1 envelope's `accepted.files`
 * (`gitnexus/test/fixtures/mutation-oracle/envelope.json`) that a fresh run of the Phase 0
 * classifier (tools/mutation/classify) still accepts. Every other test is Out of scope. The
 * delta lists files the classifier accepts that the envelope does not hold (not validated by
 * gate 1) and envelope files it no longer accepts, with its reasons (`not found` for a file it
 * did not see, such as a deleted one).
 *
 * `controls` runs: the eligible files are the `*.case.ts` files under the fixture project, its
 * `src/` modules become production files through the extra root (KTD7), and neither the envelope
 * nor the classifier is consulted.
 *
 * Library only; the scenario-map CLI (U14) calls {@link resolveEligibility}.
 */
import { readdirSync } from 'node:fs';
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

/** Repo path of the gate 1 envelope. */
export const ENVELOPE_FILE = 'gitnexus/test/fixtures/mutation-oracle/envelope.json';

/** The classifier output eligibility needs. */
export type ClassifierVerdicts = Pick<Classification, 'accepted' | 'rejected'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const sorted = (files: Iterable<string>): string[] =>
  [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** R1 for a normal run: envelope files the classifier accepts, plus the delta; pure. */
export function computeEligibility(
  envelopeFiles: readonly string[],
  verdicts: ClassifierVerdicts,
): Eligibility {
  const envelope = new Set(envelopeFiles);
  const accepted = new Set(verdicts.accepted);
  const reasons = new Map(verdicts.rejected.map(({ file, reasons: why }) => [file, why]));
  return {
    mode: 'normal',
    files: sorted(envelopeFiles.filter((file) => accepted.has(file))),
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

/** Package paths of the `*.case.ts` files under a fixture project (repo path), sorted. */
export function listCaseFiles(repoRoot: string, fixtureRoot: string): string[] {
  const root = normalizeRelativePath(fixtureRoot).replace(/\/+$/, '');
  const found: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== 'node_modules') visit(child);
      else if (entry.isFile() && entry.name.endsWith('.case.ts')) found.push(toPackagePath(child));
    }
  };
  visit(root);
  return sorted(found);
}

export interface ResolveEligibilityOptions {
  /** Directory holding `gitnexus/` and `gitnexus-shared/`. */
  repoRoot: string;
  mode: RunMode;
  /** Classifies the package's unit tests; defaults to a fresh `classify()` over `test/unit`. */
  classifyTests?: (repoRoot: string) => ClassifierVerdicts;
}

const classifyUnitTests = (repoRoot: string): ClassifierVerdicts => classify({ repoRoot });

/** The eligible set of a run (R1; `controls` mode enrols the fixture instead). */
export function resolveEligibility(options: ResolveEligibilityOptions): Eligibility {
  const { repoRoot, mode } = options;
  if (mode.kind === 'controls') {
    const extraRoots = extraRootsOf(mode);
    buildPathMap(extraRoots); // throws for a root outside gitnexus/test/fixtures/mutation-<name>
    return {
      mode: 'controls',
      files: listCaseFiles(repoRoot, mode.fixtureRoot),
      delta: null,
      extraRoots,
    };
  }
  const envelopeFiles = parseEnvelopeFiles(readJsonFile(path.join(repoRoot, ENVELOPE_FILE)));
  return computeEligibility(envelopeFiles, (options.classifyTests ?? classifyUnitTests)(repoRoot));
}
