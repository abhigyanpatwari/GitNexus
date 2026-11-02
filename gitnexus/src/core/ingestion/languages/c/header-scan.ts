import { C_HEADER_EXTENSIONS, scanCFamilyHeaders } from './resolution-config.js';

/**
 * Walk `repoPath` and return relative paths of all `.h` files.
 * Search paths stay on the workspace config; this is only the header set.
 */
export function scanHeaderFiles(repoPath: string): ReadonlySet<string> {
  return scanCFamilyHeaders(repoPath, C_HEADER_EXTENSIONS).headers;
}
