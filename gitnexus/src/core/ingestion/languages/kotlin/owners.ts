import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { isClassLike, populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import { isCompanionScope } from './companion-scopes.js';

/** Module-level identity-based marker for companion-promoted Kotlin
 *  method defs (the "this member can only be dispatched through the
 *  class name" set). Parallels the C language `static-linkage.ts`
 *  side-channel pattern but uses a WeakSet because the mark is
 *  per-def (no per-name keying needed). Eliminates the cast-and-
 *  mutate pattern the previous marker implementation required,
 *  removes any serialization-survival risk surface, and keeps the
 *  Kotlin-specific metadata off the shared `SymbolDefinition` type. */
const KOTLIN_STATIC_DEFS = new WeakSet<SymbolDefinition>();

export function isKotlinStaticOnly(def: SymbolDefinition): boolean {
  return KOTLIN_STATIC_DEFS.has(def);
}

export function populateKotlinOwners(parsed: ParsedFile): void {
  populateClassOwnedMembers(parsed);
  populateCompanionMembersOnEnclosingClass(parsed);
  upgradeClassOwnedFunctionsToMethods(parsed);
}

/**
 * Align scope-resolution `def.type` with the graph's node-label
 * conventions: a `Function` def that lives inside a class body becomes
 * a `Method`. The Kotlin extractor labels every `function_declaration`
 * as `Function`, but the graph parsing-processor emits a `Method`
 * graph-node label for class members. Without this realignment,
 * `resolveDefGraphId`'s parameter-typed key lookup (gated on
 * `def.type === 'Method'`) falls through to the simple-name fallback
 * for class methods, collapsing same-name same-arity overloads onto
 * the first-registered node (#1761).
 *
 * Only Method-bearing types are touched. Methods have a class owner
 * (set by `populateClassOwnedMembers`) and a class-qualified name.
 */
function upgradeClassOwnedFunctionsToMethods(parsed: ParsedFile): void {
  for (const def of parsed.localDefs) {
    if (def.type !== 'Function') continue;
    if (def.ownerId === undefined) continue;
    (def as { type: SymbolDefinition['type'] }).type = 'Method';
  }
}

function populateCompanionMembersOnEnclosingClass(parsed: ParsedFile): void {
  const scopesById = new Map<ScopeId, ParsedFile['scopes'][number]>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Function' || scope.parent === null) continue;
    const parent = scopesById.get(scope.parent);
    if (parent === undefined || parent.kind !== 'Class') continue;
    // Identify companion-object scopes via the `@scope.companion` marker
    // capture (see captures.ts / companion-scopes.ts) rather than via
    // the old `parent.ownedDefs.some(isClassLike)` heuristic. The
    // heuristic silently bypassed two real shapes (#1756 / U4):
    //   - named companions (`companion object Helper { ... }`) — `Helper`
    //     registered as a class-like def on the companion scope; AND
    //   - companions containing nested classes (`companion object {
    //     class Token; fun create() }`) — the nested class lived on
    //     the companion scope.
    // Both bypasses left companion methods unpromoted and unmarked,
    // breaking class-name dispatch (`Outer.create()`) and crossover
    // suppression (`outer.create()`) for those shapes. The marker
    // capture lifts the distinction to the parser layer where any
    // `companion_object` AST node is a companion, full stop.
    if (!isCompanionScope(parsed.filePath, parent.id)) continue;

    const enclosing = findEnclosingClassWithDef(parent.parent, scopesById);
    if (enclosing === undefined) continue;
    for (const def of scope.ownedDefs) {
      // Class-like defs nested inside the companion's methods (rare —
      // would be a local class declared inside a fun-body) are not
      // companion members and must not be promoted. The companion's
      // direct nested classes live in their OWN scope's ownedDefs
      // (NOT the function-scope ownedDefs we iterate here), so this
      // guard is defense-in-depth.
      if (isClassLike(def.type)) continue;
      // OVERRIDE rather than skip-when-set: for named companions,
      // `populateClassOwnedMembers` already set `ownerId = Helper`
      // (the named-companion class-like def). That is the WRONG
      // owner — companion methods are dispatched through the
      // enclosing outer class, not through the companion's own
      // type name. Overwriting restores the intended ownership.
      (def as { ownerId?: string }).ownerId = enclosing.nodeId;
      // Mark as static-only so `ScopeResolver.isStaticOnly` (see
      // `isKotlinStaticOnly`) can filter these out of instance-receiver
      // dispatch (#1756). Promoting the companion method onto the
      // outer class lets `Foo.companionMethod()` resolve via Case 2;
      // without this marker, `fooInstance.companionMethod()` would
      // ALSO resolve to it via Case 4, which is incorrect (and a
      // compile error in real Kotlin).
      KOTLIN_STATIC_DEFS.add(def);
      qualify(def, enclosing);
    }
  }
}

function findEnclosingClassWithDef(
  start: ScopeId | null,
  scopesById: ReadonlyMap<ScopeId, ParsedFile['scopes'][number]>,
): SymbolDefinition | undefined {
  let current = start;
  while (current !== null) {
    const scope = scopesById.get(current);
    if (scope === undefined) return undefined;
    if (scope.kind === 'Class') {
      const classDef = scope.ownedDefs.find((def) => isClassLike(def.type));
      if (classDef !== undefined) return classDef;
    }
    current = scope.parent;
  }
  return undefined;
}

function qualify(def: SymbolDefinition, owner: SymbolDefinition): void {
  if (def.qualifiedName === undefined) return;
  if (owner.qualifiedName === undefined || owner.qualifiedName.length === 0) return;
  // For named companions, `populateClassOwnedMembers` qualified the
  // def as `Helper.create`. Strip the companion-class prefix and
  // re-qualify with the outer class so the graph-bridge lookup keys
  // resolve to `Outer.create` rather than the spurious `Helper.create`.
  // For unqualified defs (the anonymous-companion path), the simple
  // name is unchanged — `populateClassOwnedMembers` found no class-like
  // def in the anonymous companion scope, so the prior pass left the
  // simple name in place.
  const simple = def.qualifiedName.split('.').pop() ?? def.qualifiedName;
  (def as { qualifiedName: string }).qualifiedName = `${owner.qualifiedName}.${simple}`;
}
