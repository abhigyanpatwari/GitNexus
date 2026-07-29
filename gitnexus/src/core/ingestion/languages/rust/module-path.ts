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
 * ## Module identity carries its crate
 *
 * A module is `{ crateRoot, segments }`, never bare segments. A cargo workspace
 * routinely gives several members the same internal module name — `util`,
 * `error`, `config`, `types` are near-universal — and identity by segments alone
 * makes `crates/a/src/tools.rs` and `crates/b/src/tools.rs` the same module. That
 * mis-binds a call across crates when only one defines the member, and (worse)
 * ties the lookup when both do, so qualified resolution refuses and the call
 * falls back to the lexical walk that #2730 exists to prevent. Rust has no
 * implicit cross-crate paths: reaching another crate requires naming it, so two
 * modules in different crates are never the same module.
 *
 * Everything here is pure path arithmetic over the workspace file set; no I/O.
 */

/** Files that make their directory a crate root (`crate::` anchors here). */
const CRATE_ROOT_FILES = new Set(['main.rs', 'lib.rs']);

/** A module file whose name does NOT contribute a path segment. */
const MODULE_DIR_FILE = 'mod.rs';

/**
 * A module's full identity: the crate it belongs to, plus its `::`-path inside
 * that crate. `segments` is empty for the crate-root module itself.
 */
export interface RustModule {
  /** Crate-root directory (`src`, `crates/noob/src`, or `''` at repo root). */
  readonly crateRoot: string;
  readonly segments: readonly string[];
}

export interface RustModuleIndex {
  /** Crate-root directories, longest first, so nested crates win. */
  readonly crateRoots: readonly string[];
  /**
   * Every module name derivable from a FILE PATH, as a flat set of single
   * segments. Inline `mod x { … }` names are absent by construction — they exist
   * in no path — so this is only half of the negative filter's input; the
   * resolver unions it with the inline module names it collects from the scope
   * model (#2742).
   */
  readonly moduleNames: ReadonlySet<string>;
  /**
   * Entry files that are a crate root in their own right rather than a module of
   * the surrounding crate — `src/bin/<name>.rs` auto-discovered binary targets.
   * Maps the entry file to the directory its own submodules live under.
   */
  readonly standaloneRootFiles: ReadonlyMap<string, string>;
}

/**
 * Index the workspace's crate roots: every directory holding a `main.rs` or
 * `lib.rs`. A cargo workspace has one per member (`crates/noob/src`), a plain
 * package exactly one (`src`). Longest-first ordering makes `moduleOfFile` pick
 * the innermost enclosing crate for nested layouts.
 *
 * Cargo also auto-discovers a binary target per `src/bin/<name>.rs`. Each is a
 * separate crate with its own `crate::` root, and its submodules live under
 * `src/bin/<name>/`. Treating those files as ordinary modules of the library
 * invented the module path `bin::<name>`, which made `crate::helper()` inside a
 * binary resolve into the LIBRARY — downgrading an edge the lexical walk had
 * previously got right (#2741 review).
 */
export function buildRustModuleIndex(allFilePaths: ReadonlySet<string>): RustModuleIndex {
  const roots = new Set<string>();
  for (const filePath of allFilePaths) {
    const slash = filePath.lastIndexOf('/');
    const base = slash === -1 ? filePath : filePath.slice(slash + 1);
    if (!CRATE_ROOT_FILES.has(base)) continue;
    roots.add(slash === -1 ? '' : filePath.slice(0, slash));
  }

  // Auto-discovered binary targets: `<crateRoot>/bin/<name>.rs`, and the
  // directory form `<crateRoot>/bin/<name>/main.rs` (already a root above).
  const standaloneRootFiles = new Map<string, string>();
  for (const filePath of allFilePaths) {
    if (!filePath.endsWith('.rs')) continue;
    const slash = filePath.lastIndexOf('/');
    if (slash === -1) continue;
    const dir = filePath.slice(0, slash);
    if (!dir.endsWith('/bin')) continue;
    const parent = dir.slice(0, -'/bin'.length);
    if (!roots.has(parent)) continue;
    const own = filePath.slice(0, -'.rs'.length);
    standaloneRootFiles.set(filePath, own);
    roots.add(own);
  }

  const crateRoots = [...roots].sort((a, b) => b.length - a.length);

  // Flat set of every module segment name in the workspace, for the negative
  // filter. Built from the same single pass over file paths.
  const moduleNames = new Set<string>();
  const index: RustModuleIndex = { crateRoots, standaloneRootFiles, moduleNames: new Set() };
  for (const filePath of allFilePaths) {
    const module = moduleOfFile(filePath, index);
    if (module === undefined) continue;
    for (const segment of module.segments) moduleNames.add(segment);
  }

  return { crateRoots, standaloneRootFiles, moduleNames };
}

/**
 * Could this qualifier name a module that exists in the workspace?
 *
 * A negative answer is authoritative and cheap: if the head segment matches no
 * module name anywhere, no candidate channel can resolve it. Anchors keep their
 * meaning (`crate::`/`self::`/`super::` are relative to the caller, so the head
 * to test is the first non-anchor segment); an all-anchor qualifier (`self::f()`)
 * names the caller's own module and is always worth trying.
 */
export function couldNameAModule(
  qualifier: readonly string[],
  knownModuleNames: ReadonlySet<string>,
): boolean {
  for (const segment of qualifier) {
    if (segment === 'crate' || segment === '$crate' || segment === 'self' || segment === 'super') {
      continue;
    }
    return knownModuleNames.has(segment);
  }
  return true;
}

/**
 * Module identity of the file itself: its crate root plus the `::`-segments
 * below it.
 *
 *   src/main.rs                     → { src,             [] }   (crate root module)
 *   src/tools.rs                    → { src,             ['tools'] }
 *   src/a/mod.rs                    → { src,             ['a'] }
 *   src/a/b.rs                      → { src,             ['a', 'b'] }
 *   crates/noob/src/tools/mod.rs    → { crates/noob/src, ['tools'] }
 *
 * Returns `undefined` for a file under no known crate root — the caller then has
 * no module identity to reason about and must refuse rather than guess.
 */
export function moduleOfFile(filePath: string, index: RustModuleIndex): RustModule | undefined {
  // A `src/bin/<name>.rs` entry file is its own crate root, not a module of the
  // surrounding library.
  const standalone = index.standaloneRootFiles.get(filePath);
  if (standalone !== undefined) return { crateRoot: standalone, segments: [] };

  for (const crateRoot of index.crateRoots) {
    const prefix = crateRoot === '' ? '' : `${crateRoot}/`;
    if (crateRoot !== '' && !filePath.startsWith(prefix)) continue;
    const rel = filePath.slice(prefix.length);
    if (!rel.includes('/') && CRATE_ROOT_FILES.has(rel)) return { crateRoot, segments: [] };
    const segments = rel.split('/');
    const last = segments.pop();
    if (last === undefined) return undefined;
    if (last !== MODULE_DIR_FILE) {
      if (!last.endsWith('.rs')) return undefined;
      segments.push(last.slice(0, -'.rs'.length));
    }
    return { crateRoot, segments };
  }
  return undefined;
}

/** Full module identity of a definition: its file's module plus any `mod` blocks around it. */
export function moduleOfDef(
  filePath: string,
  namespacePrefix: string | undefined,
  index: RustModuleIndex,
): RustModule | undefined {
  const fileModule = moduleOfFile(filePath, index);
  if (fileModule === undefined) return undefined;
  if (namespacePrefix === undefined || namespacePrefix === '') return fileModule;
  return {
    crateRoot: fileModule.crateRoot,
    segments: [...fileModule.segments, ...namespacePrefix.split('.')],
  };
}

/**
 * Resolve a written path's leading segments to a module, from the calling
 * module. Mirrors rustc's anchor handling:
 *
 *   crate::a::b   → the caller's OWN crate, segments ['a','b']
 *   self::a       → callerModule ++ ['a']
 *   super::a      → callerModule[:-1] ++ ['a']
 *   a::b          → relative; the caller resolves this against the candidate
 *                   channels (child module, `use` binding), so it is returned
 *                   as-is for the caller to try in context.
 *
 * An anchored path always stays inside the caller's crate — `crate::` names the
 * current crate, and `super::`/`self::` are relative to it — so the resolved
 * module inherits `callerModule.crateRoot`.
 *
 * `super` chains (`super::super::x`) are consumed left to right. Returns
 * `undefined` when the chain walks above the crate root — an invalid path that
 * must not silently resolve to something else.
 */
export function resolveAnchoredModulePath(
  qualifier: readonly string[],
  callerModule: RustModule,
): { readonly module: RustModule; readonly anchored: boolean } | undefined {
  if (qualifier.length === 0) return undefined;
  const crateRoot = callerModule.crateRoot;

  const head = qualifier[0];
  if (head === 'crate' || head === '$crate') {
    return { module: { crateRoot, segments: qualifier.slice(1) }, anchored: true };
  }
  if (head === 'self') {
    return {
      module: { crateRoot, segments: [...callerModule.segments, ...qualifier.slice(1)] },
      anchored: true,
    };
  }
  if (head === 'super') {
    let i = 0;
    const base = [...callerModule.segments];
    while (i < qualifier.length && qualifier[i] === 'super') {
      if (base.length === 0) return undefined; // above the crate root
      base.pop();
      i++;
    }
    return { module: { crateRoot, segments: [...base, ...qualifier.slice(i)] }, anchored: true };
  }
  return { module: { crateRoot, segments: [...qualifier] }, anchored: false };
}

/**
 * Identity comparison for two modules. The crate root participates: two modules
 * with the same internal path in DIFFERENT crates are different modules, and
 * conflating them is what let a workspace mis-bind or refuse (#2730 review H1).
 */
export function sameModule(a: RustModule, b: RustModule): boolean {
  return (
    a.crateRoot === b.crateRoot &&
    a.segments.length === b.segments.length &&
    a.segments.every((seg, i) => seg === b.segments[i])
  );
}
