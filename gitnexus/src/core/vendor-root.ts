import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Absolute path to the published `vendor/` tree (`<pkg>/vendor`).
 *
 * This module compiles to `<pkg>/dist/core/vendor-root.js` and runs from
 * `<pkg>/src/core/` under tsx — both sit two directories below the package
 * root. Shared so grammar loaders and the FTS artifact resolver cannot drift.
 */
export const VENDOR_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'vendor',
);
