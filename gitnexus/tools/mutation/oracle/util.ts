/**
 * Helpers of the oracle's own modules (KTD15: nothing here comes from the vitest5 runner). Node
 * built-ins only and no side effects, because the modules that run inside Vitest workers
 * (oracle-setup.ts, probe.ts, command-wrapper.ts) import it too.
 */
import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Writes `text` to `.<name>.<pid>.tmp` beside `file`, then renames it over `file`. */
export function writeFileAtomicSync(file: string, text: string): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}
