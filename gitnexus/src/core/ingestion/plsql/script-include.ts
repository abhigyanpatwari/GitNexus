/**
 * SQL*Plus script inclusion (`@@file`, `@file`, `START file`) → repository path.
 *
 * SQL*Plus resolves `@@` against the directory of the calling script and
 * `@` / `START` against the working directory, appending `.sql` when the name
 * has no extension. The working directory is unknown statically, so `@` /
 * `START` try the repository root first and then the calling script's
 * directory (the two directories install scripts are run from); `@@` uses only
 * the calling script's directory. Exact paths only — there is no suffix
 * search: a script that is not at one of those paths lives outside the
 * repository (a vendor install, `?/rdbms/admin/...`, a UNC share) and must not
 * bind to a same-named file.
 *
 * `targetRaw` may carry a leading `@@` (how scope captures encode a
 * script-relative include); `relativeToScript` overrides it when given.
 */

import path from 'node:path';

function normalise(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
}

export function resolvePlSqlScriptInclude(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  relativeToScript?: boolean,
): string | null {
  let target = targetRaw.trim();
  const scriptRelative = relativeToScript ?? target.startsWith('@@');
  target = target.replace(/^@@?/, '').replace(/^["']|["']$/g, '');
  // `?` is ORACLE_HOME; absolute, drive-letter and UNC paths are machine-specific.
  if (
    target === '' ||
    target.startsWith('?') ||
    /^[\\/]/.test(target) ||
    /^[A-Za-z]:/.test(target)
  ) {
    return null;
  }
  const spellings = path.posix.extname(target) === '' ? [`${target}.sql`, target] : [target];
  const dir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  const bases = scriptRelative ? [dir] : ['', dir];
  for (const base of bases) {
    for (const spelling of spellings) {
      const candidate = normalise(base && base !== '.' ? `${base}/${spelling}` : spelling);
      if (candidate.startsWith('../')) continue;
      if (allFilePaths.has(candidate)) return candidate;
    }
  }
  return null;
}
