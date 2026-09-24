import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json') as { version?: unknown };

/**
 * Published version from this package's `package.json`.
 * Empty string if the field is missing or not a string.
 */
export function packageVersion(): string {
  return typeof pkg.version === 'string' ? pkg.version : '';
}
