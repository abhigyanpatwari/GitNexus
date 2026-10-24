/**
 * File-system helpers shared by the mutation tools outside the oracle and the vitest5 runner
 * (see cli.ts for why those two keep their own).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Parses a UTF-8 JSON file; the caller checks the shape. */
export const readJsonFile = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

/** True when `child` is `parent` or lies inside it. */
export const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  const escapes = relative === '..' || relative.startsWith(`..${path.sep}`);
  return !escapes && !path.isAbsolute(relative);
};
