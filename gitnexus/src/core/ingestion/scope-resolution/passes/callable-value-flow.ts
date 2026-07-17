/**
 * Flow-insensitive, inclusion-based resolution for calls through callable
 * values. Providers own syntax recognition; this pass consumes only the
 * JSON-safe facts carried by ParsedFile.
 */

import type {
  CallableFlowFormalSite,
  CallableFlowInvokeSite,
  CallableFlowOperand,
  CallableFlowSite,
  ParsedFile,
  ScopeId,
  SymbolDefinition,
} from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import type { CalleeIdAccumulator } from '../graph-bridge/callee-id-sink.js';
import { tryEmitEdge } from '../graph-bridge/edges.js';
import { resolveCallerGraphId, resolveDefGraphId } from '../graph-bridge/ids.js';
import { resolveInheritanceBaseInScope } from '../scope/walkers.js';
import { narrowOverloadCandidates } from './overload-narrowing.js';

export const MAX_CALLABLE_VALUE_TARGETS = 32;

interface Target {
  readonly id: string;
  readonly def: SymbolDefinition;
}

interface FileFact {
  readonly filePath: string;
  readonly site: CallableFlowSite;
}

interface FileInvoke {
  readonly filePath: string;
  readonly site: CallableFlowInvokeSite;
}

export interface CallableValueFlowWarning {
  readonly language: string;
  readonly context: string;
  readonly candidateCount: number;
  readonly cap: number;
}

export interface CallableValueFlowResult {
  readonly emitted: number;
  readonly resolvedInvokes: number;
  readonly ambiguousInvokes: number;
  readonly unmatchedInvokes: number;
  readonly iterations: number;
}

export interface EmitCallableValueFlowInput {
  readonly graph: KnowledgeGraph;
  readonly scopes: ScopeResolutionIndexes;
  readonly parsedFiles: readonly ParsedFile[];
  readonly nodeLookup: GraphNodeLookup;
  readonly calleeIds: CalleeIdAccumulator;
  readonly language: string;
  readonly collapseByCallerTarget?: boolean;
  readonly onWarn?: (warning: CallableValueFlowWarning) => void;
}

/** Position key shared with the existing free/reference skip-set contract. */
export function callableFlowSiteKey(
  filePath: string,
  range: { readonly startLine: number; readonly startCol: number },
): string {
  return `${filePath}:${range.startLine}:${range.startCol}`;
}

/**
 * Return only invoke sites that join to a canonical call ReferenceSite.
 * Malformed/stale facts never suppress ordinary resolution.
 */
export function collectDeferredIndirectSites(
  parsedFiles: readonly ParsedFile[],
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const parsed of parsedFiles) {
    const canonical = new Set(
      parsed.referenceSites
        .filter((site) => site.kind === 'call')
        .map((site) => callableFlowSiteKey(parsed.filePath, site.atRange)),
    );
    for (const site of parsed.callableFlowSites ?? []) {
      if (site.kind !== 'invoke') continue;
      const key = callableFlowSiteKey(parsed.filePath, site.callSite);
      if (canonical.has(key)) out.add(key);
    }
  }
  return out;
}

export function emitCallableValueFlow(input: EmitCallableValueFlowInput): CallableValueFlowResult {
  const facts: FileFact[] = [];
  const invokes: FileInvoke[] = [];
  const canonicalInvokeKeys = collectDeferredIndirectSites(input.parsedFiles);
  let unmatchedInvokes = 0;
  for (const parsed of input.parsedFiles) {
    for (const site of parsed.callableFlowSites ?? []) {
      if (site.kind === 'invoke') {
        const key = callableFlowSiteKey(parsed.filePath, site.callSite);
        if (canonicalInvokeKeys.has(key)) invokes.push({ filePath: parsed.filePath, site });
        else unmatchedInvokes++;
      } else {
        facts.push({ filePath: parsed.filePath, site });
      }
    }
  }
  if (facts.length === 0 && invokes.length === 0) {
    return { emitted: 0, resolvedInvokes: 0, ambiguousInvokes: 0, unmatchedInvokes, iterations: 0 };
  }

  const targetsByBinding = new Map<string, Map<string, Target>>();
  const addressesByBinding = new Map<string, Set<string>>();
  const overflowedTargets = new Set<string>();
  const overflowedAddresses = new Set<string>();
  const overflowWarnings = new Map<string, CallableValueFlowWarning>();
  const graphTargets = buildGraphTargetIndex(input.scopes, input.nodeLookup);
  const globalBySimpleName = buildGlobalCallableIndex(graphTargets.values());

  const bindingKey = (filePath: string, operand: CallableFlowOperand): string =>
    canonicalBindingKey(filePath, operand, input.scopes);

  const warnOverflow = (key: string, count: number, context: string): void => {
    if (overflowWarnings.has(key)) return;
    overflowWarnings.set(key, {
      language: input.language,
      context,
      candidateCount: count,
      cap: MAX_CALLABLE_VALUE_TARGETS,
    });
  };

  const addTarget = (key: string, target: Target, context: string): boolean => {
    if (overflowedTargets.has(key)) return false;
    let bucket = targetsByBinding.get(key);
    if (bucket === undefined) {
      bucket = new Map();
      targetsByBinding.set(key, bucket);
    }
    if (bucket.has(target.id)) return false;
    if (bucket.size + 1 > MAX_CALLABLE_VALUE_TARGETS) {
      const count = bucket.size + 1;
      bucket.clear();
      overflowedTargets.add(key);
      warnOverflow(`target:${key}`, count, context);
      return true;
    }
    bucket.set(target.id, target);
    return true;
  };

  const addAddress = (key: string, cell: string, context: string): boolean => {
    if (overflowedAddresses.has(key)) return false;
    let bucket = addressesByBinding.get(key);
    if (bucket === undefined) {
      bucket = new Set();
      addressesByBinding.set(key, bucket);
    }
    if (bucket.has(cell)) return false;
    if (bucket.size + 1 > MAX_CALLABLE_VALUE_TARGETS) {
      const count = bucket.size + 1;
      bucket.clear();
      overflowedAddresses.add(key);
      warnOverflow(`address:${key}`, count, context);
      return true;
    }
    bucket.add(cell);
    return true;
  };

  const transferTargets = (source: string, destination: string, context: string): boolean => {
    if (overflowedTargets.has(source)) {
      if (overflowedTargets.has(destination)) return false;
      targetsByBinding.get(destination)?.clear();
      overflowedTargets.add(destination);
      warnOverflow(`target:${destination}`, MAX_CALLABLE_VALUE_TARGETS + 1, context);
      return true;
    }
    let changed = false;
    for (const target of targetsByBinding.get(source)?.values() ?? []) {
      if (addTarget(destination, target, context)) changed = true;
    }
    return changed;
  };

  const transferAddresses = (source: string, destination: string, context: string): boolean => {
    if (overflowedAddresses.has(source)) {
      if (overflowedAddresses.has(destination)) return false;
      addressesByBinding.get(destination)?.clear();
      overflowedAddresses.add(destination);
      warnOverflow(`address:${destination}`, MAX_CALLABLE_VALUE_TARGETS + 1, context);
      return true;
    }
    let changed = false;
    for (const cell of addressesByBinding.get(source) ?? []) {
      if (addAddress(destination, cell, context)) changed = true;
    }
    return changed;
  };

  // Explicit seeds use lexical/qualified registries and contextual signature
  // narrowing. No arbitrary first-overload choice is permitted.
  for (const fact of facts) {
    if (fact.site.kind !== 'seed') continue;
    const destination = bindingKey(fact.filePath, fact.site.destination);
    const candidates = resolveSeedCandidates(
      fact.filePath,
      fact.site.destination.inScope,
      fact.site.targetName,
      fact.site.targetQualifiedName,
      fact.site.expectedSignature,
      input.scopes,
      graphTargets,
      globalBySimpleName,
    );
    for (const target of candidates) addTarget(destination, target, `binding:${destination}`);
  }

  // Direct callable references used as argument/copy sources acquire lexical
  // targets. A nearest non-callable binding is a hard shadowing boundary.
  for (const fact of facts) {
    const source = sourceOperand(fact.site);
    if (source === undefined) continue;
    const key = bindingKey(fact.filePath, source);
    for (const target of lexicalCallableTargets(source, input.scopes, graphTargets)) {
      addTarget(key, target, `binding:${key}`);
    }
  }

  // Address-of constraints are static and seed the abstract-cell graph.
  for (const fact of facts) {
    if (fact.site.kind !== 'address') continue;
    addAddress(
      bindingKey(fact.filePath, fact.site.destination),
      bindingKey(fact.filePath, fact.site.source),
      `address:${fact.filePath}:${fact.site.source.name}`,
    );
  }

  const formalsByGraphId = indexFormalsByGraphId(
    input.parsedFiles,
    input.scopes,
    input.nodeLookup,
    graphTargets,
  );
  const dynamicCallees = new Map<string, Map<string, Target>>();
  const dynamicOverflow = new Set<string>();
  let changed = true;
  let iterations = 0;
  const maxIterations = Math.max(16, (facts.length + invokes.length) * 4);

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    for (const fact of facts) {
      const context = `${fact.site.kind}:${fact.filePath}`;
      switch (fact.site.kind) {
        case 'copy': {
          const source = bindingKey(fact.filePath, fact.site.source);
          const destination = bindingKey(fact.filePath, fact.site.destination);
          changed = transferTargets(source, destination, context) || changed;
          changed = transferAddresses(source, destination, context) || changed;
          break;
        }
        case 'alias': {
          const source = bindingKey(fact.filePath, fact.site.source);
          const destination = bindingKey(fact.filePath, fact.site.destination);
          changed = transferTargets(source, destination, context) || changed;
          changed = transferTargets(destination, source, context) || changed;
          changed = transferAddresses(source, destination, context) || changed;
          changed = transferAddresses(destination, source, context) || changed;
          break;
        }
        case 'load': {
          const destination = bindingKey(fact.filePath, fact.site.destination);
          for (const cell of cellsForOperand(
            fact.filePath,
            fact.site.pointer,
            bindingKey,
            addressesByBinding,
          )) {
            changed = transferTargets(cell, destination, context) || changed;
            changed = transferAddresses(cell, destination, context) || changed;
          }
          break;
        }
        case 'store': {
          const sourceTargets = targetsForOperand(
            fact.filePath,
            fact.site.source,
            bindingKey,
            targetsByBinding,
            addressesByBinding,
            overflowedTargets,
            overflowedAddresses,
          );
          for (const cell of cellsForOperand(
            fact.filePath,
            fact.site.pointer,
            bindingKey,
            addressesByBinding,
          )) {
            if (sourceTargets.overflow) {
              if (!overflowedTargets.has(cell)) {
                targetsByBinding.get(cell)?.clear();
                overflowedTargets.add(cell);
                changed = true;
              }
              continue;
            }
            for (const target of sourceTargets.targets.values()) {
              changed = addTarget(cell, target, context) || changed;
            }
          }
          break;
        }
        case 'seed':
        case 'address':
        case 'formal':
        case 'argument':
        case 'invoke':
          break;
      }
    }

    dynamicCallees.clear();
    dynamicOverflow.clear();
    for (const invoke of invokes) {
      const key = callableFlowSiteKey(invoke.filePath, invoke.site.callSite);
      const targets = targetsForOperand(
        invoke.filePath,
        invoke.site.callee,
        bindingKey,
        targetsByBinding,
        addressesByBinding,
        overflowedTargets,
        overflowedAddresses,
      );
      if (targets.overflow || targets.targets.size > MAX_CALLABLE_VALUE_TARGETS) {
        dynamicOverflow.add(key);
        warnOverflow(
          `invoke:${key}`,
          Math.max(targets.targets.size, MAX_CALLABLE_VALUE_TARGETS + 1),
          `site:${key}`,
        );
        continue;
      }
      const expanded = expandMemberTargets(invoke, targets.targets, input.scopes, graphTargets);
      dynamicCallees.set(key, expanded);
    }

    // Actual → formal propagation consumes both already-resolved direct call
    // targets and targets discovered for indirect invocations this iteration.
    for (const fact of facts) {
      if (fact.site.kind !== 'argument') continue;
      const callKey = callableFlowSiteKey(fact.filePath, fact.site.callSite);
      const targetIds = new Set<string>();
      for (const id of input.calleeIds.get(fact.filePath)?.get(posKey(fact.site.callSite)) ?? []) {
        targetIds.add(id);
      }
      for (const id of dynamicCallees.get(callKey)?.keys() ?? []) targetIds.add(id);
      if (targetIds.size === 0 || dynamicOverflow.has(callKey)) continue;

      const sourceKey = bindingKey(fact.filePath, fact.site.source);
      const sourceTargets = targetsForOperand(
        fact.filePath,
        fact.site.source,
        bindingKey,
        targetsByBinding,
        addressesByBinding,
        overflowedTargets,
        overflowedAddresses,
      );
      for (const targetId of targetIds) {
        for (const formal of formalsByGraphId.get(targetId)?.get(fact.site.parameterIndex) ?? []) {
          const formalKey = bindingKey(formal.filePath, formal.site.binding);
          const context = `actual-formal:${callKey}:${fact.site.parameterIndex}`;
          if (sourceTargets.overflow) {
            if (!overflowedTargets.has(formalKey)) {
              targetsByBinding.get(formalKey)?.clear();
              overflowedTargets.add(formalKey);
              changed = true;
            }
          } else {
            for (const target of sourceTargets.targets.values()) {
              changed = addTarget(formalKey, target, context) || changed;
            }
          }
          changed = transferAddresses(sourceKey, formalKey, context) || changed;
          if (fact.site.source.addressOf) {
            changed = addAddress(formalKey, sourceKey, context) || changed;
          }
          if (formal.site.passingMode === 'reference') {
            changed = transferTargets(formalKey, sourceKey, context) || changed;
            changed = transferAddresses(formalKey, sourceKey, context) || changed;
          }
        }
      }
    }
  }

  for (const warning of overflowWarnings.values()) input.onWarn?.(warning);

  let emitted = 0;
  let resolvedInvokes = 0;
  let ambiguousInvokes = 0;
  const seen = new Set<string>();
  for (const invoke of invokes) {
    const key = callableFlowSiteKey(invoke.filePath, invoke.site.callSite);
    if (dynamicOverflow.has(key)) {
      ambiguousInvokes++;
      continue;
    }
    const targets = dynamicCallees.get(key);
    if (targets === undefined || targets.size === 0) continue;
    resolvedInvokes++;
    const confidence = targets.size === 1 ? 0.8 : 0.7;
    for (const target of targets.values()) {
      if (
        tryEmitEdge(
          input.graph,
          input.scopes,
          input.nodeLookup,
          { inScope: invoke.site.inScope, atRange: invoke.site.callSite, kind: 'call' },
          target.def,
          'callable-value-flow',
          seen,
          confidence,
          input.collapseByCallerTarget === true,
          { sink: input.calleeIds, filePath: invoke.filePath },
        )
      ) {
        emitted++;
      }
    }
  }

  return { emitted, resolvedInvokes, ambiguousInvokes, unmatchedInvokes, iterations };
}

function buildGraphTargetIndex(
  scopes: ScopeResolutionIndexes,
  nodeLookup: GraphNodeLookup,
): ReadonlyMap<string, Target> {
  const out = new Map<string, Target>();
  for (const def of scopes.defs.byId.values()) {
    if (!isCallable(def)) continue;
    const id = resolveDefGraphId(def.filePath, def, nodeLookup);
    if (id !== undefined) out.set(id, { id, def });
  }
  return out;
}

function buildGlobalCallableIndex(
  targets: Iterable<Target>,
): ReadonlyMap<string, readonly Target[]> {
  const out = new Map<string, Target[]>();
  for (const target of targets) {
    const name = simpleName(target.def.qualifiedName);
    if (name === undefined) continue;
    const bucket = out.get(name);
    if (bucket === undefined) out.set(name, [target]);
    else bucket.push(target);
  }
  return out;
}

function resolveSeedCandidates(
  filePath: string,
  inScope: ScopeId,
  targetName: string,
  targetQualifiedName: string | undefined,
  expected:
    | {
        readonly parameterCount?: number;
        readonly parameterTypes?: readonly string[];
        readonly parameterTypeClasses?: readonly import('gitnexus-shared').ParameterTypeClass[];
      }
    | undefined,
  scopes: ScopeResolutionIndexes,
  graphTargets: ReadonlyMap<string, Target>,
  globalBySimpleName: ReadonlyMap<string, readonly Target[]>,
): readonly Target[] {
  let candidates: Target[] = [];
  if (targetQualifiedName !== undefined) {
    for (const defId of scopes.qualifiedNames.get(targetQualifiedName)) {
      const def = scopes.defs.get(defId);
      if (def === undefined || !isCallable(def)) continue;
      const target = targetForDef(def, graphTargets);
      if (target !== undefined) candidates.push(target);
    }
  }
  if (candidates.length === 0) {
    candidates = lexicalCallableTargets(
      { name: targetName, inScope, atRange: zeroRange(), indirection: 0, addressOf: false },
      scopes,
      graphTargets,
    );
  }
  if (candidates.length === 0) {
    candidates = [...(globalBySimpleName.get(targetName) ?? [])];
  }
  candidates = dedupeTargets(candidates);
  if (expected !== undefined) {
    const narrowedDefs = narrowOverloadCandidates(
      candidates.map((candidate) => candidate.def),
      expected.parameterCount,
      expected.parameterTypes,
      { argumentTypeClasses: expected.parameterTypeClasses },
    );
    const allowed = new Set(narrowedDefs.map((def) => def.nodeId));
    candidates = candidates.filter((candidate) => allowed.has(candidate.def.nodeId));
  }
  if (isUnresolvedOverloadSet(candidates)) return [];
  // File-local qualified lookup should not accidentally fan out to same-name
  // defs in unrelated files when the source explicitly names a local target.
  const sameFile = candidates.filter((candidate) => candidate.def.filePath === filePath);
  return sameFile.length > 0 ? sameFile : candidates;
}

function lexicalCallableTargets(
  operand: CallableFlowOperand,
  scopes: ScopeResolutionIndexes,
  graphTargets: ReadonlyMap<string, Target>,
): Target[] {
  let current: ScopeId | null = operand.inScope;
  const visited = new Set<ScopeId>();
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const scope = scopes.scopeTree.getScope(current);
    if (scope === undefined) return [];
    const refs = nearestScopeBindings(current, operand.name, scope.bindings, scopes);
    if (refs.length > 0) {
      const out: Target[] = [];
      for (const ref of refs) {
        if (!isCallable(ref.def)) continue;
        const target = targetForDef(ref.def, graphTargets);
        if (target !== undefined) out.push(target);
      }
      return dedupeTargets(out);
    }
    current = scope.parent;
  }
  return [];
}

function nearestScopeBindings(
  scopeId: ScopeId,
  name: string,
  local: ReadonlyMap<string, readonly { readonly def: SymbolDefinition }[]>,
  scopes: ScopeResolutionIndexes,
): readonly { readonly def: SymbolDefinition }[] {
  const out: { readonly def: SymbolDefinition }[] = [];
  const seen = new Set<string>();
  const add = (refs: readonly { readonly def: SymbolDefinition }[] | undefined): void => {
    for (const ref of refs ?? []) {
      if (seen.has(ref.def.nodeId)) continue;
      seen.add(ref.def.nodeId);
      out.push(ref);
    }
  };
  add(local.get(name));
  add(scopes.bindings.get(scopeId)?.get(name));
  add(scopes.bindingAugmentations.get(scopeId)?.get(name));
  if (out.length === 0 && scopes.scopeTree.getScope(scopeId)?.kind === 'Module') {
    add(scopes.workspaceFqnBindings.get(name));
    for (const namespace of scopes.accessibleNamespacesByScope.get(scopeId) ?? []) {
      add(scopes.namespaceFqnBindings.get(namespace)?.get(name));
    }
  }
  return out;
}

function canonicalBindingKey(
  filePath: string,
  operand: CallableFlowOperand,
  scopes: ScopeResolutionIndexes,
): string {
  let current: ScopeId | null = operand.inScope;
  const visited = new Set<ScopeId>();
  let enclosingFunction: ScopeId | undefined;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const scope = scopes.scopeTree.getScope(current);
    if (scope === undefined) break;
    if (enclosingFunction === undefined && scope.kind === 'Function') enclosingFunction = current;
    if (nearestScopeBindings(current, operand.name, scope.bindings, scopes).length > 0) {
      return `${filePath}\0${current}\0${operand.name}`;
    }
    current = scope.parent;
  }
  // Some grammars emit parameter type-bindings but no declaration binding.
  // Canonicalize unresolved names to the enclosing function (not the nested
  // block occurrence) so a formal and its body uses still share one cell.
  return `${filePath}\0${enclosingFunction ?? operand.inScope}\0${operand.name}`;
}

function sourceOperand(site: CallableFlowSite): CallableFlowOperand | undefined {
  switch (site.kind) {
    case 'copy':
    case 'alias':
    case 'address':
    case 'store':
    case 'argument':
      return site.source;
    case 'load':
      return site.pointer;
    default:
      return undefined;
  }
}

function cellsForOperand(
  filePath: string,
  operand: CallableFlowOperand,
  bindingKey: (filePath: string, operand: CallableFlowOperand) => string,
  addresses: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  let cells = new Set([bindingKey(filePath, operand)]);
  for (let depth = 0; depth < operand.indirection; depth++) {
    const next = new Set<string>();
    for (const cell of cells) for (const reached of addresses.get(cell) ?? []) next.add(reached);
    cells = next;
    if (cells.size === 0) break;
  }
  return cells;
}

function targetsForOperand(
  filePath: string,
  operand: CallableFlowOperand,
  bindingKey: (filePath: string, operand: CallableFlowOperand) => string,
  targets: ReadonlyMap<string, ReadonlyMap<string, Target>>,
  addresses: ReadonlyMap<string, ReadonlySet<string>>,
  overflowedTargets: ReadonlySet<string>,
  overflowedAddresses: ReadonlySet<string>,
): { readonly targets: Map<string, Target>; readonly overflow: boolean } {
  const base = bindingKey(filePath, operand);
  if (overflowedAddresses.has(base) && operand.indirection > 0) {
    return { targets: new Map(), overflow: true };
  }
  const cells = cellsForOperand(filePath, operand, bindingKey, addresses);
  const out = new Map<string, Target>();
  for (const cell of cells) {
    if (overflowedTargets.has(cell)) return { targets: new Map(), overflow: true };
    for (const target of targets.get(cell)?.values() ?? []) {
      out.set(target.id, target);
      if (out.size > MAX_CALLABLE_VALUE_TARGETS) return { targets: new Map(), overflow: true };
    }
  }
  return { targets: out, overflow: false };
}

interface IndexedFormal {
  readonly filePath: string;
  readonly site: CallableFlowFormalSite;
}

function indexFormalsByGraphId(
  parsedFiles: readonly ParsedFile[],
  scopes: ScopeResolutionIndexes,
  nodeLookup: GraphNodeLookup,
  graphTargets: ReadonlyMap<string, Target>,
): ReadonlyMap<string, ReadonlyMap<number, readonly IndexedFormal[]>> {
  const building = new Map<string, Map<number, IndexedFormal[]>>();
  for (const parsed of parsedFiles) {
    for (const site of parsed.callableFlowSites ?? []) {
      if (site.kind !== 'formal') continue;
      const resolvedCaller = resolveCallerGraphId(
        site.binding.inScope,
        scopes,
        nodeLookup,
        site.ownerRange,
      );
      const graphIds = new Set<string>();
      if (resolvedCaller !== undefined) graphIds.add(resolvedCaller);
      // Signature-bearing graph ids can be more precise than a scope-only
      // caller lookup. Join the provider-supplied owner identity to canonical
      // defs as a fallback (important for function-reference parameters).
      for (const target of graphTargets.values()) {
        if (target.def.filePath !== parsed.filePath) continue;
        if (
          site.ownerQualifiedName !== undefined &&
          target.def.qualifiedName !== site.ownerQualifiedName
        ) {
          continue;
        }
        if (
          site.ownerQualifiedName === undefined &&
          simpleName(target.def.qualifiedName) !== site.ownerName
        ) {
          continue;
        }
        if (
          target.def.parameterCount !== undefined &&
          site.parameterIndex >= target.def.parameterCount
        ) {
          continue;
        }
        graphIds.add(target.id);
      }
      for (const graphId of graphIds) {
        let byIndex = building.get(graphId);
        if (byIndex === undefined) {
          byIndex = new Map();
          building.set(graphId, byIndex);
        }
        const bucket = byIndex.get(site.parameterIndex);
        const indexed = { filePath: parsed.filePath, site };
        if (bucket === undefined) byIndex.set(site.parameterIndex, [indexed]);
        else if (!bucket.some((entry) => entry.site.binding.inScope === site.binding.inScope)) {
          bucket.push(indexed);
        }
      }
    }
  }
  return building;
}

function expandMemberTargets(
  invoke: FileInvoke,
  targets: ReadonlyMap<string, Target>,
  scopes: ScopeResolutionIndexes,
  graphTargets: ReadonlyMap<string, Target>,
): Map<string, Target> {
  if (invoke.site.invocationKind !== 'member-pointer' || invoke.site.receiver === undefined) {
    return new Map(targets);
  }
  const typeRef = receiverType(invoke.site.receiver, scopes);
  if (typeRef === undefined) return new Map(targets);
  const receiverClass = resolveInheritanceBaseInScope(
    invoke.site.receiver.inScope,
    typeRef,
    scopes,
  );
  if (receiverClass === undefined) return new Map(targets);
  const ownerChain = [receiverClass.nodeId, ...scopes.methodDispatch.mroFor(receiverClass.nodeId)];
  const out = new Map<string, Target>();
  for (const target of targets.values()) {
    const name = simpleName(target.def.qualifiedName);
    if (name === undefined || target.def.ownerId === undefined) {
      out.set(target.id, target);
      continue;
    }
    let replacement: Target | undefined;
    for (const ownerId of ownerChain) {
      const def = [...scopes.defs.byId.values()].find(
        (candidate) =>
          candidate.ownerId === ownerId &&
          isCallable(candidate) &&
          simpleName(candidate.qualifiedName) === name,
      );
      if (def === undefined) continue;
      replacement = targetForDef(def, graphTargets);
      if (replacement !== undefined) break;
    }
    out.set((replacement ?? target).id, replacement ?? target);
  }
  return out;
}

function receiverType(
  operand: CallableFlowOperand,
  scopes: ScopeResolutionIndexes,
): string | undefined {
  let current: ScopeId | null = operand.inScope;
  const visited = new Set<ScopeId>();
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const scope = scopes.scopeTree.getScope(current);
    if (scope === undefined) return undefined;
    const hit = scope.typeBindings.get(operand.name);
    if (hit !== undefined) return hit.rawName;
    current = scope.parent;
  }
  return scopes.workspaceTypeBindings.get(operand.name)?.rawName;
}

function targetForDef(
  def: SymbolDefinition,
  targets: ReadonlyMap<string, Target>,
): Target | undefined {
  for (const target of targets.values()) if (target.def.nodeId === def.nodeId) return target;
  return undefined;
}

function isCallable(def: SymbolDefinition): boolean {
  return def.type === 'Function' || def.type === 'Method' || def.type === 'Constructor';
}

function simpleName(qualifiedName: string | undefined): string | undefined {
  if (qualifiedName === undefined || qualifiedName.length === 0) return undefined;
  const normalized = qualifiedName.replaceAll('::', '.').replaceAll('\\', '.');
  return normalized.slice(normalized.lastIndexOf('.') + 1);
}

function dedupeTargets(targets: readonly Target[]): Target[] {
  return [...new Map(targets.map((target) => [target.id, target])).values()];
}

function isUnresolvedOverloadSet(targets: readonly Target[]): boolean {
  if (targets.length <= 1) return false;
  const first = targets[0]!.def;
  return targets.every(
    (target) =>
      target.def.filePath === first.filePath &&
      target.def.qualifiedName === first.qualifiedName &&
      target.def.type === first.type,
  );
}

function posKey(range: { readonly startLine: number; readonly startCol: number }): string {
  return `${range.startLine}:${range.startCol}`;
}

function zeroRange() {
  return { startLine: 0, startCol: 0, endLine: 0, endCol: 0 } as const;
}
