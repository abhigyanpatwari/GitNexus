import type { ParsedFile } from 'gitnexus-shared';

import type { ObjectiveCImportTargetOptions } from './import-target.js';
import { resolveObjectiveCImportTarget } from './import-target.js';

const parsedFileIndexes = new WeakMap<readonly ParsedFile[], ReadonlyMap<string, ParsedFile>>();
const closureCaches = new WeakMap<readonly ParsedFile[], Map<string, string | readonly string[]>>();

function parsedFileIndex(parsedFiles: readonly ParsedFile[]): ReadonlyMap<string, ParsedFile> {
  let index = parsedFileIndexes.get(parsedFiles);
  if (index === undefined) {
    index = new Map(parsedFiles.map((parsed) => [parsed.filePath, parsed]));
    parsedFileIndexes.set(parsedFiles, index);
  }
  return index;
}

/**
 * Resolve an Objective-C import to its workspace-local header closure.
 *
 * C-family imports are textual: declarations imported by a local umbrella
 * header are visible to its importer. Returning the closure through the
 * existing multi-target resolver contract lets finalize materialize those
 * bindings without changing another language's wildcard semantics.
 */
export function resolveObjectiveCImportClosure(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  parsedFiles: readonly ParsedFile[],
  options: ObjectiveCImportTargetOptions = {},
): string | readonly string[] | null {
  const directTarget = resolveObjectiveCImportTarget(targetRaw, fromFile, allFilePaths, options);
  if (directTarget === null) return null;
  if (!/\.h$/i.test(directTarget)) return directTarget;

  let cache = closureCaches.get(parsedFiles);
  if (cache === undefined) {
    cache = new Map();
    closureCaches.set(parsedFiles, cache);
  }
  const cached = cache.get(directTarget);
  if (cached !== undefined) return cached;

  const byPath = parsedFileIndex(parsedFiles);
  const visited = new Set<string>([directTarget]);
  const targets: string[] = [directTarget];

  for (let index = 0; index < targets.length; index++) {
    const current = targets[index];
    if (current === undefined) continue;
    const parsed = byPath.get(current);
    if (parsed === undefined) continue;

    for (const imported of parsed.parsedImports) {
      const nestedTarget = resolveObjectiveCImportTarget(
        imported.targetRaw,
        current,
        allFilePaths,
        { isSystem: imported.kind === 'wildcard' && imported.isSystem === true },
      );
      if (nestedTarget === null || !/\.h$/i.test(nestedTarget) || visited.has(nestedTarget)) {
        continue;
      }
      visited.add(nestedTarget);
      targets.push(nestedTarget);
    }
  }

  const resolved = targets.length === 1 ? directTarget : Object.freeze(targets);
  cache.set(directTarget, resolved);
  return resolved;
}
