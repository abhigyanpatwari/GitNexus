/**
 * Sidecar records of the vitest5 runner (KTD6).
 *
 * Stryker's result type has no field for the KTD17 failure classes, so every run writes one JSON
 * record to the absolute sidecar directory: `mutant-<id>.worker-<worker>.attempt-<n>.json` for a
 * mutant run and `dry-run.worker-<worker>.attempt-<n>.json` for the dry run. `<id>` is Stryker's
 * local mutant id, `<worker>` is `STRYKER_MUTATOR_WORKER` and `<n>` is the first attempt number
 * not yet taken for that mutant and worker, so a retried mutant never overwrites an earlier
 * record. The record is written to a temporary dot-file and then hard-linked to its final name,
 * which fails instead of overwriting when the name is taken; a reader never sees a half-written
 * record. A missing record means timeout or unknown: Stryker kills a timed-out process and
 * retries crashed runs.
 */
import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MutantActivation } from '@stryker-mutator/api/test-runner';
import type { RunClassification } from './classify-outcome.js';

export const SIDECAR_SCHEMA_VERSION = 1;

export type SidecarKind = 'dry-run' | 'mutant';

export interface SidecarRecord {
  schemaVersion: typeof SIDECAR_SCHEMA_VERSION;
  kind: SidecarKind;
  /** Stryker's local mutant id; null for the dry run. */
  mutantId: string | null;
  /** `STRYKER_MUTATOR_WORKER` of the runner process. */
  worker: string;
  attempt: number;
  pid: number;
  mutantActivation: MutantActivation | null;
  hitLimit: number | null;
  /** Stryker ids the run requested (the manifest's full set for a static mutant or the dry run). */
  requestedTestIds: string[];
  result: RunClassification;
}

export type SidecarDraft = Omit<SidecarRecord, 'schemaVersion' | 'attempt' | 'pid'>;

export interface SidecarIo {
  writeFile?: (file: string, data: string) => void;
}

const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');

export function sidecarFileName(
  kind: SidecarKind,
  mutantId: string | null,
  worker: string,
  attempt: number,
): string {
  const subject = kind === 'mutant' ? `mutant-${safe(mutantId ?? '')}` : 'dry-run';
  return `${subject}.worker-${safe(worker)}.attempt-${attempt}.json`;
}

const isErrnoCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

/** Writes one record; returns its final path and attempt number. */
export function writeSidecar(
  dir: string,
  draft: SidecarDraft,
  io: SidecarIo = {},
): { file: string; attempt: number } {
  if (!path.isAbsolute(dir)) {
    throw new Error(`sidecar: the sidecar directory ${JSON.stringify(dir)} must be absolute`);
  }
  const writeFile = io.writeFile ?? ((file: string, data: string) => writeFileSync(file, data));
  const temporary = path.join(
    dir,
    `.${sidecarFileName(draft.kind, draft.mutantId, draft.worker, 0)}.${process.pid}.` +
      `${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    for (let attempt = 1; ; attempt += 1) {
      const record: SidecarRecord = {
        schemaVersion: SIDECAR_SCHEMA_VERSION,
        attempt,
        pid: process.pid,
        ...draft,
      };
      writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
      const file = path.join(
        dir,
        sidecarFileName(draft.kind, draft.mutantId, draft.worker, attempt),
      );
      try {
        linkSync(temporary, file);
        return { file, attempt };
      } catch (error) {
        if (!isErrnoCode(error, 'EEXIST')) throw error;
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Reads every published record (temporary files are skipped), sorted by file name. */
export function readSidecars(dir: string): SidecarRecord[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as SidecarRecord);
}
