/**
 * Rust module paths — the module tree, expressed over the scope model.
 *
 * rustc resolves `a::b::dispatch` against a MODULE TREE, not a file tree: `mod`
 * is an item with its own `DefId`, and a path's leading segments name modules in
 * the *type* namespace (which is why a same-named `fn` can never shadow them —
 * functions live in the value namespace). GitNexus models the same tree in two
 * halves, and this module joins them:
 *
 *   - **Inline modules** (`mod inner { … }`) are `Namespace` scopes owning a
 *     `Namespace` def, so the shared `tagNamespacePrefixes` pass stamps members
 *     with `namespacePrefix = 'inner'` / `'outer.inner'`.
 *   - **File modules** (`mod tools;` loading `tools.rs` or `tools/mod.rs`) leave
 *     no in-file marker at all — the module path lives in the FILE PATH relative
 *     to the crate root. That half is reconstructed here.
 *
 * A def's full module path is therefore `moduleOfFile(filePath) ++
 * namespacePrefix`, and a call site's target module is its written path resolved
 * against the caller's own module path (`crate::` / `self::` / `super::` are
 * prefix transforms, exactly as in rustc — never bail-outs).
 *
 * Everything here is pure path arithmetic over the workspace file set; no I/O.
 */

/** Files that make their directory a crate root (`crate::` anchors here). */
const CRATE_ROOT_FILES = new Set(['main.rs', 'lib.rs']);

/** A module file whose name does NOT contribute a path segment. */
const MODULE_DIR_FILE = 'mod.rs';

export interface RustModuleIndex {
  /** Crate-root directories, longest first, so nested crates win. */
  readonly crateRoots: readonly string[];
}

/**
 * Index the workspace's crate roots: every directory holding a `main.rs` or
 * `lib.rs`. A cargo workspace has one per member (`crates/noob/src`), a plain
 * package exactly one (`src`). Longest-first ordering makes `moduleOfFile` pick
 * the innermost enclosing crate for nested layouts.
 */
export function buildRustModuleIndex(allFilePaths: ReadonlySet<string>): RustModuleIndex {
  const roots = new Set<string>();
  for (const filePath of allFilePaths) {
    const slash = filePath.lastIndexOf('/');
    const base = slash === -1 ? filePath : filePath.slice(slash + 1);
    if (!CRATE_ROOT_FILES.has(base)) continue;
    roots.add(slash === -1 ? '' : filePath.slice(0, slash));
  }
  return { crateRoots: [...roots].sort((a, b) => b.length - a.length) };
}

/**
 * Module path of the file itself, as `::`-segments below its crate root.
 *
 *   src/main.rs                     → []            (the crate root module)
 *   src/tools.rs                    → ['tools']
 *   src/a/mod.rs                    → ['a']
 *   src/a/b.rs                      → ['a', 'b']
 *   crates/noob/src/tools/mod.rs    → ['tools']
 *
 * Returns `undefined` for a file under no known crate root — the caller then has
 * no module identity to reason about and must refuse rather than guess.
 */
export function moduleOfFile(filePath: string, index: RustModuleIndex): string[] | undefined {
  for (const root of index.crateRoots) {
    const prefix = root === '' ? '' : `${root}/`;
    if (root !== '' && !filePath.startsWith(prefix)) continue;
    const rel = filePath.slice(prefix.length);
    if (rel.includes('/') === false && CRATE_ROOT_FILES.has(rel)) return [];
    const segments = rel.split('/');
    const last = segments.pop();
    if (last === undefined) return undefined;
    if (last !== MODULE_DIR_FILE) {
      if (!last.endsWith('.rs')) return undefined;
      segments.push(last.slice(0, -'.rs'.length));
    }
    return segments;
  }
  return undefined;
}

/** Full module path of a definition: its file's module path plus any `mod` blocks around it. */
export function moduleOfDef(
  filePath: string,
  namespacePrefix: string | undefined,
  index: RustModuleIndex,
): string[] | undefined {
  const fileModule = moduleOfFile(filePath, index);
  if (fileModule === undefined) return undefined;
  if (namespacePrefix === undefined || namespacePrefix === '') return fileModule;
  return [...fileModule, ...namespacePrefix.split('.')];
}

/**
 * Resolve a written path's leading segments to an absolute module path, from the
 * calling module. Mirrors rustc's anchor handling:
 *
 *   crate::a::b   → ['a','b']                 (crate root)
 *   self::a       → callerModule ++ ['a']
 *   super::a      → callerModule[:-1] ++ ['a']
 *   a::b          → relative; the caller resolves this against the candidate
 *                   channels (child module, `use` binding, extern crate), so it
 *                   is returned as-is for the caller to try in context.
 *
 * `super` chains (`super::super::x`) are consumed left to right. Returns
 * `undefined` when the chain walks above the crate root — an invalid path that
 * must not silently resolve to something else.
 */
export function resolveAnchoredModulePath(
  qualifier: readonly string[],
  callerModule: readonly string[],
): { readonly path: string[]; readonly anchored: boolean } | undefined {
  if (qualifier.length === 0) return undefined;

  const head = qualifier[0];
  if (head === 'crate' || head === '$crate') {
    return { path: qualifier.slice(1), anchored: true };
  }
  if (head === 'self') {
    return { path: [...callerModule, ...qualifier.slice(1)], anchored: true };
  }
  if (head === 'super') {
    let i = 0;
    const base = [...callerModule];
    while (i < qualifier.length && qualifier[i] === 'super') {
      if (base.length === 0) return undefined; // above the crate root
      base.pop();
      i++;
    }
    return { path: [...base, ...qualifier.slice(i)], anchored: true };
  }
  return { path: [...qualifier], anchored: false };
}

/** Structural equality for two module paths. */
export function sameModule(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}
