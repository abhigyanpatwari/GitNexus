import { CPP_HEADER_EXTENSIONS, scanCFamilyHeaders } from '../c/resolution-config.js';

/**
 * Walk `repoPath` and return relative paths of C++ headers
 * (`.h`, `.hpp`, `.hxx`, `.hh`, `.cuh`).
 */
export function scanCppHeaderFiles(repoPath: string): ReadonlySet<string> {
  return scanCFamilyHeaders(repoPath, CPP_HEADER_EXTENSIONS).headers;
}
