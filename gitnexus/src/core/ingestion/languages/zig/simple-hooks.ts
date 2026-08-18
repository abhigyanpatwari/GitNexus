import type {
  BindingRef,
  Callsite,
  CaptureMatch,
  ParsedFile,
  Scope,
  ScopeId,
  ScopeTree,
  SymbolDefinition,
  TypeRef,
} from 'gitnexus-shared';

/** Keep parameter (incl. `self`) typeBindings in the function scope —
 *  hoisting them to Module would pollute other functions' receiver
 *  resolution (same rationale as `goBindingScopeFor`). */
export function zigBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  if (decl['@type-binding.parameter'] !== undefined) {
    return innermost.id;
  }
  // A container returned by a generic type constructor (`fn List(comptime T:
  // type) type { return struct {…}; }`) is anchored on the container node,
  // whose innermost enclosing scope is the FUNCTION BODY. Its name is only
  // useful to callers (`List(u8){}`, `List(u8).init()`), so bind it in the
  // module scope beside the Function def of the same name — `List` really is
  // both a callable and a type. `zigTypeConstructorOf` in the walker decides
  // WHICH containers get this rule; the marker capture carries the verdict.
  if (decl['@declaration.type-constructor'] !== undefined) {
    let scope: Scope | undefined = innermost;
    while (scope !== undefined && scope.kind !== 'Module') scope = tree.getParent(scope.id);
    return scope?.id ?? null;
  }
  // File-struct members: the file's Class scope spans the whole file (same
  // range as the Module scope, nested under it). Their DEFS stay owned by the
  // Class scope (that is what makes them methods/fields of the file's Struct),
  // but their NAMES must stay visible at module level — `Page.init()` from
  // another file is a namespace-member lookup over the module scope's
  // bindings, and `usingnamespace` expansion reads the same. Hoist every
  // declaration binding hosted by an equal-range Class scope to its Module
  // parent. Type bindings (`@type-binding.*`, incl. field types) are NOT
  // hoisted: the compound resolver reads member types from the class scope.
  const anchor = ZIG_DECLARATION_ANCHORS.map((k) => decl[k]).find((c) => c !== undefined);
  if (anchor !== undefined) {
    // Reproduce the extractor's auto-hoist (a scope-creating declaration is
    // bound in the scope OUTSIDE its own body), then step past the file's
    // Class scope when that is where the name would land.
    let host: Scope | undefined = innermost;
    if (host.parent !== null && sameRange(anchor.range, host.range)) {
      host = tree.getParent(host.id);
    }
    if (host !== undefined && host.kind === 'Class' && host.parent !== null) {
      const parent = tree.getParent(host.id);
      if (parent !== undefined && parent.kind === 'Module' && sameRange(parent.range, host.range)) {
        return parent.id;
      }
    }
  }
  return null; // default auto-hoist for other bindings
}

const ZIG_DECLARATION_ANCHORS = [
  '@declaration.function',
  '@declaration.method',
  '@declaration.struct',
  '@declaration.enum',
  '@declaration.union',
  '@declaration.field',
  '@declaration.variable',
] as const;

function sameRange(a: Scope['range'], b: Scope['range']): boolean {
  return (
    a.startLine === b.startLine &&
    a.startCol === b.startCol &&
    a.endLine === b.endLine &&
    a.endCol === b.endCol
  );
}

/** `pub usingnamespace @import("x.zig");` — every declaration of the target
 *  module becomes a declaration of the importer. Enumerates the target's
 *  module-level names for the finalize wildcard expansion (Dart pattern).
 *  Zig visibility (`pub`) is not recorded on scope-side defs, so this
 *  over-approximates to every top-level name; the structure phase's
 *  `isExported` is the authoritative visibility. */
export function expandZigWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = parsedFiles.find((p) => p.moduleScope === targetModuleScope);
  if (target === undefined) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const def of target.localDefs) {
    const qn = def.qualifiedName;
    if (qn === undefined || qn.length === 0 || qn.includes('.')) continue; // top-level only
    if (seen.has(qn)) continue;
    seen.add(qn);
    names.push(qn);
  }
  return names;
}

/** Zig's receiver convention is a FIRST parameter named `self`; the
 *  `self`-sourced typeBinding on the function scope carries its type.
 *  Position is enforced upstream, not here: `interpretZigTypeBinding` only
 *  sources a binding as `self` when `emitZigScopeCaptures` tagged it
 *  `@type-binding.first-parameter`, so a later parameter named `self`
 *  arrives as `parameter-annotation` and is never returned by this hook. */
export function zigReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  for (const binding of functionScope.typeBindings.values()) {
    if (binding.source === 'self') return binding;
  }
  return null;
}

const TIER: Record<BindingRef['origin'], number> = {
  local: 0,
  namespace: 1,
  import: 2,
  reexport: 3,
  wildcard: 4,
};

/** Local declarations shadow imports; deterministic order within a tier. */
export function zigMergeBindings(
  existing: readonly BindingRef[],
  incoming: readonly BindingRef[],
  _scopeId: string,
): BindingRef[] {
  const seen = new Set<string>();
  return [...existing, ...incoming]
    .sort(
      (a, b) =>
        (TIER[a.origin] ?? 99) - (TIER[b.origin] ?? 99) || a.def.nodeId.localeCompare(b.def.nodeId),
    )
    .filter((binding) => {
      if (seen.has(binding.def.nodeId)) return false;
      seen.add(binding.def.nodeId);
      return true;
    });
}

/** Zig has no overloading; without synthesized arity metadata on
 *  declarations the comparison is always 'unknown' — kept as a real
 *  bounds check so it turns on if arity captures are added later. */
export function zigArityCompatibility(
  callsite: Callsite,
  def: SymbolDefinition,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';
  if (!Number.isFinite(callsite.arity) || callsite.arity < 0) return 'unknown';
  if (min !== undefined && callsite.arity < min) return 'incompatible';
  if (max !== undefined && callsite.arity > max) return 'incompatible';
  return 'compatible';
}
