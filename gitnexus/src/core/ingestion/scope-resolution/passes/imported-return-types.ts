/**
 * Cross-file return-type typeBinding propagation + post-finalize
 * chain re-follow.
 *
 * **Why this lives in scope-resolution:** the algorithm is language-agnostic.
 * Every language with cross-file callable imports needs the same
 * mirror-binding step, otherwise `u = f(); u.save()` only resolves
 * when `f` is in the same file as the call.
 *
 * **Mutation contract (Contract Invariant I3 + I6):**
 *   - Mutates `Scope.typeBindings` (a plain `new Map(...)` from
 *     `draftToScope`, NOT frozen — intentional, do not freeze).
 *   - MUST run AFTER `finalizeScopeModel` (so `indexes.bindings` is
 *     populated) but BEFORE `resolveReferenceSites` (so resolution
 *     sees the propagated types).
 *
 * **Ordering invariant (added 2026-04-24, RFC #909 Ring 3 / PR #1050):**
 * The pass walks files in `indexes.sccs` reverse-topological order
 * (leaves first per `tarjanSccs`). For each importer we chain-follow
 * the source module's typeBindings BEFORE mirroring, so a multi-hop
 * alias chain like
 *
 *   models.ts: function getUser(): User
 *   service.ts: export const user = getUser()        // user → getUser
 *   app.ts: import { user } from './service'         // user → ?
 *
 * collapses to `app.user → User` in a single pass instead of stopping
 * at the intermediate `getUser` ref. The motivating regression is the
 * `ts-simple` integration fixture (`gitnexus/test/fixtures/scope-
 * resolution/cross-file-binding/ts-simple/`), where `user.save()` and
 * `user.getName()` only resolve when the chain collapse happens
 * topologically.
 *
 * Cyclic SCCs reach a partial fixpoint via the same mirror step but
 * are not guaranteed to fully resolve — see the `ts-circular`
 * fixture, which only asserts pipeline-no-throw.
 *
 * Generic; promoted from `languages/python/scope-resolver.ts` per the
 * scope-resolution generalization plan.
 */

import type {
  ImportEdge,
  ParsedFile,
  Scope,
  ScopeId,
  SymbolDefinition,
  TypeRef,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';
import type { ScopeResolver } from '../contract/scope-resolver.js';
import { definitionIdPosition } from '../utils/definition-id.js';
import { followedStep } from '../../utils/type-ref-chain.js';
import {
  lookupBindingsAt,
  lookupNameClaim,
  findReceiverTypeBinding,
  namesAtScope,
  moduleScopeIdOf,
  namespaceTypeBindingFor,
} from '../scope/walkers.js';

/** Definition identity → its own type fact; built once, facts read lazily after propagation. */
interface TypeFactOwner {
  readonly scope: ScopeId;
  readonly name: string;
}
const typeFactOwners = new WeakMap<ScopeResolutionIndexes, Map<string, TypeFactOwner>>();
/** The type fact a definition declares for itself (a callable's return type),
 *  joined by definition identity rather than by name. */
export function producerTypeRef(
  defId: string,
  scopes: ScopeResolutionIndexes,
): TypeRef | undefined {
  let owners = typeFactOwners.get(scopes);
  if (owners === undefined) {
    owners = new Map();
    const returnsByDeclaration = new Map<string, TypeFactOwner | null>();
    const definitions = new Map<string, SymbolDefinition>();
    const pending = [...scopes.moduleScopes.byFilePath.values()];
    const visited = new Set<ScopeId>();
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      const scope = scopes.scopeTree.getScope(id);
      if (scope === undefined) continue;
      for (const child of scopes.scopeTree.getChildren(id)) pending.push(child);
      for (const def of scope.ownedDefs ?? []) definitions.set(def.nodeId, def);
      for (const [name, ref] of scope.typeBindings) {
        // Some providers hoist method return annotations to the module. Join
        // those facts by their declaration anchor, never by an enclosing name.
        if (
          ref.source !== 'return-annotation' ||
          ref.bindingRange === undefined ||
          ref.declaredAtScope !== scope.id
        )
          continue;
        const key = `${scope.filePath}\0${ref.bindingRange.startLine}:${ref.bindingRange.startCol}`;
        returnsByDeclaration.set(
          key,
          returnsByDeclaration.has(key) ? null : { scope: scope.id, name },
        );
      }
      for (const [name, bindings] of scope.bindings) {
        for (const binding of bindings) {
          if (binding.origin !== 'local') continue;
          definitions.set(binding.def.nodeId, binding.def);
          const ref = scope.typeBindings.get(name);
          if (
            ref !== undefined &&
            !(ref.source === 'return-annotation' && ref.bindingRange !== undefined)
          )
            owners.set(binding.def.nodeId, { scope: scope.id, name });
        }
      }
    }
    for (const def of definitions.values()) {
      const position = definitionIdPosition(def.nodeId, def.filePath);
      if (position === undefined) continue;
      const owner = returnsByDeclaration.get(
        `${def.filePath}\0${position.line}:${position.column}`,
      );
      if (owner !== undefined && owner !== null) owners.set(def.nodeId, owner);
    }
    typeFactOwners.set(scopes, owners);
  }
  const owner = owners.get(defId);
  return owner === undefined
    ? undefined
    : scopes.scopeTree.getScope(owner.scope)?.typeBindings.get(owner.name);
}

/**
 * Max chain depth for the post-finalize re-follow. Effective end-to-end
 * depth is roughly 2× this number, because chain-following runs once
 * inside each importer's source module before mirroring AND once on
 * the importer's own typeBindings after mirroring; deeply nested
 * intra-module aliases can compose with cross-file aliases of the same
 * depth. 8 covers all production fixtures with headroom.
 */
const RECHAIN_MAX_DEPTH = 8;

/** `head.member`, both plain identifiers. */
const QUALIFIED_MEMBER_RE = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/;

/**
 * Every local name a resolved namespace import binds anywhere in the
 * workspace. Most dotted bindings are member chains (`user.address`), or name
 * an external module (`np.zeros`), and skip the scope-chain lookup entirely.
 * Read from the finalized import map, never `scopeTree.byId`, which a sealed
 * disk-backed tree cannot materialize. Import edges are fixed once finalize
 * has run.
 */
const namespaceLocalNamesByIndexes = new WeakMap<ScopeResolutionIndexes, ReadonlySet<string>>();

/**
 * A resolved namespace import whose local name stands for its target module.
 * An unaliased path import (`import pkg.sub`) binds the root `pkg` while its
 * target is the leaf `pkg/sub`, so the target's members are not `pkg`'s.
 */
function bindsTargetModule(edge: ImportEdge): boolean {
  if (
    edge.kind !== 'namespace' ||
    edge.linkStatus === 'unresolved' ||
    edge.targetModuleScope === undefined
  ) {
    return false;
  }
  if (edge.explicitAlias === true || !edge.targetExportedName.startsWith(`${edge.localName}.`)) {
    return true;
  }
  const file = edge.targetFile?.split(/[\\/]/).pop() ?? '';
  const dot = file.indexOf('.');
  return (dot === -1 ? file : file.slice(0, dot)) === edge.localName;
}
function namespaceLocalNames(scopes: ScopeResolutionIndexes): ReadonlySet<string> {
  let names = namespaceLocalNamesByIndexes.get(scopes);
  if (names === undefined) {
    const collected = new Set<string>();
    for (const edges of scopes.imports.values()) {
      for (const edge of edges) {
        if (bindsTargetModule(edge)) collected.add(edge.localName);
      }
    }
    names = collected;
    namespaceLocalNamesByIndexes.set(scopes, names);
  }
  return names;
}

/**
 * Some providers hoist method return types to the module scope under the
 * method's name, so a module-scope return binding named `member` can belong
 * to a class method. Accept it only when it is anchored on a free function the
 * module itself binds under that name: the declaration-anchor join
 * `producerTypeRef` uses. Providers that bind receiver methods at module
 * scope (`func (f *T) Create()`) put a `Method` there, which never qualifies.
 */
function isModuleOwnReturn(returned: TypeRef, module: Scope, member: string): boolean {
  const anchor = returned.bindingRange;
  if (anchor === undefined) return true;
  return (module.bindings.get(member) ?? []).some((binding) => {
    if (binding.origin !== 'local' || binding.def.type !== 'Function') return false;
    const position = definitionIdPosition(binding.def.nodeId, binding.def.filePath);
    return position?.line === anchor.startLine && position.column === anchor.startCol;
  });
}

/**
 * `ns.f` where `ns` is a namespace import and `f` has a return annotation in
 * the target module: that return type, as a named import of `f` gets through
 * `propagateImportedReturnTypes` (#3498). A class member (`ns.C`) has no
 * return annotation and keeps resolving as a construction.
 */
export function namespaceCallReturnType(
  rawName: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  position?: TypeRef['lookupPosition'],
): TypeRef | undefined {
  const [, head, member] = QUALIFIED_MEMBER_RE.exec(rawName) ?? [];
  if (head === undefined || member === undefined || !namespaceLocalNames(scopes).has(head)) {
    return undefined;
  }
  const claim = lookupNameClaim(inScope, head, scopes, { position, purpose: 'value' });
  if (claim.bindings.some((binding) => binding.origin === 'local')) return undefined;
  const targets = new Set<ScopeId>();
  for (const edge of claim.imports) {
    if (bindsTargetModule(edge) && edge.targetModuleScope !== undefined) {
      targets.add(edge.targetModuleScope);
    }
  }
  const [target] = targets;
  if (targets.size !== 1 || target === undefined) return undefined;
  const module = scopes.scopeTree.getScope(target);
  const returned = module?.typeBindings.get(member);
  return module !== undefined &&
    returned?.source === 'return-annotation' &&
    isModuleOwnReturn(returned, module, member)
    ? returned
    : undefined;
}

/** `ScopeResolver.resolveQualifiedCallee` bound to one resolution pass. */
export type QualifiedCalleeResolver = (
  calleeText: string,
  inScope: ScopeId,
) => SymbolDefinition | undefined;

/** Bind the provider's qualified-callee hook to this pass's indexes, or
 *  `undefined` when the language has none. The file-path set is built on first
 *  use, so a pass that never asks pays nothing. */
export function bindQualifiedCalleeResolver(
  hook: ScopeResolver['resolveQualifiedCallee'],
  scopes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
  parsedFiles: readonly ParsedFile[],
): QualifiedCalleeResolver | undefined {
  if (hook === undefined) return undefined;
  let allFilePaths: ReadonlySet<string> | undefined;
  return (calleeText, inScope) => {
    allFilePaths ??= new Set(parsedFiles.map((parsed) => parsed.filePath));
    return hook(calleeText, inScope, scopes, workspaceIndex, allFilePaths);
  };
}

/**
 * A callee only the provider can read (`rp::make`, #3498): the return
 * annotation of the callable it resolves to, read by definition identity like
 * the producer lookup in {@link followChainPostFinalize}. `undefined` when the
 * provider resolves nothing or the callable declares no return type.
 */
export function qualifiedCalleeReturnType(
  calleeText: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  resolveCallee: QualifiedCalleeResolver | undefined,
): TypeRef | undefined {
  const callee = resolveCallee?.(calleeText, inScope);
  if (callee === undefined) return undefined;
  const returned = producerTypeRef(callee.nodeId, scopes);
  return returned?.source === 'return-annotation' ? returned : undefined;
}

/** Walk `ref.rawName` through the scope chain's typeBindings looking
 *  for a terminal class-like rawName. Mirrors the in-extractor
 *  `followChainedRef` but operates on post-finalize Scope objects so
 *  it can see imported return-types propagated by
 *  `propagateImportedReturnTypes`. */
export function followChainPostFinalize(
  start: TypeRef,
  fromScopeId: ScopeId,
  scopes: ScopeResolutionIndexes,
  resolveCallee?: QualifiedCalleeResolver,
): TypeRef {
  let current = start;
  const visited = new Set<string>();
  // The caller's module scope is fixed across the walk; resolve it once so the
  // accessibility-gated per-namespace fallback below can be consulted cheaply.
  const moduleScopeId = moduleScopeIdOf(fromScopeId, scopes);
  for (let depth = 0; depth < RECHAIN_MAX_DEPTH; depth++) {
    const lookupScope = current.declaredAtScope ?? fromScopeId;
    if (current.rawName.includes('.')) {
      // A namespace import's function (`ns.make`), else a dotted callee path
      // only the provider can read (`com.acme.mod.make`, #3498).
      const returned =
        namespaceCallReturnType(current.rawName, lookupScope, scopes, current.lookupPosition) ??
        qualifiedCalleeReturnType(current.rawName, lookupScope, scopes, resolveCallee);
      // A qualified return type (`-> models.Order`) names a namespace of the
      // producer's module, which the consumer's receiver lookup would read
      // against its own imports. Stop at the call rather than hand it over.
      if (
        returned === undefined ||
        returned.rawName.includes('.') ||
        visited.has(returned.rawName)
      ) {
        return current;
      }
      visited.add(returned.rawName);
      current = followedStep(start, returned);
      continue;
    }
    const claim = lookupNameClaim(lookupScope, current.rawName, scopes, {
      position: current.lookupPosition,
      purpose: current.lookupPurpose,
    });
    let next = claim.typeBinding;
    if (next === undefined || claim.bindings.some((binding) => binding.origin !== 'local')) {
      const candidates = new Map<string, TypeRef>();
      for (const binding of claim.bindings) {
        const producer = producerTypeRef(binding.def.nodeId, scopes);
        if (producer !== undefined) candidates.set(binding.def.nodeId, producer);
      }
      if (candidates.size > 1) return current;
      if (candidates.size === 1) next = candidates.values().next().value;
    }
    if (claim.status !== 'absent' && next === undefined) return current;
    if (claim.status === 'absent')
      next = findReceiverTypeBinding(lookupScope, current.rawName, scopes, {
        position: current.lookupPosition,
        purpose: current.lookupPurpose,
      });
    if (next === current) next = undefined;
    // Scope-independent fallbacks (#1871), mirroring findReceiverTypeBinding's
    // precedence: named namespaces accessible from this file
    // (`namespaceTypeBindings`, gated by accessibility) first — they lived in the
    // chain pre-#1871 and so must outrank the flat global channel — then the
    // global/default namespace (`workspaceTypeBindings`, visible everywhere).
    // Both live in shared channels rather than each Scope.typeBindings to avoid
    // the O(files × names) blow-up.
    if (next === undefined && claim.status === 'absent') {
      const nsHit = namespaceTypeBindingFor(moduleScopeId, current.rawName, scopes);
      if (nsHit !== undefined && nsHit !== current) next = nsHit;
    }
    if (next === undefined && claim.status === 'absent') {
      const ws = scopes.workspaceTypeBindings?.get(current.rawName);
      if (ws !== undefined && ws !== current) next = ws;
    }
    // Last, a callee path no scope binds (`rp::make`): the provider names the
    // callable, and its return annotation continues the chain (#3498).
    if (next === undefined && claim.status === 'absent')
      next = qualifiedCalleeReturnType(current.rawName, lookupScope, scopes, resolveCallee);
    if (next === undefined) return current;
    if (visited.has(next.rawName)) return current;
    visited.add(next.rawName);
    current = followedStep(start, next);
  }
  return current;
}

/**
 * Copy return-type typeBindings across module boundaries via import
 * bindings. For each module-scope import like `from x import f`, look
 * up `f` in the source file's module-scope typeBindings (which carries
 * `f → ReturnType` from the language's return-type annotation
 * capture) and mirror that binding into the importer's module scope.
 *
 * After propagation, re-runs the chain-follow on every scope's
 * typeBindings — the in-extractor pass-4 ran before propagation and
 * missed any chain whose terminal lived in a foreign file.
 *
 * Finalize can retain lexical import ownership. Mirror into each binding's
 * owning scope, never hoist local import-derived types into the file scope.
 * Module ordering remains SCC-based; non-module chains are followed after
 * all import bindings have been mirrored.
 */
export function propagateImportedReturnTypes(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
  resolveQualifiedCallee?: ScopeResolver['resolveQualifiedCallee'],
): void {
  const moduleScopeByFile = index.moduleScopeByFile;
  const resolveCallee = bindQualifiedCalleeResolver(
    resolveQualifiedCallee,
    indexes,
    index,
    parsedFiles,
  );
  const scopesByFile = new Map(parsedFiles.map((file) => [file.filePath, file.scopes]));

  // Walk SCCs in reverse-topological order (`indexes.sccs` is leaves-
  // first per `tarjanSccs`). For each file we mirror import bindings
  // AFTER chain-following the source module's typeBindings, so a
  // multi-hop alias chain like
  //   models.ts: function getUser(): User
  //   service.ts: export const user = getUser()        // user → getUser
  //   app.ts: import { user } from './service'         // user → ?
  // collapses to `app.user → User` instead of stopping at the
  // intermediate `getUser` ref. Without topological ordering, app.ts
  // could be processed before service.ts had its own typeBindings
  // chain-followed, leaving the importer with an unresolvable interim
  // ref. Cyclic SCCs reach a partial fixpoint via the same mirror
  // step but are not guaranteed to fully resolve — see the
  // ts-circular cross-file-binding fixture which only asserts that
  // the pipeline does not throw.
  for (const scc of indexes.sccs) {
    for (const filePath of scc.files) {
      const importerModule = moduleScopeByFile.get(filePath);
      if (importerModule === undefined) continue;

      // Iterate finalized + augmented binding names at this scope so
      // post-finalize hooks (e.g. `using static` augmentations from
      // `populateCsharpNamespaceSiblings`) are visible to the
      // import-derived typeBinding mirror. Both helpers fast-path when
      // no augmentations exist for the scope, so the common case is
      // allocation-free. See I8.
      for (const importerScope of scopesByFile.get(filePath) ?? [importerModule]) {
        for (const localName of namesAtScope(importerScope.id, indexes)) {
          // Skip if importer already has a typeBinding for this name —
          // an explicit local annotation must win over import-derived.
          if (importerScope.typeBindings.has(localName)) continue;

          const refs = lookupBindingsAt(importerScope.id, localName, indexes);
          for (const ref of refs) {
            if (ref.origin !== 'import' && ref.origin !== 'reexport' && ref.origin !== 'wildcard')
              continue;
            const sourceModule = moduleScopeByFile.get(ref.def.filePath);
            if (sourceModule === undefined) continue;

            // The source file's typeBinding is keyed by the def's simple
            // name (e.g. `get_user`), not the importer's local alias.
            const qn = ref.def.qualifiedName;
            if (qn === undefined) continue;
            const dot = qn.lastIndexOf('.');
            const sourceName = dot === -1 ? qn : qn.slice(dot + 1);

            const sourceTypeRef = sourceModule.typeBindings.get(sourceName);
            if (sourceTypeRef === undefined) continue;

            // Chain-follow inside the source module so we mirror the
            // terminal type, not an intermediate intra-source reference.
            const terminal = followChainPostFinalize(
              sourceTypeRef,
              sourceModule.id,
              indexes,
              resolveCallee,
            );

            // Mutating typeBindings is safe because draftToScope
            // produced a non-frozen Map (Contract Invariant I3/I8).
            (importerScope.typeBindings as Map<string, TypeRef>).set(localName, terminal);
            // First-write-wins for the local alias: if the same
            // `localName` was registered multiple times via
            // `mergeBindings` (rare; happens with conflicting
            // re-exports), only the first ref with a usable
            // typeBinding source is mirrored. Conflict resolution
            // among multiple sources is the merger's job, not ours.
            break;
          }
        }
      }

      // Chain-follow this importer's own module typeBindings now —
      // any local `const x = importedFn()` resolves while we have
      // freshly-mirrored bindings, and downstream importers in a
      // later (closer-to-root) SCC will see x's terminal type rather
      // than an intra-module call ref.
      for (const [name, ref] of importerModule.typeBindings) {
        const resolved = followChainPostFinalize(ref, importerModule.id, indexes, resolveCallee);
        if (resolved !== ref) {
          (importerModule.typeBindings as Map<string, TypeRef>).set(name, resolved);
        }
      }
    }
  }

  // Final pass: chain-follow non-module scopes (function-local
  // typeBindings). Module scopes were already followed inside the
  // SCC loop above.
  for (const parsed of parsedFiles) {
    const moduleScopeId = moduleScopeByFile.get(parsed.filePath)?.id;
    for (const scope of parsed.scopes) {
      if (scope.id === moduleScopeId) continue;
      for (const [name, ref] of scope.typeBindings) {
        const resolved = followChainPostFinalize(ref, scope.id, indexes, resolveCallee);
        if (resolved !== ref) {
          (scope.typeBindings as Map<string, TypeRef>).set(name, resolved);
        }
      }
    }
  }
}
