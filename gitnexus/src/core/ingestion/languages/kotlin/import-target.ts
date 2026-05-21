import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';

export interface KotlinResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}

export function resolveKotlinImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  const ctx = workspaceIndex as KotlinResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  const target = parsedImport.targetRaw.endsWith('.*')
    ? parsedImport.targetRaw.slice(0, -2)
    : parsedImport.targetRaw;
  const pathLike = target.replace(/\./g, '/');

  return (
    findKotlinFile(ctx.allFilePaths, pathLike) ??
    findKotlinFile(ctx.allFilePaths, pathLike.split('/').slice(0, -1).join('/')) ??
    findByProgressivePrefixStrip(ctx.allFilePaths, pathLike)
  );
}

function findKotlinFile(allFilePaths: ReadonlySet<string>, pathLike: string): string | null {
  if (pathLike === '') return null;
  const extensions = ['.kt', '.kts'];
  const suffix = `/${pathLike}`;
  const dirPrefix = `${pathLike}/`;
  const suffixDirPrefix = `/${dirPrefix}`;

  let suffixFile: string | null = null;
  let directoryChild: string | null = null;

  for (const raw of allFilePaths) {
    const file = raw.replace(/\\/g, '/');
    if (!extensions.some((ext) => file.endsWith(ext))) continue;
    for (const ext of extensions) {
      if (file === `${pathLike}${ext}`) return raw;
      if (suffixFile === null && file.endsWith(`${suffix}${ext}`)) suffixFile = raw;
    }
    if (directoryChild === null) {
      const atRoot = file.startsWith(dirPrefix);
      const atNested = file.includes(suffixDirPrefix);
      if (atRoot || atNested) {
        const idx = atRoot ? 0 : file.indexOf(suffixDirPrefix) + 1;
        const after = file.slice(idx + dirPrefix.length);
        if (after.length > 0 && !after.includes('/')) directoryChild = raw;
      }
    }
  }

  return suffixFile ?? directoryChild;
}

function findByProgressivePrefixStrip(
  allFilePaths: ReadonlySet<string>,
  pathLike: string,
): string | null {
  const segments = pathLike.split('/').filter(Boolean);
  for (let skip = 1; skip < segments.length; skip++) {
    const found = findKotlinFile(allFilePaths, segments.slice(skip).join('/'));
    if (found !== null) return found;
  }
  return null;
}
