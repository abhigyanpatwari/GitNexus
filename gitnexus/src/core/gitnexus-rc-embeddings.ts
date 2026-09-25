/**
 * Auto-sync reads embeddings settings from a cloned repo's `.gitnexusrc`
 * without importing CLI modules (`src/core` must not import `src/cli`).
 * Invalid JSON fails the analyze for that repo the same way CLI analyze fails closed.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AnalyzeOptions } from './run-analyze.js';

export const GITNEXUS_RC_FILENAME = '.gitnexusrc';

export class AutoSyncGitnexusRcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoSyncGitnexusRcError';
  }
}

export function embeddingsFromGitnexusRc(
  repoRoot: string,
): Pick<AnalyzeOptions, 'embeddings' | 'embeddingsNodeLimit'> {
  const filePath = path.join(repoRoot, GITNEXUS_RC_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw new AutoSyncGitnexusRcError(
      `Could not read ${GITNEXUS_RC_FILENAME}: ${(err as Error).message}`,
    );
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AutoSyncGitnexusRcError(
      `${GITNEXUS_RC_FILENAME} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AutoSyncGitnexusRcError(`${GITNEXUS_RC_FILENAME} must contain a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  let embeddingsVal: unknown = obj.embeddings;
  if (obj.analyze && typeof obj.analyze === 'object' && !Array.isArray(obj.analyze)) {
    const nested = obj.analyze as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(nested, 'embeddings')) {
      embeddingsVal = nested.embeddings;
    }
  }
  if (embeddingsVal === undefined) return {};
  if (typeof embeddingsVal === 'boolean') {
    return embeddingsVal ? { embeddings: true } : { embeddings: false };
  }
  if (typeof embeddingsVal === 'number') {
    if (!Number.isInteger(embeddingsVal) || embeddingsVal < 0) {
      throw new AutoSyncGitnexusRcError(
        `${GITNEXUS_RC_FILENAME} embeddings must be true/false or a non-negative integer`,
      );
    }
    return { embeddings: true, embeddingsNodeLimit: embeddingsVal };
  }
  throw new AutoSyncGitnexusRcError(
    `${GITNEXUS_RC_FILENAME} embeddings must be a boolean or a non-negative integer`,
  );
}
