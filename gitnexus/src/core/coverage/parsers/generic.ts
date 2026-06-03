// gitnexus/src/core/coverage/parsers/generic.ts
import type { CanonicalCoverage } from '../types.js';

export function parseGenericCoverage(input: string): CanonicalCoverage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    throw new Error(`Invalid JSON in coverage input: ${(e as Error).message}`);
  }

  if (!isCanonicalCoverage(parsed)) {
    throw new Error('Coverage JSON does not match gitnexus-coverage-v1 schema');
  }

  return parsed;
}

function isCanonicalCoverage(obj: unknown): obj is CanonicalCoverage {
  if (typeof obj !== 'object' || obj === null) return false;
  const c = obj as Record<string, unknown>;

  if (c.format !== 'gitnexus-coverage-v1') return false;
  if (typeof c.run !== 'object' || c.run === null) return false;

  const run = c.run as Record<string, unknown>;
  if (typeof run.id !== 'string') return false;
  if (typeof run.timestamp !== 'string') return false;

  if (typeof c.files !== 'object' || c.files === null) return false;

  for (const [, fileCov] of Object.entries(c.files as Record<string, unknown>)) {
    if (typeof fileCov !== 'object' || fileCov === null) return false;
    const fc = fileCov as Record<string, unknown>;
    if (typeof fc.lines !== 'object' || fc.lines === null) return false;
  }

  return true;
}
