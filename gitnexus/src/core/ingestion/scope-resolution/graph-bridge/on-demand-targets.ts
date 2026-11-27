/**
 * Target selection for `ScopeResolver.onDemandImportTargets`.
 *
 * An on-demand import (a wildcard, or a module or package import) resolves to
 * every file of the module, because any of them may supply a name. The
 * provider decides, per target file, whether the importer takes anything from
 * it; this visits each distinct target of the importer's on-demand imports
 * once and keeps those the provider selects. Finalized imports stay complete
 * for name resolution; only persisted File→File edges are narrowed.
 *
 * Only imports bound at the importer's module scope are considered, so a
 * provider whose imports bind in lexical scopes must select those targets
 * itself. Nothing here reads scopes or source text: the emit phase may have
 * released both.
 */

import type { ImportEdge, ParsedFile } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

/** The targets of `parsed`'s imports whose edge kind is in `kinds` and that
 * `keep` selects. `keep` sees each distinct target file once.
 *
 * `follow`, when given, adds one hop. For a target `keep` selected, it may
 * return a predicate; every candidate of the same import statement that the
 * predicate accepts is kept too (a provider whose declarations can stand for
 * a declaration in another file of the same module, such as an alias).
 * Targets added this way are not followed again. The statements are only
 * walked a second time when some kept target returns a predicate. */
export function onDemandTargets(
  parsed: ParsedFile,
  indexes: ScopeResolutionIndexes,
  kinds: ReadonlySet<ImportEdge['kind']>,
  keep: (targetFile: string) => boolean,
  follow?: (keptFile: string) => ((candidate: string) => boolean) | undefined,
): Set<string> {
  const kept = new Set<string>();
  const decided = new Set<string>();
  indexes.imports.forEachTarget(parsed.moduleScope, (targetFile, via) => {
    if (!kinds.has(via.kind) || decided.has(targetFile)) return;
    decided.add(targetFile);
    if (keep(targetFile)) kept.add(targetFile);
  });
  if (follow === undefined) return kept;
  const followed = new Map<string, (candidate: string) => boolean>();
  for (const keptFile of kept) {
    const accepts = follow(keptFile);
    if (accepts !== undefined) followed.set(keptFile, accepts);
  }
  if (followed.size === 0) return kept;
  // A statement is its local name at its position: groups and per-file edges
  // of one split statement share both.
  const byStatement = new Map<string, string[]>();
  indexes.imports.forEachTarget(parsed.moduleScope, (targetFile, via) => {
    if (!kinds.has(via.kind)) return;
    const statement = `${via.localName}\u0000${via.atRange?.startLine ?? ''}:${via.atRange?.startCol ?? ''}`;
    let files = byStatement.get(statement);
    if (files === undefined) byStatement.set(statement, (files = []));
    files.push(targetFile);
  });
  const extra: string[] = [];
  for (const files of byStatement.values())
    for (const [keptFile, accepts] of followed)
      if (files.includes(keptFile))
        for (const candidate of files)
          if (!kept.has(candidate) && accepts(candidate)) extra.push(candidate);
  for (const file of extra) kept.add(file);
  return kept;
}
