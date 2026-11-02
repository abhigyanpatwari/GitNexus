/**
 * Layer 1 in slices (fingerprint plan E5). One CI job cannot run every unit and integration test
 * of the fingerprint's scope within its timeout, so the `coverage` stage runs one slice of the
 * files and the `plan` stage merges the slices' work files instead of running Layer 1 itself.
 *
 * {@link coverageSlices} splits the files the way the CI test shards are balanced
 * (test/helpers/shard-balance.ts: measured seconds for the slow sequential files, file size for the
 * rest); the split is deterministic for one checkout, so the plan recomputes it to check each slice
 * and to name the files of a slice that did not report. {@link mergeCoverageSlices} joins the
 * slices' work files into the work file one Layer 1 run would write: one block table, every
 * test's indices remapped to it, files and tests in file order. A slice that did not report leaves
 * its files unrecorded with an error, so their tests are absent from the fingerprint and the report
 * counts the files as unrecorded. A slice that disagrees with the plan (other files, slice count,
 * mode, extra roots or repeats: another checkout or `--mutation`) stops the merge.
 *
 * Slice file `coverage-slice-<index>.json` (schema version {@link COVERAGE_SLICE_SCHEMA_VERSION}):
 *   index, of     the slice and the number of slices
 *   layer1        every test file Layer 1 runs (package paths), before the split: the plan takes
 *                 it from the slices instead of recomputing it, and re-splits it with
 *                 {@link coverageSlices} (each slice's work file lists exactly its share)
 *   mutation      the run's mutation scope, which chose `layer1`
 *   changed       a diff-scoped run's changed test files (`--changed-since`); null for the suite
 *   revision      the checkout's commit (`git rev-parse HEAD`); null when unknown
 *   work          the slice's work file (run-coverage.ts {@link CoverageWorkFile})
 *
 * Library only; pure but for {@link coverageSlices}, which stats the test files, and
 * {@link readCoverageSlices}.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { assignShards, specWeight } from '../../../test/helpers/shard-balance.js';
import { readJsonFile } from '../../mutation/shared/fs.js';
import { MUTATION_SCOPES, type MutationScope } from '../types.js';
import { byText, isRecord, sameList, sortedUnique } from '../util.js';
import { mergeFixtureSources } from '../consolidation/fixture-sources.js';
import {
  WORK_FILE_SCHEMA_VERSION,
  unknownProvenance,
  type CoverageFile,
  type CoverageTest,
  type CoverageWorkFile,
} from './run-coverage.js';

export const COVERAGE_SLICE_SCHEMA_VERSION = 1;

export interface CoverageSliceFile {
  schemaVersion: typeof COVERAGE_SLICE_SCHEMA_VERSION;
  index: number;
  of: number;
  layer1: string[];
  mutation: MutationScope;
  changed: string[] | null;
  revision: string | null;
  work: CoverageWorkFile;
}

/** The slice file name of slice `index`. */
export const coverageSliceName = (index: number): string => `coverage-slice-${index}.json`;
const SLICE_NAME = /^coverage-slice-(\d+)\.json$/;

/**
 * The test files (package paths, `packageDir` the checkout's package) in `of` slices of about equal
 * work, each sorted; deterministic for one checkout.
 */
export function coverageSlices(
  files: readonly string[],
  of: number,
  packageDir: string,
  isSequential: (file: string) => boolean,
): string[][] {
  return assignShards(
    files,
    of,
    (file) =>
      specWeight({
        moduleId: path.join(packageDir, file),
        project: { config: isSequential(file) ? { fileParallelism: false } : {} },
      }),
    (file) => file,
  ).map((slice) => [...slice].sort(byText));
}

/**
 * The work file of the reported slices (`assignment` from {@link coverageSlices}); a slice that ran
 * other files, disagrees with the first on its Layer 1 files, mutation scope, changed files,
 * revision, mode, extra roots or repeats, or reports twice throws.
 */
export function mergeCoverageSlices(
  assignment: readonly (readonly string[])[],
  reported: readonly CoverageSliceFile[],
): CoverageWorkFile {
  const slices = [...reported].sort((a, b) => a.index - b.index);
  const [first] = slices;
  if (first === undefined) throw new Error('coverage: no slice reported');
  const seen = new Set<number>();
  for (const slice of slices) {
    const expected = assignment[slice.index];
    if (slice.of !== assignment.length || expected === undefined) {
      throw new Error(
        `coverage: slice ${slice.index} of ${slice.of}, expected ${assignment.length}`,
      );
    }
    if (seen.has(slice.index)) throw new Error(`coverage: slice ${slice.index} reported twice`);
    seen.add(slice.index);
    if (
      !sameList(
        slice.work.files.map((file) => file.file),
        expected,
      )
    ) {
      throw new Error(`coverage: slice ${slice.index} ran other files than its share`);
    }
    const { mode, repeats, extraRoots } = slice.work;
    if (
      !sameList(slice.layer1, first.layer1) ||
      slice.mutation !== first.mutation ||
      !sameList(slice.changed ?? [], first.changed ?? []) ||
      (slice.changed === null) !== (first.changed === null) ||
      slice.revision !== first.revision ||
      mode !== first.work.mode ||
      repeats !== first.work.repeats ||
      slice.work.fixtureCaptureVersion !== first.work.fixtureCaptureVersion ||
      !sameList(extraRoots, first.work.extraRoots)
    ) {
      throw new Error(`coverage: slice ${slice.index} is not the run of slice ${first.index}`);
    }
  }

  const blocks = sortedUnique(slices.flatMap((slice) => slice.work.blocks));
  const at = new Map(blocks.map((id, index) => [id, index]));
  const remap = (table: readonly string[], indices: readonly number[]): number[] =>
    indices.flatMap((index) => {
      const merged = at.get(table[index]);
      return merged === undefined ? [] : [merged];
    });
  const tests: CoverageTest[] = slices.flatMap((slice) =>
    slice.work.tests.map((test) => ({
      ...test,
      blocks: remap(slice.work.blocks, test.blocks),
      suiteBlocks: remap(slice.work.blocks, test.suiteBlocks),
    })),
  );
  const missing: CoverageFile[] = assignment.flatMap((files, index) =>
    seen.has(index)
      ? []
      : files.map((file) => ({
          file,
          recorded: false,
          errors: [`coverage slice ${index} of ${assignment.length} did not report`],
          unattributed: unknownProvenance(),
        })),
  );
  return {
    schemaVersion: WORK_FILE_SCHEMA_VERSION,
    ...(slices.some((slice) => slice.work.fixtureSources !== undefined)
      ? { fixtureSources: mergeFixtureSources(slices.map((slice) => slice.work.fixtureSources)) }
      : {}),
    ...(first.work.fixtureCaptureVersion === undefined
      ? {}
      : { fixtureCaptureVersion: first.work.fixtureCaptureVersion }),
    mode: first.work.mode,
    extraRoots: [...first.work.extraRoots],
    repeats: first.work.repeats,
    blocks,
    files: [...slices.flatMap((slice) => slice.work.files), ...missing].sort((a, b) =>
      byText(a.file, b.file),
    ),
    // Stable: collection order within a file.
    tests: tests.sort((a, b) => byText(a.file, b.file)),
    unhandledErrors: slices.flatMap((slice) => slice.work.unhandledErrors),
  };
}

const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isSliceFile = (value: unknown): value is CoverageSliceFile =>
  isRecord(value) &&
  value.schemaVersion === COVERAGE_SLICE_SCHEMA_VERSION &&
  isIndex(value.index) &&
  isIndex(value.of) &&
  value.index < value.of &&
  Array.isArray(value.layer1) &&
  value.layer1.every((file: unknown) => typeof file === 'string') &&
  MUTATION_SCOPES.some((scope) => scope === value.mutation) &&
  (value.changed === null ||
    (Array.isArray(value.changed) &&
      value.changed.every((file: unknown) => typeof file === 'string'))) &&
  (value.revision === null || typeof value.revision === 'string') &&
  isRecord(value.work) &&
  value.work.schemaVersion === WORK_FILE_SCHEMA_VERSION;

/** The slice files in a directory (other files are ignored); a malformed slice file throws. */
export function readCoverageSlices(dir: string): CoverageSliceFile[] {
  return readdirSync(dir)
    .filter((name) => SLICE_NAME.test(name))
    .sort(byText)
    .map((name) => {
      const data = readJsonFile(path.join(dir, name));
      if (!isSliceFile(data)) throw new Error(`coverage: ${name} is not a coverage slice file`);
      return data;
    });
}
