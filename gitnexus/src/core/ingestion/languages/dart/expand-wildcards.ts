/**
 * Enumerate the names a Dart `import '...'` brings into scope — every PUBLIC
 * top-level symbol of the target library. Dart imports are whole-library
 * (wildcard) and library-private (leading-underscore) members are not
 * exported, so they are filtered out. Mirror of Ruby's
 * `expandRubyWildcardNames`.
 *
 * Without this hook the shared `propagateImportedReturnTypes` pass has no
 * importer-scope binding to hang an imported function's return type on, so a
 * cross-file `var u = getUser(); u.save()` never resolves `u`'s type.
 */

import type { ParsedFile, ScopeId } from 'gitnexus-shared';

export function expandDartWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = parsedFiles.find((p) => p.moduleScope === targetModuleScope);
  if (target === undefined) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const def of target.localDefs) {
    const qn = def.qualifiedName;
    if (qn === undefined || qn.length === 0) continue;
    const name = qn.split('.').pop() ?? qn;
    if (name === '' || name.startsWith('_')) continue; // library-private
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
