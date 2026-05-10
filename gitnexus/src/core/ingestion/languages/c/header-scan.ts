import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/** C header extensions to scan for in the workspace. */
const HEADER_EXTENSIONS = new Set(['.h']);

/**
 * Walk `repoPath` recursively and return relative paths of all `.h` files.
 * Used by `loadResolutionConfig` so the C resolver can resolve `#include`
 * targets that live in `.h` files (classified as C++ by language detection
 * but importable from `.c` files).
 */
export function scanHeaderFiles(repoPath: string): ReadonlySet<string> {
  const headers = new Set<string>();
  walk(repoPath, repoPath, headers);
  return headers;
}

function walk(dir: string, root: string, out: Set<string>): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // permission denied, etc.
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip common non-source directories
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'vendor') {
        continue;
      }
      walk(full, root, out);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'));
      if (HEADER_EXTENSIONS.has(ext)) {
        out.add(relative(root, full));
      }
    }
  }
}
