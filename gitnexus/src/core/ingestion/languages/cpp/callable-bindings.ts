/** Ordinary unqualified callable lookup and ADL barriers owned by C++. */
import type { BindingRef, NameLookupOptions, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { lookupBindingsAt, lookupNameClaim } from '../../scope-resolution/scope/walkers.js';
import { definitionIdPosition } from '../../scope-resolution/utils/definition-id.js';

/**
 * ISO C++ `[basic.lookup.unqual]` §7: ADL is suppressed when ordinary
 * unqualified lookup finds:
 *   - a name that is NOT a function or function template, OR
 *   - a block-scope function declaration that is NOT a using-declaration.
 *
 * Combined walker that stops at the **nearest scope** where `name` has any
 * binding (callable or non-callable) and returns:
 *   - `callables`: Function/Method/Constructor defs found at that scope
 *   - `nonCallableFound`: a non-function binding was present (variable, class, etc.)
 *   - `blockScopeDeclFound`: a callable was found at a Function or Block scope
 *     (block-scope function declaration that blocks ADL)
 *
 * One pass, one stop — no divergence between callable collection and blocker
 * detection.
 */
export function findCallableBindingsAndAdlBlocker(
  startScope: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
  options?: NameLookupOptions,
): {
  callables: readonly SymbolDefinition[];
  nonCallableFound: boolean;
  blockScopeDeclFound: boolean;
} {
  // Use the same ownership and provenance selection as every other consumer.
  // Deduplicating finalized and augmented refs before selection can discard the
  // using-declaration range that proves a callable belongs to this scope.
  const claim = lookupNameClaim(startScope, name, scopes, {
    purpose: 'value',
    ...options,
    expandLocalBindings: (scope, local, indexed) =>
      (scope.kind === 'Module' || scope.kind === 'Namespace') &&
      local.every((binding) => binding.def.type === 'Function')
        ? indexed.filter(
            (binding) =>
              binding.def.type === 'Function' && binding.via?.kind === 'wildcard-expanded',
          )
        : [],
  });
  const isCallable = (binding: BindingRef): boolean =>
    binding.def.type === 'Function' ||
    binding.def.type === 'Method' ||
    binding.def.type === 'Constructor';
  const callables = new Map<string, SymbolDefinition>();
  for (const binding of normalizeIncludedCallableDeclarations(claim.bindings, scopes)) {
    if (isCallable(binding)) callables.set(binding.def.nodeId, binding.def);
  }
  // C++ constructor-form calls share the class spelling. Local class lookup
  // takes precedence over include refs, but its own constructor compatibility
  // refs still belong to that selected entity. Defaulted C++ constructors can
  // retain the parser's Function label; exact class ownership is authoritative.
  const classOwners = new Set(
    claim.bindings
      .filter(
        (binding) =>
          binding.def.type === 'Class' ||
          binding.def.type === 'Struct' ||
          binding.def.type === 'Record',
      )
      .map((binding) => binding.def.nodeId),
  );
  if (claim.status === 'resolved' && claim.scope !== undefined && classOwners.size > 0) {
    for (const { def } of lookupBindingsAt(claim.scope.id, name, scopes)) {
      if (
        (def.type === 'Constructor' || def.type === 'Method' || def.type === 'Function') &&
        def.ownerId !== undefined &&
        classOwners.has(def.ownerId)
      )
        callables.set(def.nodeId, def);
    }
  }
  return {
    callables: [...callables.values()],
    nonCallableFound:
      claim.status === 'blocked' || claim.bindings.some((binding) => !isCallable(binding)),
    // Imported functions introduced by using declarations do not suppress ADL.
    blockScopeDeclFound:
      (claim.scope?.kind === 'Function' || claim.scope?.kind === 'Block') &&
      claim.bindings.some((binding) => binding.origin === 'local' && isCallable(binding)),
  };
}

const callableDefinitionScopes = new WeakMap<
  ScopeResolutionIndexes['scopeTree'],
  {
    readonly files: ReadonlySet<string>;
    readonly anchors: ReadonlySet<string>;
  }
>();

/** Coalesce a literal-include prototype with its unique local definition. */
function normalizeIncludedCallableDeclarations(
  bindings: readonly BindingRef[],
  scopes: ScopeResolutionIndexes,
): readonly BindingRef[] {
  if (!bindings.some((binding) => binding.via?.kind === 'wildcard-expanded')) return bindings;
  let definitions = callableDefinitionScopes.get(scopes.scopeTree);
  if (definitions === undefined) {
    const files = new Set<string>();
    const anchors = new Set<string>();
    for (const scope of scopes.scopeTree.byId.values()) {
      files.add(scope.filePath);
      if (scope.kind === 'Function') {
        anchors.add(`${scope.filePath}\0${scope.range.startLine}\0${scope.range.startCol}`);
      }
    }
    definitions = { files, anchors };
    callableDefinitionScopes.set(scopes.scopeTree, definitions);
  }
  const definitionIndex = definitions;
  const hasBody = (def: SymbolDefinition): boolean => {
    const position = definitionIdPosition(def.nodeId, def.filePath);
    return (
      position !== undefined &&
      definitionIndex.anchors.has(`${def.filePath}\0${position.line}\0${position.column}`)
    );
  };
  const localBySignature = new Map<string, Set<string>>();
  for (const binding of bindings) {
    if (binding.origin !== 'local' || !hasBody(binding.def)) continue;
    const signature = callableRedeclarationSignature(binding.def);
    if (signature === undefined) continue;
    const ids = localBySignature.get(signature) ?? new Set<string>();
    ids.add(binding.def.nodeId);
    localBySignature.set(signature, ids);
  }
  return bindings.filter((binding) => {
    if (
      binding.via?.kind !== 'wildcard-expanded' ||
      !definitionIndex.files.has(binding.def.filePath) ||
      hasBody(binding.def)
    )
      return true;
    const signature = callableRedeclarationSignature(binding.def);
    return signature === undefined || localBySignature.get(signature)?.size !== 1;
  });
}

function callableRedeclarationSignature(def: SymbolDefinition): string | undefined {
  if (
    def.type !== 'Function' ||
    def.ownerId !== undefined ||
    def.qualifiedName === undefined ||
    def.parameterCount === undefined ||
    def.parameterTypes === undefined ||
    def.parameterTypes.length !== def.parameterCount ||
    def.parameterTypes.some((type) => type === '') ||
    (def.typeParameters?.length ?? 0) > 0 ||
    def.templateConstraints !== undefined
  )
    return undefined;
  return JSON.stringify([
    def.namespacePrefix ?? '',
    def.qualifiedName,
    def.parameterCount,
    def.parameterTypes,
    def.parameterTypeClasses,
  ]);
}
