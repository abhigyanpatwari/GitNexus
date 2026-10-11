import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { walkNamedTree } from '../../utils/ast-helpers.js';
import { assertCloneable } from '../../workers/clone-safety.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { lookupNameClaim } from '../../scope-resolution/scope/walkers.js';
import { narrowOverloadCandidates } from '../../scope-resolution/passes/overload-narrowing.js';
import { definitionIdPosition } from '../../scope-resolution/utils/definition-id.js';

interface RubyDispatchFacts {
  readonly kind: 'ruby';
  readonly methods: ReadonlyArray<{
    readonly line: number;
    readonly column: number;
    readonly singleton: boolean;
  }>;
}

const factsByFile = new Map<string, RubyDispatchFacts>();
const singletonAncestors = new Map<string, Array<{ ownerId: string; singleton: boolean }>>();

export function clearRubyMemberDispatch(): void {
  factsByFile.clear();
  singletonAncestors.clear();
}

/** Singleton inheritance uses class ancestors and the instance methods of extended modules. */
export function configureRubySingletonAncestors(
  classAncestors: ReadonlyMap<string, readonly string[]>,
  extendedModules: ReadonlyMap<string, readonly string[]>,
  instanceAncestors: ReadonlyMap<string, readonly string[]>,
): void {
  singletonAncestors.clear();
  for (const ownerId of new Set([...classAncestors.keys(), ...extendedModules.keys()])) {
    const ancestors: Array<{ ownerId: string; singleton: boolean }> = [];
    for (const classId of [ownerId, ...(classAncestors.get(ownerId) ?? [])]) {
      ancestors.push({ ownerId: classId, singleton: true });
      for (const moduleId of [...(extendedModules.get(classId) ?? [])].reverse())
        for (const id of [moduleId, ...(instanceAncestors.get(moduleId) ?? [])])
          ancestors.push({ ownerId: id, singleton: false });
    }
    singletonAncestors.set(ownerId, ancestors);
  }
}

/** Only plain declaration facts cross the worker boundary. */
export function recordRubyMemberDispatch(root: SyntaxNode, filePath: string): void {
  const methods: Array<{ line: number; column: number; singleton: boolean }> = [];
  walkNamedTree(root, (node) => {
    if (node.type !== 'method' && node.type !== 'singleton_method') return;
    let singleton = node.type === 'singleton_method';
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        parent.type === 'class' ||
        parent.type === 'module' ||
        parent.type === 'method' ||
        parent.type === 'singleton_method'
      )
        break;
      if (parent.type === 'singleton_class') {
        singleton = true;
        break;
      }
    }
    methods.push({
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
      singleton,
    });
  });
  factsByFile.set(filePath, { kind: 'ruby', methods });
}

export function collectRubyMemberDispatch(filePath: string): RubyDispatchFacts | undefined {
  return assertCloneable(factsByFile.get(filePath));
}

export function applyRubyMemberDispatch(parsed: ParsedFile): void {
  const facts = parsed.captureSideChannel as RubyDispatchFacts | undefined;
  if (facts?.kind === 'ruby') factsByFile.set(parsed.filePath, facts);
}

export function isRubySingleton(definition: SymbolDefinition): boolean | undefined {
  const position = definitionIdPosition(definition.nodeId, definition.filePath);
  return (
    position &&
    factsByFile
      .get(definition.filePath)
      ?.methods.find((entry) => entry.line === position.line && entry.column === position.column)
      ?.singleton
  );
}

export const resolveRubyReceiverMember: NonNullable<ScopeResolver['resolveReceiverMember']> = (
  owner,
  name,
  site,
  indexes,
  model,
) => {
  if (site.kind !== 'call' || !site.explicitReceiver) return undefined;
  const receiver = site.explicitReceiver.name;
  let singleton = false;
  if (receiver === 'self') {
    for (
      let scope = indexes.scopeTree.getScope(site.inScope);
      scope;
      scope = scope.parent ? indexes.scopeTree.getScope(scope.parent) : undefined
    ) {
      const method = scope.ownedDefs.find(
        (def) => def.type === 'Method' || def.type === 'Function',
      );
      if (method) {
        singleton = isRubySingleton(method) === true;
        break;
      }
      if (scope.kind === 'Class') {
        singleton = true;
        break;
      }
    }
  } else {
    singleton = lookupNameClaim(site.inScope, receiver, indexes, {
      position: site.atRange,
      purpose: 'value',
    }).bindings.some((binding) => binding.def.nodeId === owner.nodeId);
  }
  const ancestors = singleton
    ? (singletonAncestors.get(owner.nodeId) ?? [{ ownerId: owner.nodeId, singleton: true }])
    : [owner.nodeId, ...indexes.methodDispatch.mroFor(owner.nodeId)].map((ownerId) => ({
        ownerId,
        singleton: false,
      }));
  for (const ancestor of ancestors) {
    const candidates = model.methods
      .lookupAllByOwner(ancestor.ownerId, name)
      .filter((def) => isRubySingleton(def) === ancestor.singleton);
    if (!candidates.length) continue;
    const compatible = narrowOverloadCandidates(candidates, site.arity, site.argumentTypes);
    return compatible.length === 1
      ? { kind: 'resolved', definition: compatible[0]! }
      : { kind: 'ambiguous', candidateIds: compatible.map((def) => def.nodeId) };
  }
  return { kind: 'ambiguous', candidateIds: [] };
};
