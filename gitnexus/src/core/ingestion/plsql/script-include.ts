/**
 * SQL*Plus script inclusion (`@@file`, `@file`, `START file`) → repository path.
 *
 * SQL*Plus looks a script up relative to the calling script (`@@`) or the
 * working directory (`@`, `START`), appending `.sql` when the name has no
 * extension. Statically we try the calling script's directory, then the
 * repository root — exact paths only. There is no suffix search: a script
 * that is not at one of those paths lives outside the repository (a vendor
 * install, `?/rdbms/admin/...`) and must not bind to a same-named file.
 */

import path from 'node:path';

function normalise(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
}

export function resolvePlSqlScriptInclude(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const target = targetRaw.trim().replace(/^["']|["']$/g, '');
  // `?` is ORACLE_HOME; absolute paths are machine-specific.
  if (
    target === '' ||
    target.startsWith('?') ||
    path.posix.isAbsolute(target) ||
    /^[A-Za-z]:[\\/]/.test(target)
  ) {
    return null;
  }
  const spellings = path.posix.extname(target) === '' ? [`${target}.sql`, target] : [target];
  const dir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  for (const base of [dir, '']) {
    for (const spelling of spellings) {
      const candidate = normalise(base ? `${base}/${spelling}` : spelling);
      if (candidate.startsWith('../')) continue;
      if (allFilePaths.has(candidate)) return candidate;
    }
  }
  return null;
}
