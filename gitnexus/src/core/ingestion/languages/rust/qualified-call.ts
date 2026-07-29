/**
 * Rust module-qualified call resolution (#2730) — path resolution over the
 * module tree, the way rustc does it.
 *
 * `tools::dispatch(ctx, name)` is captured as a FREE call whose `name` is the
 * tail identifier and whose written path rides along in `site.rawQualifiedName`
 * (the same channel #1982 built for qualified inheritance bases). Without
 * consulting that path, the shared scope-chain walk resolves the bare tail and
 * binds it to whatever `dispatch` is lexically nearest — which, for the wrapper
 * idiom `fn dispatch(..) { tools::dispatch(..) }`, is the wrapper itself. The
 * real cross-module edge then does not exist and `impact` reports the callee as
 * unreached.
 *
 * The fix follows rustc's actual rule rather than a filename heuristic:
 *
 *   1. A path's leading segments name MODULES, resolved in the type namespace.
 *      A same-named `fn` lives in the value namespace and therefore can never
 *      shadow them — which is exactly the shadowing this bug was about.
 *   2. `crate::` / `self::` / `super::` are prefix transforms on the caller's
 *      own module path, not reasons to give up.
 *   3. The final segment is a MEMBER of the resolved module — looked up in that
 *      module's binding table, so `pub use` re-exports resolve like any other
 *      binding.
 *
 * Module identity comes from `module-path.ts`: file path below the crate root,
 * plus any enclosing `mod` blocks (carried on `namespacePrefix`, stamped by the
 * shared `tagNamespacePrefixes` pass now that `mod_item` emits a Namespace def).
 *
 * Refuses — returns `undefined`, leaving the shared chain untouched — whenever
 * the path names no known module, the module has no such member, or two
 * candidates tie. A wrong CALLS edge is worse than a missing one: it is what
 * made this issue dangerous in the first place.
 */

import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../../scope-resolution/workspace-index.js';
import {
  buildRustModuleIndex,
  moduleOfDef,
  moduleOfFile,
  resolveAnchoredModulePath,
  sameModule,
  type RustModule,
  type RustModuleIndex,
} from './module-path.js';

/** Callable def kinds a call site may target. */
const CALLABLE_TYPES = new Set(['Function', 'Method', 'Constructor']);

/**
 * Per-run memo of the crate-root index, keyed by the file set it was built from.
 * The hook is invoked per call site; rebuilding the index each time would make
 * qualified-call resolution O(sites x files).
 */
const MODULE_INDEX_CACHE = new WeakMap<ReadonlySet<string>, RustModuleIndex>();

function moduleIndexFor(allFilePaths: ReadonlySet<string>): RustModuleIndex {
  let index = MODULE_INDEX_CACHE.get(allFilePaths);
  if (index === undefined) {
    index = buildRustModuleIndex(allFilePaths);
    MODULE_INDEX_CACHE.set(allFilePaths, index);
  }
  return index;
}

export function resolveRustQualifiedFreeCall(
  site: { readonly name: string; readonly rawQualifiedName?: string; readonly inScope: ScopeId },
  callerParsed: ParsedFile,
  scopes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
  allFilePaths: ReadonlySet<string>,
): SymbolDefinition | undefined {
  const raw = site.rawQualifiedName;
  if (raw === undefined) return undefined;

  const segments = raw
    .split('::')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Everything before the callee name names modules.
  const qualifier = segments.slice(0, -1);
  if (qualifier.length === 0) return undefined;

  const index = moduleIndexFor(allFilePaths);
  const callerModule = callerModuleOf(callerParsed, site.inScope, scopes, index);
  if (callerModule === undefined) return undefined;

  const anchored = resolveAnchoredModulePath(qualifier, callerModule);
  if (anchored === undefined) return undefined;

  for (const targetModule of candidateModules(
    anchored,
    qualifier,
    callerModule,
    callerParsed,
    scopes,
    workspaceIndex,
    index,
  )) {
    const hit =
      findMemberInModule(targetModule, site.name, scopes, workspaceIndex, index) ??
      findReexportedMember(targetModule, site.name, scopes, workspaceIndex, index);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * The module the call site sits in: its file's module path plus any `mod` blocks
 * around it. Walking the scope chain (rather than reading the file alone) is what
 * makes `super::` correct from inside an inline module.
 */
function callerModuleOf(
  callerParsed: ParsedFile,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  index: RustModuleIndex,
): RustModule | undefined {
  const fileModule = moduleOfFile(callerParsed.filePath, index);
  if (fileModule === undefined) return undefined;

  const inline: string[] = [];
  let scopeId: ScopeId | null = inScope;
  while (scopeId !== null) {
    const scope = scopes.scopeTree.getScope(scopeId);
    if (scope === undefined) break;
    if (scope.kind === 'Namespace') {
      const nsDef = scope.ownedDefs.find((d) => d.type === 'Namespace');
      const name = nsDef?.qualifiedName;
      if (name !== undefined && name.length > 0) {
        inline.unshift(name.slice(name.lastIndexOf('.') + 1));
      }
    }
    scopeId = scope.parent;
  }
  return { crateRoot: fileModule.crateRoot, segments: [...fileModule.segments, ...inline] };
}

/**
 * Module paths the qualifier could name, in rustc's first-segment lookup order.
 * An anchored path (`crate::`, `self::`, `super::`) names exactly one module and
 * admits no alternatives.
 */
function* candidateModules(
  anchored: { readonly module: RustModule; readonly anchored: boolean },
  qualifier: readonly string[],
  callerModule: RustModule,
  callerParsed: ParsedFile,
  scopes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
  index: RustModuleIndex,
): Generator<RustModule> {
  if (anchored.anchored) {
    yield anchored.module;
    return;
  }

  // 1. A submodule the caller actually DECLARES (`mod inner { … }` or
  //    `mod tools;`) — the in-scope type-namespace binding.
  //
  //    This must be checked, not assumed. Yielding `callerModule ++ qualifier`
  //    unconditionally let file layout outrank a real `use` binding: with
  //    `use crate::b;` in `src/a/mod.rs` and an undeclared (or `cfg`-gated)
  //    `src/a/b.rs` sitting on disk, `b::f()` bound to the sibling file, where
  //    rustc resolves it to `crate::b` (#2741 review).
  //
  //    A `mod` declaration — inline or file-backed — emits a `Namespace` def
  //    bound in the declaring scope, so the check is a binding lookup.
  const head = qualifier[0];
  if (head !== undefined && declaresSubmodule(callerParsed, head, workspaceIndex)) {
    yield { crateRoot: callerModule.crateRoot, segments: [...callerModule.segments, ...qualifier] };
  }

  // 2. A `use` binding for the first segment. Finalize already resolved the
  //    import to a file, so the module path comes back through the same
  //    file → module mapping as everything else. Covers `use crate::tools;`,
  //    `use crate::tools::{self}` and `use crate::a::b as tools`.
  //
  //    The binding must name a MODULE, not a symbol inside one. Import
  //    resolution deliberately strips a trailing symbol segment when probing for
  //    a file ("the last segment might be a symbol, not a module" —
  //    import-resolvers/rust.ts), so `use crate::client::ClientBuilder;` also
  //    lands on `client/mod.rs`. Taking that at face value made the imported
  //    TYPE look like the module `client`, and `ClientBuilder::new()` then
  //    resolved against `client`'s module members — binding an associated
  //    function to an unrelated module-level `new` (#2741 review H2).
  for (const edge of scopes.imports.get(callerParsed.moduleScope) ?? []) {
    if (edge.localName !== head || edge.targetFile === null) continue;
    const importedModule = moduleOfFile(edge.targetFile, index);
    if (importedModule === undefined) continue;
    if (!importNamesModule(edge.targetExportedName, importedModule)) continue;
    yield {
      crateRoot: importedModule.crateRoot,
      segments: [...importedModule.segments, ...qualifier.slice(1)],
    };
  }

  // 3. Crate-root-relative (`a::b::f()` written from a nested module — 2015
  //    edition style, and still what a single-file crate looks like).
  if (callerModule.segments.length > 0) {
    yield { crateRoot: callerModule.crateRoot, segments: [...qualifier] };
  }
}

/**
 * Does the calling file declare `name` as a submodule (`mod name;` or
 * `mod name { … }`)? Both forms emit a `Namespace` def bound locally in the
 * declaring scope, so this is a binding lookup rather than a filesystem probe.
 */
function declaresSubmodule(
  callerParsed: ParsedFile,
  name: string,
  workspaceIndex: WorkspaceResolutionIndex,
): boolean {
  const moduleScope = workspaceIndex.moduleScopeByFile.get(callerParsed.filePath);
  if (moduleScope === undefined) return false;
  for (const ref of moduleScope.bindings.get(name) ?? []) {
    if (ref.origin === 'local' && ref.def.type === 'Namespace') return true;
  }
  return false;
}

/**
 * Does this `use` binding name the module it resolved to, rather than a symbol
 * declared inside it?
 *
 * The edge's `targetExportedName` is the tail of the written path, so comparing
 * it to the resolved module's own tail separates the two cases exactly:
 *
 *   use crate::tools;                 tail `tools`         module ['tools']     ✓
 *   use crate::a::b as tools;         tail `b`             module ['a','b']     ✓ (alias)
 *   use crate::tools::{self, Ctx};    tail `tools`         module ['tools']     ✓
 *   use crate::client::ClientBuilder; tail `ClientBuilder` module ['client']    ✗ a type
 *
 * An import of the crate-root module itself has no tail segment to match; those
 * are left to the anchored (`crate::`) channel rather than guessed at here.
 */
function importNamesModule(targetExportedName: string, module: RustModule): boolean {
  const tail = module.segments[module.segments.length - 1];
  return tail !== undefined && tail === targetExportedName;
}

/**
 * Is `def` a MEMBER of its module, rather than merely a callable sitting in the
 * same file?
 *
 * Module membership cannot be inferred from the file path: a `fn` nested inside
 * another `fn` has the same `filePath`, the same bare `qualifiedName` and no
 * owner, so a path-only test counts it as a second member of the module. That
 * ties `findMemberInModule`, which then refuses and hands the site back to the
 * lexical walk — reinstating the very self-loop #2730 fixes, from a module that
 * merely happens to contain a local helper (#2741 review H3).
 *
 * The scope model already draws the line exactly: a module-level item is bound
 * with `origin: 'local'` in its module's own scope, a function-local item binds
 * in the enclosing Block, and an `impl`/trait method binds in the Class scope.
 * So membership is a binding lookup, not a path comparison.
 *
 * Inline-`mod` members bind in their `Namespace` scope rather than the file's
 * Module scope, and reaching that scope would mean walking every child scope
 * (faulting them in from disk on the out-of-core path). They are instead
 * identified by the `namespacePrefix` the shared tagging pass stamps on them,
 * which a file-module member never carries. Residual: a `fn` nested inside a
 * `fn` that is itself inside an inline `mod` inherits that prefix and is still
 * counted — a strictly smaller hole than before, and one that only costs a
 * refusal, never a wrong edge.
 */
function isModuleLevelMember(
  def: SymbolDefinition,
  name: string,
  workspaceIndex: WorkspaceResolutionIndex,
): boolean {
  if (def.namespacePrefix !== undefined && def.namespacePrefix !== '') return true;
  const moduleScope = workspaceIndex.moduleScopeByFile.get(def.filePath);
  if (moduleScope === undefined) return false;
  for (const ref of moduleScope.bindings.get(name) ?? []) {
    if (ref.origin === 'local' && ref.def.nodeId === def.nodeId) return true;
  }
  return false;
}

/** A callable named `name` declared directly in `targetModule`. Refuses on a tie. */
function findMemberInModule(
  targetModule: RustModule,
  name: string,
  scopes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
  index: RustModuleIndex,
): SymbolDefinition | undefined {
  let unique: SymbolDefinition | undefined;
  let count = 0;
  for (const defId of scopes.qualifiedNames.get(name)) {
    const def = scopes.defs.get(defId);
    if (def === undefined || !CALLABLE_TYPES.has(def.type)) continue;
    const defModule = moduleOfDef(def.filePath, def.namespacePrefix, index);
    if (defModule === undefined || !sameModule(defModule, targetModule)) continue;
    if (!isModuleLevelMember(def, name, workspaceIndex)) continue;
    unique = def;
    count++;
  }
  return count === 1 ? unique : undefined;
}

/**
 * A member the target module re-exports rather than declares (`pub use
 * crate::tools::dispatch;`). rustc treats a re-export as an ordinary binding in
 * the module's resolution table, so a call through the facade must land on the
 * original definition.
 *
 * Finalize does NOT create a local binding for a re-export on the re-exporting
 * module's own scope — a `pub use` is modelled as visibility granted to
 * IMPORTERS, so the re-exporting file's `bindings` map is empty. The re-export
 * survives as an `ImportEdge` on that module scope, which is what this reads.
 *
 * Known limitation: only FILE modules are reachable here. `moduleScopeByFile`
 * holds one Module scope per file, so a re-export declared inside an inline
 * `mod facade { pub use … }` has no entry and is not resolved. Reaching it would
 * mean walking every child scope, which faults the whole scope tree back in from
 * disk on the out-of-core path — the cost this index exists to avoid. A miss
 * here falls through to the unchanged chain rather than guessing (#2741 review).
 */
function findReexportedMember(
  targetModule: RustModule,
  name: string,
  scopes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
  index: RustModuleIndex,
): SymbolDefinition | undefined {
  let unique: SymbolDefinition | undefined;
  let count = 0;

  for (const [filePath, moduleScope] of workspaceIndex.moduleScopeByFile) {
    const fileModule = moduleOfFile(filePath, index);
    if (fileModule === undefined || !sameModule(fileModule, targetModule)) continue;

    for (const edge of scopes.imports.get(moduleScope.id) ?? []) {
      if (edge.localName !== name) continue;
      // Only a `pub use` re-exports. A private `use` (`named`) makes the name
      // visible INSIDE the module and does not put it on the module's public
      // surface, so treating one as a re-export resolved paths that do not
      // compile. `alias` carries `pub use x::y as name`, which does re-export.
      if (edge.kind !== 'reexport' && edge.kind !== 'alias') continue;

      const resolved = resolveReexportTarget(edge, name, scopes, workspaceIndex);
      if (resolved === undefined) continue;
      // Refuse on a tie rather than taking whichever file the pool happened to
      // parse first: two `cfg`-exclusive facades re-exporting the same name are
      // indistinguishable here, and picking one is a coin flip baked into the graph.
      if (unique !== undefined && resolved.nodeId !== unique.nodeId) return undefined;
      unique = resolved;
      count++;
    }
  }
  return count >= 1 ? unique : undefined;
}

/** Follow one re-export edge to the definition it exposes. */
function resolveReexportTarget(
  edge: { readonly targetDefId?: string; readonly targetFile: string | null },
  name: string,
  scopes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
): SymbolDefinition | undefined {
  const viaDefId = edge.targetDefId;
  if (viaDefId !== undefined) {
    const def = scopes.defs.get(viaDefId);
    if (def !== undefined && CALLABLE_TYPES.has(def.type)) return def;
  }
  // No pre-resolved def id: fall back to the exporting file's own module.
  if (edge.targetFile === null) return undefined;
  return findExportedCallable(edge.targetFile, name, workspaceIndex);
}

/** Module-scope callable declared locally by `targetFile`. */
function findExportedCallable(
  targetFile: string,
  name: string,
  workspaceIndex: WorkspaceResolutionIndex,
): SymbolDefinition | undefined {
  const moduleScope = workspaceIndex.moduleScopeByFile.get(targetFile);
  if (moduleScope === undefined) return undefined;
  for (const ref of moduleScope.bindings.get(name) ?? []) {
    if (ref.origin === 'local' && CALLABLE_TYPES.has(ref.def.type)) return ref.def;
  }
  return undefined;
}

/** Re-exported for the resolver's unit tests. */
export { moduleOfFile, moduleOfDef };
export type { ScopeResolutionIndexes };
