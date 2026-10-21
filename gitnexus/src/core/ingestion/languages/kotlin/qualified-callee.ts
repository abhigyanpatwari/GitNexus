/**
 * Kotlin package-qualified callee resolution (#3498 follow-up).
 *
 * `val x = com.acme.mod.make(); x.m()` and the inline `kqfmod.make().m()` call a
 * top-level function through its package path. Kotlin imports declarations, not
 * packages, so no import edge or binding names `kqfmod` or `com`: the only
 * evidence is the package header each file declares. This answers
 * `ScopeResolver.resolveQualifiedCallee` from those facts:
 *
 *   1. The text is a dotted path of plain names. Everything before the last
 *      segment is the package, written in full — Kotlin has no relative package
 *      references.
 *   2. The files declaring that package declare exactly one top-level function
 *      of that name. A package spans files, so the candidates are gathered from
 *      all of them; an overload or a same-named function in a second file is
 *      ambiguous and refused, since the callee text carries no arguments.
 *   3. The head names nothing the call site can see. Kotlin resolves a name to a
 *      local, parameter, member, import, same-package or star-imported
 *      declaration before it considers a package, so a value or type called
 *      `kqfmod` keeps `kqfmod.make()` a member call on that value.
 *
 * Refusal is cheap: a regex and two map lookups run before any scope walk, and
 * the index is built once per resolution pass.
 */

import type { Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../../scope-resolution/workspace-index.js';
import { lookupNameClaim } from '../../scope-resolution/scope/walkers.js';
import { getKotlinPackageFact } from './package-facts.js';

/** Two or more plain names joined by `.` (`kqfmod.make`, `com.acme.mod.make`). */
const KOTLIN_DOTTED_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

interface KotlinPackageDeclarations {
  /** Declared package → top-level function name → that name's functions, across
   *  every file declaring the package. The root package is keyed `''`, which no
   *  dotted path's qualifier can be. */
  readonly functions: ReadonlyMap<string, ReadonlyMap<string, readonly SymbolDefinition[]>>;
  /** Declared package → every top-level name its files declare, of any kind. */
  readonly names: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Keyed on the pass's workspace index, like Rust's `passIndexFor`: the builder
 * reads the package facts and module scopes of the same pass, which
 * `perFileSet`'s key-only builder cannot hand it. A new pass is a new key, and
 * the WeakMap entry goes with it.
 */
const PACKAGE_DECLARATIONS = new WeakMap<WorkspaceResolutionIndex, KotlinPackageDeclarations>();

function packageDeclarationsFor(
  workspaceIndex: WorkspaceResolutionIndex,
): KotlinPackageDeclarations {
  const cached = PACKAGE_DECLARATIONS.get(workspaceIndex);
  if (cached !== undefined) return cached;
  const functions = new Map<string, Map<string, SymbolDefinition[]>>();
  const names = new Map<string, Set<string>>();
  for (const [filePath, moduleScope] of workspaceIndex.moduleScopeByFile) {
    const fact = getKotlinPackageFact(filePath);
    if (fact?.status !== 'known') continue;
    let packageNames = names.get(fact.packageName);
    if (packageNames === undefined) {
      packageNames = new Set();
      names.set(fact.packageName, packageNames);
    }
    let packageFunctions = functions.get(fact.packageName);
    if (packageFunctions === undefined) {
      packageFunctions = new Map();
      functions.set(fact.packageName, packageFunctions);
    }
    for (const [name, refs] of moduleScope.bindings) {
      for (const ref of refs) {
        if (ref.origin !== 'local' || ref.def.filePath !== filePath) continue;
        packageNames.add(name);
        if (ref.def.type !== 'Function') continue;
        const defs = packageFunctions.get(name);
        if (defs === undefined) packageFunctions.set(name, [ref.def]);
        else if (!defs.some((def) => def.nodeId === ref.def.nodeId)) defs.push(ref.def);
      }
    }
  }
  const index: KotlinPackageDeclarations = { functions, names };
  PACKAGE_DECLARATIONS.set(workspaceIndex, index);
  return index;
}

/**
 * `ScopeResolver.resolveQualifiedCallee`: the top-level function a package path
 * names (`kqfmod.make` in `val x = kqfmod.make()` or `kqfmod.make().m()`), or
 * `undefined` when the text is not such a path, the package declares no unique
 * function of that name, or the head is a name the call site can see.
 */
export function resolveKotlinQualifiedCallee(
  calleeText: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
): SymbolDefinition | undefined {
  if (!KOTLIN_DOTTED_PATH_RE.test(calleeText)) return undefined;
  const lastDot = calleeText.lastIndexOf('.');
  const index = packageDeclarationsFor(workspaceIndex);
  const candidates = index.functions
    .get(calleeText.slice(0, lastDot))
    ?.get(calleeText.slice(lastDot + 1));
  if (candidates?.length !== 1) return undefined;
  const head = calleeText.slice(0, calleeText.indexOf('.'));
  if (lookupNameClaim(inScope, head, scopes, { purpose: 'value' }).status !== 'absent') {
    return undefined;
  }
  const filePath = scopes.scopeTree.getScope(inScope)?.filePath;
  const moduleScope =
    filePath === undefined ? undefined : workspaceIndex.moduleScopeByFile.get(filePath);
  if (filePath === undefined || moduleScope === undefined) return undefined;
  if (declaredOutsideClaims(head, filePath, moduleScope, scopes, index)) return undefined;
  return candidates[0];
}

/**
 * Top-level names Kotlin resolves before a package that the lexical claim walk
 * does not see: declarations in sibling files of the caller's own package
 * (sibling injection carries class-likes only) and in every package the caller
 * star-imports (a wildcard publishes no top-level property). A caller whose own
 * package is unreadable could be seeing anything, so it counts as declared.
 */
function declaredOutsideClaims(
  head: string,
  filePath: string,
  moduleScope: Scope,
  scopes: ScopeResolutionIndexes,
  index: KotlinPackageDeclarations,
): boolean {
  const own = getKotlinPackageFact(filePath);
  if (own?.status !== 'known' || index.names.get(own.packageName)?.has(head) === true) return true;
  for (const edge of scopes.imports?.get(moduleScope.id) ?? moduleScope.imports) {
    if (edge.kind !== 'wildcard-expanded' || edge.targetModuleScope === undefined) continue;
    const targetFile = scopes.scopeTree.getScope(edge.targetModuleScope)?.filePath;
    const target = targetFile === undefined ? undefined : getKotlinPackageFact(targetFile);
    if (target?.status === 'known' && index.names.get(target.packageName)?.has(head) === true) {
      return true;
    }
  }
  return false;
}
