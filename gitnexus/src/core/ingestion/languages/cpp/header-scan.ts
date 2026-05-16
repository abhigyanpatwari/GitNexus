import { readdirSync, type Dirent } from 'fs';
import { join, relative } from 'path';

/** C++ header extensions to scan for in the workspace. */
const HEADER_EXTENSIONS = new Set(['.h', '.hpp', '.hxx', '.hh']);

/**
 * Walk `repoPath` recursively and return relative paths of all C++ header files.
 * Used by `loadResolutionConfig` so the C++ resolver can resolve `#include`
 * targets that live in header files.
 *
 * Scans for: .h, .hpp, .hxx, .hh
 */
export function scanCppHeaderFiles(repoPath: string): ReadonlySet<string> {
  const headers = new Set<string>();
  walk(repoPath, repoPath, headers);
  return headers;
}

function walk(dir: string, root: string, out: Set<string>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return; // permission denied, etc.
  }
  for (const entry of entries) {
    const name = entry.name;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      if (
        name === 'node_modules' ||
        name === '.git' ||
        name === 'vendor' ||
        name === 'dist' ||
        name === 'build' ||
        name === 'out' ||
        name === 'target' ||
        name === '_build' ||
        name === '.next' ||
        name.startsWith('cmake-build')
      ) {
        continue;
      }
      walk(full, root, out);
    } else if (entry.isFile()) {
      const ext = name.slice(name.lastIndexOf('.'));
      if (HEADER_EXTENSIONS.has(ext)) {
        out.add(relative(root, full).replace(/\\/g, '/'));
      }
    }
  }
}
