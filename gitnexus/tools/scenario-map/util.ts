/**
 * Small helpers the scenario-map modules share: the text and numeric comparators, sorted distinct
 * strings, the record guard, sha1 and sha256 hex digests, the two POSIX path forms and the JSON
 * work-file writer. Read JSON with tools/mutation/shared/fs.ts `readJsonFile`.
 *
 * The worker-side modules Vitest loads in the prepared copy (path-coverage/coverage.setup.ts and
 * records.ts, value-flow/trace.setup.ts and trace-records.ts) keep their own copies: they stay
 * self-contained and never import this file.
 *
 * Library only.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** UTF-16 code-unit order of two strings (what `<` compares), never locale-aware. */
export const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Ascending numeric order. */
export const ascending = (a: number, b: number): number => a - b;

/** Whether two lists hold the same values in the same order. */
export const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** The distinct values, sorted by {@link byText}. */
export const sortedUnique = <T extends string>(values: Iterable<T>): T[] =>
  [...new Set(values)].sort(byText);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Hex sha1 of a string (UTF-8). */
export const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

/** Hex sha256 of a string (UTF-8) or of bytes. */
export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

/** Every backslash as `/`: a path written on any platform (a V8 URL, a module id, a record). */
export const toPosixSeparators = (file: string): string => file.replace(/\\/g, '/');

/**
 * This platform's separator as `/`: a path `node:path` built. A no-op on POSIX, where a
 * backslash is a file-name character ({@link toPosixSeparators} would rewrite it).
 */
export const toPosixRelative = (file: string): string => file.split(path.sep).join('/');

/**
 * Writes `value` as JSON and a newline, compact unless `pretty` (two-space indent), creating the
 * file's directory first.
 */
export function writeJson(file: string, value: unknown, pretty = false): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`);
}
