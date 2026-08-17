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

import type { ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { perFileSet } from '../../import-resolvers/per-file-set.js';
import { isOverloadableCallable } from '../../utils/callable-labels.js';
import { lookupBindingsAt } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../../scope-resolution/workspace-index.js';
import {
  buildRustModuleIndex,
  couldNameAModule,
  moduleOfDef,
  moduleOfFile,
  resolveAnchoredModulePath,
  sameModule,
  type RustModule,
  type RustModuleIndex,
} from './module-path.js';

/**
 * Per-run memo of the crate-root index, keyed by the file set it was built from.
 * The hook is invoked per call site; rebuilding the index each time would make
 * qualified-call resolution O(sites x files).
 */
const moduleIndexFor = perFileSet(
  (allFilePaths: ReadonlySet<string>): RustModuleIndex => buildRustModuleIndex(allFilePaths),
);

export function resolveRustQualifiedFreeCall(
  site: { readonly name: string; readonly rawQualifiedName?: string; readonly inScope: ScopeId },
  callerParsed: ParsedFile,
  scopes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
  allFilePaths: ReadonlySet<string>,
): SymbolDefinition | undefined {
  const raw = site.rawQualifiedName;
  if (raw === undefined) return undefined;

  // A leading `::` anchors at the EXTERN PRELUDE — `::tools::dispatch()` names
  // the crate `tools`, not a module of this one. Extern crates are outside the
  // workspace module tree, so the honest answer is to refuse. Filtering the empty
  // first segment out instead silently reinterpreted the path as relative and
  // resolved it against a local module of the same name.
  if (raw.trimStart().startsWith('::')) return undefined;

  const segments = raw
    .split('::')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Everything before the callee name names modules.
  const qualifier = segments.slice(0, -1);
  if (qualifier.length === 0) return undefined;

  // Cheap rejection before the candidate SEARCH. The capture that carries
  // `rawQualifiedName` matches every `scoped_identifier` callee, so this hook is
  // reached by `Vec::new()`, `String::from()`, `Self::method()` and every other
  // type-qualified call — the overwhelming majority of `::` calls in real Rust,
  // none of which name a module. Letting those through meant each one paid a
  // same-name-bucket scan plus a walk of every module scope in the workspace
  // before returning undefined (#2741 review).
  //
  // `passIndexFor` is not free on its FIRST call in a pass — it walks the def
  // index once — so this is not "before any index work", as an earlier version of
  // this comment claimed. It is memoized per resolution pass on a WeakMap, over
  // structures already resident in memory, and every later site here is a set
  // lookup. What the filter still buys is skipping the per-site candidate search,
  // which is the part that scales with the workspace.
  const index = moduleIndexFor(allFilePaths);
  const pass = passIndexFor(workspaceIndex, index, scopes);
  if (!couldNameAModule(qualifier, pass.knownModuleNames)) {
    return undefined;
  }

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
  if (
    head !== undefined &&
    declaresSubmodule(callerParsed, callerModule, head, workspaceIndex, index, scopes)
  ) {
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
  //
  //    Skipped when the head already names something else in the caller's own
  //    module. This is the loosest candidate — a guess at a path the caller never
  //    wrote — and in Rust 2018 a bare first segment resolves in the caller's
  //    module, not at the crate root, so a local binding for it settles the
  //    question. Without the check, a crate-root `mod` whose name matches an
  //    imported TYPE captured the call:
  //
  //      // src/lib.rs
  //      pub mod Buffer { pub fn with_capacity() -> usize { 111 } }
  //      // src/b.rs
  //      use crate::c::Buffer;                        // the real target, in c.rs
  //      pub fn call() -> usize { Buffer::with_capacity() }
  //
  //    which yielded `CALLS b::call -> lib.rs:Buffer.with_capacity`, an edge to a
  //    callee the source never names. The base emitted no edge at all, and per the
  //    doctrine quoted in `ids.ts` that is the correct failure direction: a missing
  //    edge is recoverable, a fabricated caller silently misleads `impact`.
  if (callerModule.segments.length > 0 && !headBoundLocally(callerParsed, head, scopes)) {
    yield { crateRoot: callerModule.crateRoot, segments: [...qualifier] };
  }
}

/**
 * Is `name` bound in the caller's own module to anything that is NOT a module?
 *
 * A `use crate::c::Buffer;` binds the TYPE `Buffer`, so a bare `Buffer::…` path in
 * that file resolves through the import — never to a same-named module elsewhere in
 * the crate. Module bindings are excluded so the legitimate `use crate::tools;`
 * case, which candidate 2 already handles, is not double-counted here.
 */
function headBoundLocally(
  callerParsed: ParsedFile,
  name: string | undefined,
  scopes: ScopeResolutionIndexes,
): boolean {
  if (name === undefined) return false;
  // Read through `lookupBindingsAt`, not the raw `Scope.bindings` map: a `use`
  // binding is finalize OUTPUT and is absent from the scope's own local table, so
  // the direct read saw nothing for exactly the imported-type case this guards
  // (contract I8 in `contract/scope-resolver.ts` requires this channel anyway).
  for (const ref of lookupBindingsAt(callerParsed.moduleScope, name, scopes)) {
    if (ref.def.type !== 'Namespace') return true;
  }
  return false;
}

/** Tail segment of a dot-joined qualified name (`outer.tools` → `tools`). */
function tailSegment(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1);
}

/**
 * Does the caller's own module declare `name` as a submodule (`mod name;` or
 * `mod name { … }`)?
 *
 * Answered against the set of module paths the workspace actually DECLARES, so it
 * holds at any nesting depth. The previous binding lookup went through
 * `moduleScopeByFile`, which maps a file to its root `Module` scope only: a `mod`
 * nested inside an inline `mod` binds in that parent module's scope and was
 * therefore invisible. `mod outer { mod tools { … } fn dispatch() { tools::dispatch() } }`
 * skipped this candidate entirely and fell through to the lexical tier, which
 * reinstated the very #2730 self-loop this hook exists to prevent.
 *
 * Still a declaration check, not a filesystem probe: the set is built from
 * `Namespace` defs, so an undeclared (or `cfg`-gated) file sitting on disk
 * contributes nothing and cannot outrank a real `use` binding (#2741 review).
 */
function declaresSubmodule(
  callerParsed: ParsedFile,
  callerModule: RustModule,
  name: string,
  workspaceIndex: WorkspaceResolutionIndex,
  index: RustModuleIndex,
  scopes: ScopeResolutionIndexes,
): boolean {
  // Inline modules at any depth, keyed by full path.
  const inline = passIndexFor(workspaceIndex, index, scopes).inlineModuleKeys;
  if (
    inline.has(
      moduleKey({ crateRoot: callerModule.crateRoot, segments: [...callerModule.segments, name] }),
    )
  ) {
    return true;
  }

  // File-backed submodules (`mod tools;`) still go through the declaring scope's
  // binding table. A `Namespace` def bound locally is the DECLARATION; probing the
  // file set instead would let an undeclared or `cfg`-gated file on disk outrank a
  // real `use` binding (#2741 review).
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
    if (def === undefined || !isOverloadableCallable(def.type)) continue;
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

  for (const moduleScope of moduleScopesFor(targetModule, workspaceIndex, index, scopes)) {
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

/**
 * Module → the file-module scopes that realise it, built once per resolution
 * pass instead of per candidate.
 *
 * The previous shape walked all of `workspaceIndex.moduleScopeByFile` for every
 * candidate module of every qualified call, so total cost grew as
 * `sites x files`. On the out-of-core scope index that walk is worse than CPU:
 * `moduleScopeByFile` fetches through `scopeTree.getScope`, so a full sweep can
 * fault every module scope back in from disk — the exact pattern
 * `workspace-index.ts` added `exportedCallableByName` to avoid (#2741 review).
 *
 * Keyed on the `WorkspaceResolutionIndex` identity, which is rebuilt per pass.
 */
interface PassModuleIndex {
  /** Module identity key → the file-module scopes realising it. */
  readonly scopesByModule: ReadonlyMap<string, readonly Scope[]>;
  /**
   * Every module name resolution may legitimately see: the file-derived names
   * from the path index, UNIONED with inline `mod x { … }` names, which exist in
   * no file path and would otherwise be rejected by the negative filter before
   * any candidate ran (#2742).
   */
  readonly knownModuleNames: ReadonlySet<string>;
  /**
   * `moduleKey` of every INLINE module path in the workspace, at any depth.
   * Distinct from `knownModuleNames`, a flat name set used only as a negative
   * filter: this one answers "is `<callerModule>::<name>` a real inline
   * submodule", which the name set cannot (two unrelated modules share a tail).
   */
  readonly inlineModuleKeys: ReadonlySet<string>;
}

/**
 * DELIBERATELY NOT ON `import-resolvers/per-file-set.ts` (#2909 sweep), unlike
 * {@link moduleIndexFor} above. {@link passIndexFor} takes THREE inputs —
 * `workspaceIndex`, `index` and `scopes` — and keys on the first alone; the
 * builder reads `scopes.defs.byId` and `index`, neither of which is derivable
 * from the key, and `perFileSet`'s `build: (key) => T` hands the builder
 * nothing but the key. Sound here only because all three share the resolution
 * pass's lifetime, which is an invariant the primitive cannot express.
 */
const MODULE_SCOPE_CACHE = new WeakMap<WorkspaceResolutionIndex, PassModuleIndex>();

function moduleKey(module: RustModule): string {
  return `${module.crateRoot}\u0000${module.segments.join('::')}`;
}

function passIndexFor(
  workspaceIndex: WorkspaceResolutionIndex,
  index: RustModuleIndex,
  scopes: ScopeResolutionIndexes,
): PassModuleIndex {
  let pass = MODULE_SCOPE_CACHE.get(workspaceIndex);
  if (pass === undefined) {
    const scopesByModule = new Map<string, Scope[]>();
    const knownModuleNames = new Set<string>(index.moduleNames);

    // Inline `mod x { … }` never appears in a file path, so its name exists only
    // as a `Namespace` def. Read from the def index rather than from module-scope
    // bindings: `moduleScopeByFile` holds each file's ROOT `Module` scope only, so
    // a binding walk saw depth-1 inline modules and missed every nested one —
    // `mod outer { mod tools { … } }` left `tools` out of the set, and this gate
    // then rejected `tools::dispatch()` before any module walk could resolve it.
    //
    // One pass over the defs, memoized per resolution pass on the WeakMap above,
    // over an already-resident in-memory index — the same order of work as the
    // binding walk it replaces, and it subsumes it (a `mod` declaration at any
    // depth is a `Namespace` def).
    //
    // The same pass records every INLINE module path, which is what
    // `declaresSubmodule` needs at depth > 1.
    //
    // Derived from the MEMBERS, not from the `Namespace` defs: a `mod` def carries
    // no nesting information of its own (`mod outer { mod tools { … } }` gives the
    // inner def `qualifiedName: 'tools'` and NO `namespacePrefix`), whereas every
    // def inside it is stamped `outer.tools` by `tagNamespacePrefixes`. A
    // `Namespace` scope also owns its OWN def rather than its children's, so
    // walking scopes cannot answer this either — the `mod outer` scope lists
    // `outer`, never `tools`.
    //
    // Restricted to non-empty prefixes on purpose: those come from `mod` blocks in
    // source, so this stays a DECLARATION check. Including file-derived modules
    // here would let an undeclared (or `cfg`-gated) file on disk outrank a real
    // `use` binding — the #2741 review regression. File-backed submodules keep
    // going through the binding check in `declaresSubmodule`.
    //
    // A module containing no defs at all is absent, which is harmless: it has no
    // member for a qualified call to resolve to.
    const inlineModuleKeys = new Set<string>();
    for (const def of scopes.defs.byId.values()) {
      if (def.type === 'Namespace' && def.qualifiedName !== undefined) {
        knownModuleNames.add(tailSegment(def.qualifiedName));
      }
      if (def.namespacePrefix === undefined || def.namespacePrefix === '') continue;
      const declaringModule = moduleOfDef(def.filePath, def.namespacePrefix, index);
      if (declaringModule !== undefined) inlineModuleKeys.add(moduleKey(declaringModule));
    }

    for (const [filePath, moduleScope] of workspaceIndex.moduleScopeByFile) {
      const fileModule = moduleOfFile(filePath, index);
      if (fileModule === undefined) continue;
      const key = moduleKey(fileModule);
      const bucket = scopesByModule.get(key);
      if (bucket === undefined) scopesByModule.set(key, [moduleScope]);
      else bucket.push(moduleScope);
    }
    pass = { scopesByModule, knownModuleNames, inlineModuleKeys };
    MODULE_SCOPE_CACHE.set(workspaceIndex, pass);
  }
  return pass;
}

function moduleScopesFor(
  targetModule: RustModule,
  workspaceIndex: WorkspaceResolutionIndex,
  index: RustModuleIndex,
  scopes: ScopeResolutionIndexes,
): readonly Scope[] {
  return (
    passIndexFor(workspaceIndex, index, scopes).scopesByModule.get(moduleKey(targetModule)) ??
    EMPTY_SCOPES
  );
}

const EMPTY_SCOPES: readonly Scope[] = Object.freeze([]);

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
    if (def !== undefined && isOverloadableCallable(def.type)) return def;
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
    if (ref.origin === 'local' && isOverloadableCallable(ref.def.type)) return ref.def;
  }
  return undefined;
}
