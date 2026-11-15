/**
 * Dart library namespaces: what a library exports, and what a plain `import`
 * of it makes visible.
 *
 *   - **Export closure.** `populateDartLibraryExports` computes, once per
 *     workspace pass, every library's public export namespace: its own public
 *     top-level declarations plus what its `export` directives republish,
 *     through `show` / `hide`, cycles and diamonds. A name two different
 *     declarations reach is exported by neither.
 *   - **Import visibility.** `populateDartImportNamespaces` publishes each
 *     imported library's namespace ONCE, as a table in the shared
 *     per-namespace binding channel, and lists the tables an importing file
 *     sees. A plain import therefore stays one `ParsedImport` and one import
 *     edge per directive; nothing is stored per importer and name.
 */

import { importNameFiltersAllow } from 'gitnexus-shared';
import type {
  BindingRef,
  ParsedFile,
  ParsedImport,
  ScopeId,
  SymbolDefinition,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { resolveDartImportTarget } from './import-target.js';
import { DART_PACKAGE_SCHEME, dartPackageImportName } from './package-uri.js';

type Exports = ReadonlyMap<string, SymbolDefinition>;
type NameFilters = ParsedImport['nameFilters'];
type BindingTable = ReadonlyMap<string, readonly BindingRef[]>;

/** One plain (unprefixed) import whose target is an indexed library. */
interface PlainImport {
  /** File path of the imported library. */
  readonly library: string;
  /** That library's public export closure. */
  readonly exports: Exports;
  /** The directive's `show` / `hide` combinators, in source order. */
  readonly filters: NameFilters;
}

/**
 * What the workspace pass learned about one library. The facts travel ON the
 * `ParsedFile`, under a module-private symbol, so they follow every
 * `{ ...file }` copy the pipeline makes: disk scope mode replaces each file by
 * a scope-stripped copy before the name fallback runs, and a side table keyed
 * by object identity loses its entries there. A symbol key is skipped by JSON
 * and by structured clone, so the facts never reach a cache or a worker.
 */
interface DartLibraryFacts {
  /** Public export closure: own declarations plus everything `export` republishes. */
  readonly exports: Exports;
  /** Plain imports with an indexed target, in directive order. */
  readonly imports: readonly PlainImport[];
  /** `lib/<path>` of each `package:` import that resolved to no indexed file.
   *  Kept for a library with an `export` directive, the only kind the
   *  export-only question can be true for. */
  readonly unresolvedPackageLibraries: readonly string[];
}

const LIBRARY_FACTS: unique symbol = Symbol('dartLibraryFacts');
type WithLibraryFacts = ParsedFile & { readonly [LIBRARY_FACTS]?: DartLibraryFacts };

function libraryFactsOf(file: ParsedFile): DartLibraryFacts | undefined {
  return (file as WithLibraryFacts)[LIBRARY_FACTS];
}

const NO_IMPORTS: readonly PlainImport[] = [];
const NO_LIBRARIES: readonly string[] = [];

/** Last `qualifiedName` segment: the name a top-level declaration is exported under. */
function simpleNameOf(def: SymbolDefinition): string {
  const qualified = def.qualifiedName ?? '';
  return qualified.slice(qualified.lastIndexOf('.') + 1);
}

/**
 * Is `candidate` a declaration `file` only republishes? An `export` directive
 * puts a name in the library's export namespace without binding it inside the
 * library, so a bare call there cannot mean the exported declaration unless an
 * import of the same library brings it in as well.
 *
 * An unresolved `package:` import that names the candidate's own file is such
 * an import the index could not follow (no pubspec maps the package), so the
 * candidate stays plausible.
 */
export function dartCandidateIsExportOnly(file: ParsedFile, candidate: SymbolDefinition): boolean {
  const facts = libraryFactsOf(file);
  if (facts === undefined || candidate.filePath === file.filePath) return false;
  const name = simpleNameOf(candidate);
  if (facts.exports.get(name)?.nodeId !== candidate.nodeId) return false;
  for (const imported of facts.imports) {
    if (
      imported.exports.get(name)?.nodeId === candidate.nodeId &&
      importNameFiltersAllow(imported.filters, name)
    )
      return false;
  }
  for (const library of facts.unresolvedPackageLibraries) {
    if (candidate.filePath === library || candidate.filePath.endsWith(`/${library}`)) return false;
  }
  return true;
}

/** Module bindings are exact; flattened localDefs also contains class members. */
function dartLocalExports(file: ParsedFile): Exports {
  const exports = new Map<string, SymbolDefinition>();
  const module = file.scopes.find((scope) => scope.id === file.moduleScope);
  for (const [name, bindings] of module?.bindings ?? []) {
    if (name.startsWith('_')) continue;
    let only: SymbolDefinition | undefined;
    let distinct = 0;
    for (const binding of bindings) {
      if (binding.origin !== 'local' || binding.def.nodeId === only?.nodeId) continue;
      only = binding.def;
      distinct++;
    }
    if (distinct === 1 && only !== undefined) exports.set(name, only);
  }
  return exports;
}

/**
 * The names a library publishes. After `populateDartLibraryExports` this is
 * the library's public export closure; for a file the pass has not seen it is
 * the library's own public declarations.
 */
export function dartModuleExports(file: ParsedFile): Exports {
  return libraryFactsOf(file)?.exports ?? dartLocalExports(file);
}

/** Counts the name deliveries of one closure computation (see `populateDartLibraryExports`). */
export interface DartExportClosureWork {
  /** One per (name whose state changed in a library, `export` directive reading that library). */
  deliveries: number;
}

/**
 * Compute every library's public export closure once and attach it to its file.
 *
 * Each `export` directive is one edge from the exported library to the
 * exporting one. A name travels along an edge only when its state in the
 * source changes, and a name has three states that only move forward: absent,
 * one declaration, ambiguous (two different declarations reached it, so the
 * library exports neither). Ambiguity travels like a declaration does: Dart
 * rejects a library that exports one name as two declarations, so a library
 * that re-exports it refuses the name as well, even when another of its
 * exports carries a single declaration of that name. Picking that one would
 * resolve calls through a namespace the compiler never builds. The work is
 * therefore bounded by twice the number
 * of (directive, name it can carry) pairs whatever the file order, on chains
 * and on cycles alike, and the result does not depend on that order.
 *
 * Imports never contribute exports, and an export never binds its names in its
 * own library: an `export` directive becomes a `side-effect` import, which
 * keeps the file dependency and binds nothing. A plain import stays ONE
 * wildcard import per directive; its names are published once per library by
 * `populateDartImportNamespaces`, never copied per importer.
 */
export function populateDartLibraryExports(
  files: ParsedFile[],
  ctx: { readonly resolutionConfig?: unknown },
  work?: DartExportClosureWork,
): void {
  const paths = new Set(files.map((file) => file.filePath));
  const targetOf = (file: ParsedFile, imp: ParsedImport): string | undefined => {
    const resolved = resolveDartImportTarget(
      imp.targetRaw,
      file.filePath,
      paths,
      ctx.resolutionConfig,
    );
    return typeof resolved === 'string' ? resolved : undefined;
  };

  const locals = new Map<string, Exports>();
  for (const file of files) locals.set(file.filePath, dartLocalExports(file));

  // Exported library → the `export` directives that read it.
  const dependents = new Map<string, Array<{ path: string; filters: NameFilters }>>();
  const exporters = new Set<string>();
  for (const file of files) {
    for (const imp of file.parsedImports) {
      if (imp.exportsOnly !== true) continue;
      exporters.add(file.filePath);
      const target = targetOf(file, imp);
      // A library exporting itself adds nothing to its own namespace.
      if (target === undefined || target === file.filePath || !locals.has(target)) continue;
      let list = dependents.get(target);
      if (list === undefined) dependents.set(target, (list = []));
      list.push({ path: file.filePath, filters: imp.nameFilters });
    }
  }

  // A library without an `export` directive publishes exactly its own
  // declarations, so its closure IS the local map. Only an exporter gets a
  // copy to grow, and a set for the names that became ambiguous there.
  const closures = new Map<string, Map<string, SymbolDefinition>>();
  const ambiguous = new Map<string, Set<string>>();
  for (const path of exporters) closures.set(path, new Map(locals.get(path)));

  // Names whose state changed in a library since it last told its dependents;
  // `null` marks a name that became ambiguous.
  const pending = new Map<string, Map<string, SymbolDefinition | null>>();
  const queue: string[] = [];
  for (const path of dependents.keys()) {
    const own = closures.get(path) ?? locals.get(path);
    if (own === undefined || own.size === 0) continue;
    // A snapshot: the library's own map may grow while its dependents are served.
    pending.set(path, new Map(own));
    queue.push(path);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const source = queue[cursor];
    const delta = pending.get(source);
    if (delta === undefined) continue;
    pending.delete(source);
    for (const dependent of dependents.get(source) ?? []) {
      const closure = closures.get(dependent.path);
      const own = locals.get(dependent.path);
      if (closure === undefined || own === undefined) continue;
      let refused = ambiguous.get(dependent.path);
      let changed: Map<string, SymbolDefinition | null> | undefined;
      for (const [name, def] of delta) {
        if (work !== undefined) work.deliveries++;
        // The library's own declaration wins over an exported one of the same name.
        if (own.has(name) || refused?.has(name) === true) continue;
        if (!importNameFiltersAllow(dependent.filters, name)) continue;
        const current = closure.get(name);
        let next: SymbolDefinition | null;
        if (def !== null && current === undefined) {
          closure.set(name, def);
          next = def;
        } else if (def !== null && current?.nodeId === def.nodeId) {
          continue;
        } else {
          // Two different declarations of one name, or one that is already
          // ambiguous in the exported library: this library exports neither.
          closure.delete(name);
          if (refused === undefined) ambiguous.set(dependent.path, (refused = new Set()));
          refused.add(name);
          next = null;
        }
        if (!dependents.has(dependent.path)) continue;
        if (changed === undefined) {
          changed = pending.get(dependent.path);
          if (changed === undefined) {
            pending.set(dependent.path, (changed = new Map()));
            queue.push(dependent.path);
          }
        }
        changed.set(name, next);
      }
    }
  }

  const exportsOf = (path: string): Exports | undefined => closures.get(path) ?? locals.get(path);
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const exports = exportsOf(file.filePath);
    if (exports === undefined) continue;
    const exporter = exporters.has(file.filePath);
    const imports: PlainImport[] = [];
    const unresolved: string[] = [];
    for (const imp of file.parsedImports) {
      if (imp.exportsOnly === true || imp.kind !== 'wildcard') continue;
      const library = targetOf(file, imp);
      const libraryExports = library === undefined ? undefined : exportsOf(library);
      if (library !== undefined && libraryExports !== undefined) {
        imports.push({ library, exports: libraryExports, filters: imp.nameFilters });
      } else if (exporter) {
        const packageLibrary = dartPackageLibraryPath(imp.targetRaw);
        if (packageLibrary !== undefined) unresolved.push(packageLibrary);
      }
    }
    const facts: DartLibraryFacts = {
      exports,
      imports: imports.length === 0 ? NO_IMPORTS : imports,
      unresolvedPackageLibraries: unresolved.length === 0 ? NO_LIBRARIES : unresolved,
    };
    const next: WithLibraryFacts = {
      ...file,
      ...(exporter
        ? {
            parsedImports: file.parsedImports.map(
              (imp): ParsedImport =>
                imp.exportsOnly === true ? { ...imp, kind: 'side-effect' } : imp,
            ),
          }
        : {}),
      [LIBRARY_FACTS]: facts,
    };
    files[i] = next;
  }
}

/** `package:<name>/<path>` names the file `lib/<path>` of that package. */
function dartPackageLibraryPath(targetRaw: string): string | undefined {
  if (!targetRaw.startsWith(DART_PACKAGE_SCHEME)) return undefined;
  const packageName = dartPackageImportName(targetRaw);
  if (packageName === null) return undefined;
  return `lib/${targetRaw.slice(DART_PACKAGE_SCHEME.length + packageName.length + 1)}`;
}

/** The binding channels `populateDartImportNamespaces` writes and the one it reads. */
type ImportNamespaceIndexes = Pick<
  ScopeResolutionIndexes,
  | 'bindings'
  | 'namespaceFqnBindings'
  | 'accessibleNamespacesByScope'
  | 'namespaceLookupTiersByScope'
>;

/** Channel key of one imported namespace: a library as seen through one
 *  combinator list. The JSON part is self-delimiting, so no library path can
 *  make two different keys equal. */
function importNamespaceKey(imported: PlainImport): string {
  return `dart-library:${JSON.stringify(imported.filters ?? [])}:${imported.library}`;
}

/** Channel key of one file's own override table (see `importOverrides`). */
function overrideNamespaceKey(filePath: string): string {
  return `dart-import-overrides:${filePath}`;
}

/**
 * Publish what plain imports make visible, through the shared per-namespace
 * binding channel (`ScopeResolver.populateImportNamespaces`).
 *
 * One table per (library, combinator list): the library's public export
 * closure, less what `show` / `hide` removes — the combinators are applied
 * HERE, where an import's names are produced. Every file importing that
 * library the same way lists the same table, so the stored size is the sum of
 * the distinct tables plus one short list per importer; it does not grow with
 * importers times exported names.
 *
 * Lookup order per importing file, first tier holding the name answers:
 *
 *   1. the file's override table (`importOverrides`), when it needs one;
 *   2. each imported namespace, in directive order.
 *
 * A name several imports bring in as the SAME declaration (a barrel and the
 * library it re-exports) therefore binds once, and a name they bring in as
 * DIFFERENT declarations binds to all of them, so a lookup that needs exactly
 * one declaration sees that there are several.
 *
 * What does grow with the workspace: one table per distinct combinator list
 * of a library (a `hide` table is nearly a full copy), and one override table
 * per file that needs one.
 */
export function populateDartImportNamespaces(
  parsedFiles: readonly ParsedFile[],
  indexes: ImportNamespaceIndexes,
): void {
  const tables = indexes.namespaceFqnBindings as Map<string, BindingTable>;
  const accessible = indexes.accessibleNamespacesByScope as Map<ScopeId, readonly string[]>;
  const tiers = indexes.namespaceLookupTiersByScope as
    | Map<ScopeId, readonly (readonly string[])[]>
    | undefined;
  // library → name → its one binding, shared by every table of that library.
  const libraryBindings = new Map<string, BindingTable>();
  // One single-namespace tier per namespace, shared by every importer.
  const tierOf = new Map<string, readonly string[]>();
  // Import list → the names its namespaces disagree on (see `importConflicts`).
  const conflictsByImportList = new Map<string, BindingTable>();

  const tableOf = (imported: PlainImport): BindingTable => {
    let unfiltered = libraryBindings.get(imported.library);
    if (unfiltered === undefined) {
      const all = new Map<string, readonly BindingRef[]>();
      for (const [name, def] of imported.exports) all.set(name, [{ def, origin: 'import' }]);
      libraryBindings.set(imported.library, (unfiltered = all));
    }
    const filters = imported.filters;
    if (filters === undefined || filters.length === 0) return unfiltered;
    const filtered = new Map<string, readonly BindingRef[]>();
    // A leading `show` already lists every name that can pass.
    const first = filters[0];
    const candidates = first.kind === 'show' ? first.names : unfiltered.keys();
    for (const name of candidates) {
      const refs = unfiltered.get(name);
      if (refs !== undefined && importNameFiltersAllow(filters, name)) filtered.set(name, refs);
    }
    return filtered;
  };

  for (const file of parsedFiles) {
    const facts = libraryFactsOf(file);
    if (facts === undefined || facts.imports.length === 0) continue;
    const namespaces: string[] = [];
    const imported: BindingTable[] = [];
    for (const plain of facts.imports) {
      const namespace = importNamespaceKey(plain);
      if (namespaces.includes(namespace)) continue;
      let table = tables.get(namespace);
      if (table === undefined) tables.set(namespace, (table = tableOf(plain)));
      namespaces.push(namespace);
      imported.push(table);
    }
    let conflicts: BindingTable | undefined;
    if (imported.length > 1) {
      // Files with the same import list share one answer.
      const list = namespaces.join('\n');
      conflicts = conflictsByImportList.get(list);
      if (conflicts === undefined) {
        conflictsByImportList.set(list, (conflicts = importConflicts(imported)));
      }
    }
    const overrides = importOverrides(imported, conflicts, indexes.bindings.get(file.moduleScope));
    const lookup: (readonly string[])[] = [];
    if (overrides !== undefined) {
      const key = overrideNamespaceKey(file.filePath);
      tables.set(key, overrides);
      lookup.push([key]);
    }
    for (const namespace of namespaces) {
      let tier = tierOf.get(namespace);
      if (tier === undefined) tierOf.set(namespace, (tier = [namespace]));
      lookup.push(tier);
    }
    // One namespace and no override: the flat list is the whole order.
    accessible.set(file.moduleScope, lookup.length === 1 ? lookup[0] : lookup.flat());
    if (lookup.length > 1) tiers?.set(file.moduleScope, lookup);
  }
}

const NO_CONFLICTS: BindingTable = new Map();

/**
 * The names two or more of these namespaces bring in as DIFFERENT
 * declarations, each with every declaration once, in directive order. A name
 * only the largest namespace holds cannot collide, so the others are scanned.
 */
function importConflicts(imported: readonly BindingTable[]): BindingTable {
  let conflicts: Map<string, readonly BindingRef[]> | undefined;
  let largest = 0;
  for (let i = 1; i < imported.length; i++) {
    if (imported[i].size > imported[largest].size) largest = i;
  }
  for (let i = 0; i < imported.length; i++) {
    if (i === largest) continue;
    for (const name of imported[i].keys()) {
      if (conflicts?.has(name) === true) continue;
      let distinct: BindingRef[] | undefined;
      for (const table of imported) {
        for (const ref of table.get(name) ?? []) {
          if (distinct === undefined) distinct = [ref];
          else if (!distinct.some((seen) => seen.def.nodeId === ref.def.nodeId)) distinct.push(ref);
        }
      }
      if (distinct !== undefined && distinct.length > 1) {
        (conflicts ??= new Map()).set(name, distinct);
      }
    }
  }
  return conflicts ?? NO_CONFLICTS;
}

/**
 * The names of one importing file that its imported namespaces must not
 * answer one by one, with what answers instead:
 *
 *   - a name the file itself binds at module scope: its own declaration hides
 *     every imported one, so the entry is the file's own bindings;
 *   - a name its imports disagree on (`conflicts`): every declaration.
 *
 * `undefined` when there is no such name, the usual case.
 */
function importOverrides(
  imported: readonly BindingTable[],
  conflicts: BindingTable | undefined,
  own: BindingTable | undefined,
): BindingTable | undefined {
  let shadows: Map<string, readonly BindingRef[]> | undefined;
  for (const [name, refs] of own ?? []) {
    if (!refs.some((ref) => ref.origin === 'local')) continue;
    if (imported.some((table) => table.has(name))) (shadows ??= new Map()).set(name, refs);
  }
  if (conflicts === undefined || conflicts.size === 0) return shadows;
  if (shadows === undefined) return conflicts;
  for (const [name, refs] of conflicts) {
    if (!shadows.has(name)) shadows.set(name, refs);
  }
  return shadows;
}
