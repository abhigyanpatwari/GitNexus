/**
 * CLI helpers shared by the mutation tools outside the oracle and the vitest5 runner. The runner
 * (runner/) stays self-contained and the oracle (oracle/) keeps its own helpers (KTD15), so
 * neither imports this module directly.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The message of a thrown value: an Error's message, else the value as a string. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether the module at `importMetaUrl` is the script Node was started with. */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(path.resolve(entry)).href;
}
