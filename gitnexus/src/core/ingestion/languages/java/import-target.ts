/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` → concrete file path.
 *
 * Converts Java package paths (dots → slashes) and tries:
 *   1. Exact file match: `com/example/User.java`
 *   2. Suffix match for nested layouts
 *   3. Directory match (wildcard imports)
 *   4. Progressive prefix stripping for non-standard layouts
 *
 * Returns `null` for unresolvable / JDK imports.
 */

import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';

export interface JavaResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}

export function resolveJavaImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  const ctx = workspaceIndex as JavaResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  // Strip trailing `.*` for wildcard imports: `com.example.*` → `com.example`
  let target = parsedImport.targetRaw;
  if (target.endsWith('.*')) {
    target = target.slice(0, -2);
  }

  // Package path: `com.example.User` → `com/example/User`
  const pathLike = target.replace(/\./g, '/');
  const suffix = `/${pathLike}`;

  let exactFile: string | null = null;
  let suffixFile: string | null = null;
  let directoryChild: string | null = null;
  const dirPrefix = `${pathLike}/`;
  const suffixDirPrefix = `/${dirPrefix}`;

  for (const raw of ctx.allFilePaths) {
    const f = raw.replace(/\\/g, '/');
    if (!f.endsWith('.java')) continue;
    if (f === `${pathLike}.java`) {
      exactFile = raw;
      break;
    }
    if (suffixFile === null && f.endsWith(`${suffix}.java`)) {
      suffixFile = raw;
    }
    if (directoryChild === null) {
      const atRoot = f.startsWith(dirPrefix);
      const atNested = f.includes(suffixDirPrefix);
      if (atRoot || atNested) {
        const idx = atRoot ? 0 : f.indexOf(suffixDirPrefix) + 1;
        const after = f.slice(idx + dirPrefix.length);
        if (after.length > 0 && !after.includes('/')) {
          directoryChild = raw;
        }
      }
    }
  }

  if (exactFile !== null) return exactFile;
  if (suffixFile !== null) return suffixFile;
  if (directoryChild !== null) return directoryChild;

  // Progressive prefix stripping — handles `import com.example.User;`
  // in a repo laid out `User.java` (no `com/example/` prefix).
  const segments = pathLike.split('/').filter(Boolean);
  for (let skip = 1; skip < segments.length; skip++) {
    const tail = segments.slice(skip).join('/');
    if (tail === '') continue;
    const tailFile = `${tail}.java`;
    const tailSuffix = `/${tailFile}`;
    const tailDir = `${tail}/`;
    const tailSuffixDir = `/${tailDir}`;
    let tailDirectChild: string | null = null;
    for (const raw of ctx.allFilePaths) {
      const f = raw.replace(/\\/g, '/');
      if (!f.endsWith('.java')) continue;
      if (f === tailFile) return raw;
      if (f.endsWith(tailSuffix)) return raw;
      if (tailDirectChild === null) {
        const atRoot = f.startsWith(tailDir);
        const atNested = f.includes(tailSuffixDir);
        if (atRoot || atNested) {
          const idx = atRoot ? 0 : f.indexOf(tailSuffixDir) + 1;
          const after = f.slice(idx + tailDir.length);
          if (after.length > 0 && !after.includes('/')) tailDirectChild = raw;
        }
      }
    }
    if (tailDirectChild !== null) return tailDirectChild;
  }

  return null;
}
