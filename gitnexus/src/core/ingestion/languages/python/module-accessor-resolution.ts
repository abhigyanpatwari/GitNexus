import type {
  CallResultAssignmentSite,
  ParsedFile,
  Range,
  ReferenceSite,
  Scope,
  SymbolDefinition,
} from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { createNamespaceTargetCache } from '../../scope-resolution/scope/namespace-target-cache.js';
import { lookupNameClaim } from '../../scope-resolution/scope/walkers.js';
import { definitionIdPosition } from '../../scope-resolution/utils/definition-id.js';
import { pythonNamespaceBindingIdentity, pythonNamespaceReceiverPaths } from './import-target.js';
import {
  pythonModuleAccessorFact,
  pythonCallResultAssignmentIsStraightLine,
} from './module-accessors.js';
import { pythonSubtypeCallPositionalCount } from './subtype-dispatch.js';

const positionKey = (range: Pick<Range, 'startLine' | 'startCol'>): string =>
  `${range.startLine}:${range.startCol}`;

const contains = (outer: Range, inner: Range): boolean =>
  (outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startCol <= inner.startCol)) &&
  (outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endCol >= inner.endCol));

/** Namespace proof stays separate from class-return inference. No name-only
 * workspace fallback or caller-local import can establish a returned module. */
export const createPythonReceiverNamespaceResolver: NonNullable<
  ScopeResolver['createReceiverNamespaceResolver']
> = (scopes, index) => {
  const callableNamespaces = new Map<string, readonly string[] | undefined>();
  const fileScopes = new Map<string, Map<string, Scope>>();
  const namespaceCaches = new Map<string, ReturnType<typeof createNamespaceTargetCache>>();
  const assignmentIndexes = new WeakMap<
    ParsedFile,
    Map<string, Map<string, readonly CallResultAssignmentSite[]>>
  >();
  const callIndexes = new WeakMap<ParsedFile, Map<string, ReferenceSite>>();

  const namespaceOf = (candidate: SymbolDefinition): readonly string[] | undefined => {
    if (callableNamespaces.has(candidate.nodeId)) return callableNamespaces.get(candidate.nodeId);
    // A declined result is memoized as well: unsupported factories can occur at
    // thousands of call sites, but their capture proof is constant for this pass.
    callableNamespaces.set(candidate.nodeId, undefined);
    const position = definitionIdPosition(candidate.nodeId, candidate.filePath);
    if (position === undefined || candidate.type !== 'Function') return undefined;
    const fact = pythonModuleAccessorFact(candidate.filePath, position);
    if (fact?.status !== 'accepted') return undefined;
    const moduleScope = index.moduleScopeByFile.get(candidate.filePath);
    if (moduleScope === undefined) return undefined;
    let byPosition = fileScopes.get(candidate.filePath);
    if (byPosition === undefined) {
      byPosition = new Map();
      const pending = [moduleScope.id];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const scope = scopes.scopeTree.getScope(id);
        if (scope === undefined) continue;
        if (scope.kind === 'Function') byPosition.set(positionKey(scope.range), scope);
        pending.push(...scopes.scopeTree.getChildren(id));
      }
      fileScopes.set(candidate.filePath, byPosition);
    }
    const functionScope = byPosition.get(`${position.line}:${position.column}`);
    if (functionScope === undefined) return undefined;
    let cache = namespaceCaches.get(candidate.filePath);
    if (cache === undefined) {
      cache = createNamespaceTargetCache(
        { moduleScope: moduleScope.id, scopes: [] },
        scopes,
        {
          receiverPaths: pythonNamespaceReceiverPaths,
          bindingIdentity: pythonNamespaceBindingIdentity,
          skipEnclosingClasses: true,
          moduleFileExists: (filePath) => index.moduleScopeByFile.has(filePath),
        },
        true,
      );
      namespaceCaches.set(candidate.filePath, cache);
    }
    const targets = cache
      .at(functionScope.id, {
        startLine: fact.returnLine,
        startCol: fact.returnColumn,
      })
      .get(fact.returnedName);
    // Multiple module identities are not a union proof of a deterministic
    // accessor. Keep uncertainty instead of guessing an arbitrary first target.
    if (targets?.length !== 1) return undefined;
    callableNamespaces.set(candidate.nodeId, targets);
    return targets;
  };

  const freeCallAt = (parsed: ParsedFile, range: Range): ReferenceSite | undefined => {
    let calls = callIndexes.get(parsed);
    if (calls === undefined) {
      calls = new Map(
        parsed.referenceSites
          .filter((site) => site.kind === 'call' && site.explicitReceiver === undefined)
          .map((site) => [positionKey(site.atRange), site]),
      );
      callIndexes.set(parsed, calls);
    }
    return calls.get(positionKey(range));
  };

  const assignedCall = (
    site: ReferenceSite,
    parsed: ParsedFile,
    name: string,
  ): ReferenceSite | undefined => {
    let assignments = assignmentIndexes.get(parsed);
    if (assignments === undefined) {
      const grouped = new Map<string, Map<string, CallResultAssignmentSite[]>>();
      for (const assignment of parsed.callResultAssignmentSites ?? []) {
        let byScope = grouped.get(assignment.lhs);
        if (byScope === undefined) {
          byScope = new Map();
          grouped.set(assignment.lhs, byScope);
        }
        const bucket = byScope.get(assignment.inScope);
        if (bucket === undefined) byScope.set(assignment.inScope, [assignment]);
        else bucket.push(assignment);
      }
      assignments = grouped;
      assignmentIndexes.set(parsed, assignments);
    }
    const byScope = assignments.get(name);
    if (byScope === undefined) return undefined;
    const claim = lookupNameClaim(site.inScope, name, scopes, {
      position: site.atRange,
      purpose: 'value',
      skipEnclosingClasses: true,
    });
    if (
      claim.status !== 'resolved' ||
      claim.claims.length !== 1 ||
      claim.claims[0]!.kind !== 'binding' ||
      claim.scope === undefined
    )
      return undefined;
    const candidates = byScope.get(claim.scope.id);
    if (candidates === undefined) return undefined;
    const owned = candidates.filter((assignment) =>
      contains(claim.claims[0]!.range, assignment.callSite),
    );
    return owned.length === 1 ? freeCallAt(parsed, owned[0]!.callSite) : undefined;
  };

  return (site, parsed) => {
    if (site.kind !== 'call') return undefined;
    const receiverName = site.explicitReceiver?.name;
    if (receiverName === undefined) return undefined;
    const direct = /^([\p{ID_Start}_][\p{ID_Continue}]*)\s*\(\s*\)$/u.exec(receiverName);
    const call =
      direct !== null ? freeCallAt(parsed, site.atRange) : assignedCall(site, parsed, receiverName);
    if (call === undefined || (direct !== null && call.name !== direct[1])) return undefined;
    const callResultOrigin = { name: call.name, inScope: call.inScope };
    // Textual claim order cannot prove which control-flow branch assigned this
    // receiver. Keep the attempted call, but do not treat its origin as definite.
    if (
      direct === null &&
      !pythonCallResultAssignmentIsStraightLine(parsed.filePath, call.atRange)
    ) {
      return { callResultOrigin: { ...callResultOrigin, isDefinite: false } };
    }
    const declined = { callResultOrigin };
    if (pythonSubtypeCallPositionalCount(parsed.filePath, call.atRange) !== 0) return declined;
    const claim = lookupNameClaim(call.inScope, call.name, scopes, {
      position: call.atRange,
      purpose: 'value',
      skipEnclosingClasses: true,
    });
    if (claim.status !== 'resolved') return declined;
    const candidates = new Map(claim.bindings.map((binding) => [binding.def.nodeId, binding.def]));
    if (candidates.size !== 1) return declined;
    const candidate = candidates.values().next().value!;
    return { callResultOrigin, targetFiles: namespaceOf(candidate) };
  };
};
