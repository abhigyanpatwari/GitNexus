import type { ParsedFile, ParsedImport, SymbolDefinition } from 'gitnexus-shared';
import { resolveDartImportTarget } from './import-target.js';

type Exports = ReadonlyMap<string, SymbolDefinition>;
const exportsByFile = new WeakMap<ParsedFile, Exports>();
const exportOnlyCandidates = new WeakMap<ParsedFile, ReadonlySet<string>>();

export function dartCandidateIsExportOnly(file: ParsedFile, candidate: SymbolDefinition): boolean {
  return exportOnlyCandidates.get(file)?.has(candidate.nodeId) === true;
}

export function dartNamePassesFilters(name: string, filters: ParsedImport['nameFilters']): boolean {
  return (
    filters?.every((filter) =>
      filter.kind === 'show' ? filter.names.includes(name) : !filter.names.includes(name),
    ) ?? true
  );
}

/** Module bindings are exact; flattened localDefs also contains class members. */
export function dartModuleExports(file: ParsedFile): Exports {
  const cached = exportsByFile.get(file);
  if (cached !== undefined) return cached;
  const exports = new Map<string, SymbolDefinition>();
  const module = file.scopes.find((scope) => scope.id === file.moduleScope);
  for (const [name, bindings] of module?.bindings ?? []) {
    if (name.startsWith('_')) continue;
    const defs = new Map(
      bindings
        .filter((binding) => binding.origin === 'local')
        .map((binding) => [binding.def.nodeId, binding.def]),
    );
    if (defs.size === 1) exports.set(name, defs.values().next().value!);
  }
  return exports;
}

/** Compute public export closures once, retaining all candidates until ambiguity is decided.
 * A work queue propagates new declarations through cycles; traversal order cannot pick a winner.
 * Imports never contribute exports, and an export never binds its names in its own library.
 */
export function populateDartLibraryExports(
  files: ParsedFile[],
  ctx: { readonly resolutionConfig?: unknown },
): void {
  const paths = new Set(files.map((file) => file.filePath));
  const byPath = new Map(files.map((file) => [file.filePath, file]));
  const locals = new Map(files.map((file) => [file.filePath, dartModuleExports(file)]));
  const candidates = new Map(
    files.map((file) => [
      file.filePath,
      new Map(
        [...locals.get(file.filePath)!].map(([name, def]) => [name, new Map([[def.nodeId, def]])]),
      ),
    ]),
  );
  const dependents = new Map<
    string,
    Array<{ path: string; filters: ParsedImport['nameFilters'] }>
  >();
  const targetOf = (file: ParsedFile, imp: ParsedImport): string | undefined => {
    const resolved = resolveDartImportTarget(
      imp.targetRaw,
      file.filePath,
      paths,
      ctx.resolutionConfig,
    );
    return typeof resolved === 'string' ? resolved : undefined;
  };
  for (const file of files) {
    for (const imp of file.parsedImports) {
      if (imp.exportsOnly !== true) continue;
      const target = targetOf(file, imp);
      if (target === undefined || !byPath.has(target)) continue;
      const list = dependents.get(target) ?? [];
      list.push({ path: file.filePath, filters: imp.nameFilters });
      dependents.set(target, list);
    }
  }
  const queue = [...paths];
  const queued = new Set(queue);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const source = queue[cursor]!;
    queued.delete(source);
    for (const dependent of dependents.get(source) ?? []) {
      const destination = candidates.get(dependent.path)!;
      let changed = false;
      for (const [name, defs] of candidates.get(source)!) {
        if (
          locals.get(dependent.path)!.has(name) ||
          !dartNamePassesFilters(name, dependent.filters)
        )
          continue;
        let bucket = destination.get(name);
        if (bucket === undefined) destination.set(name, (bucket = new Map()));
        for (const [id, def] of defs)
          if (!bucket.has(id)) {
            bucket.set(id, def);
            changed = true;
          }
      }
      if (changed && !queued.has(dependent.path)) {
        queue.push(dependent.path);
        queued.add(dependent.path);
      }
    }
  }
  const publicExports = new Map(
    [...candidates].map(([path, names]) => [
      path,
      new Map(
        [...names].flatMap(([name, defs]) =>
          defs.size === 1 ? [[name, defs.values().next().value!] as const] : [],
        ),
      ),
    ]),
  );
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const parsedImports = file.parsedImports.flatMap((imp): ParsedImport[] => {
      if (imp.exportsOnly === true) return [{ ...imp, kind: 'side-effect' }];
      if (imp.kind !== 'wildcard') return [imp];
      const target = targetOf(file, imp);
      const exports = target === undefined ? undefined : publicExports.get(target);
      if (exports === undefined) return [imp];
      return [...exports.keys()]
        .filter((name) => dartNamePassesFilters(name, imp.nameFilters))
        .map((name) => ({
          ...imp,
          kind: 'named',
          localName: name,
          importedName: name,
          reexportsName: false,
        }));
    });
    const next = { ...file, parsedImports };
    const imported = new Set(
      parsedImports.flatMap((imp) => {
        if (imp.kind !== 'named') return [];
        const target = targetOf(file, imp);
        const def =
          target === undefined ? undefined : publicExports.get(target)?.get(imp.importedName);
        return def === undefined ? [] : [def.nodeId];
      }),
    );
    exportOnlyCandidates.set(
      next,
      new Set(
        [...publicExports.get(file.filePath)!.values()]
          .filter((def) => def.filePath !== file.filePath && !imported.has(def.nodeId))
          .map((def) => def.nodeId),
      ),
    );
    exportsByFile.set(next, publicExports.get(file.filePath)!);
    files[i] = next;
  }
}
