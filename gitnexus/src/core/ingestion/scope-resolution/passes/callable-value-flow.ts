/**
 * Flow-insensitive, inclusion-based resolution for calls through callable
 * values. Providers own syntax recognition; this pass consumes only the
 * JSON-safe facts carried by ParsedFile.
 */

import type {
  CallableFlowExpectedSignature,
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
import { tryEmitEdgeWithExplicitTargetId } from '../graph-bridge/edges.js';
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
  readonly isCallableValueTarget?: (def: SymbolDefinition) => boolean;
  readonly hasFileLocalCallableLinkage?: (def: SymbolDefinition) => boolean;
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
  scopes?: ScopeResolutionIndexes,
): ReadonlySet<string> {
  const out = new Set<string>();
  const flowCells = new Set<string>();
  if (scopes !== undefined) {
    for (const parsed of parsedFiles) {
      for (const site of parsed.callableFlowSites ?? []) {
        const operand = flowCellOperand(site);
        if (operand !== undefined) {
          flowCells.add(canonicalBindingKey(parsed.filePath, operand, scopes));
        }
      }
    }
  }
  for (const parsed of parsedFiles) {
    const canonical = new Set(
      parsed.referenceSites
        .filter((site) => site.kind === 'call')
        .map((site) => callableFlowSiteKey(parsed.filePath, site.atRange)),
    );
    for (const site of parsed.callableFlowSites ?? []) {
      if (site.kind !== 'invoke') continue;
      const key = callableFlowSiteKey(parsed.filePath, site.callSite);
      if (!canonical.has(key)) continue;
      if (
        scopes === undefined ||
        site.invocationKind === 'member-pointer' ||
        site.callee.indirection > 0 ||
        flowCells.has(canonicalBindingKey(parsed.filePath, site.callee, scopes))
      ) {
        out.add(key);
      }
    }
  }
  return out;
}

function flowCellOperand(site: CallableFlowSite): CallableFlowOperand | undefined {
  switch (site.kind) {
    case 'seed':
    case 'copy':
    case 'alias':
    case 'address':
    case 'load':
      return site.destination;
    case 'store':
      return site.pointer;
    case 'formal':
      return site.binding;
    case 'argument':
    case 'invoke':
      return undefined;
  }
}

export function emitCallableValueFlow(input: EmitCallableValueFlowInput): CallableValueFlowResult {
  const facts: FileFact[] = [];
  const invokes: FileInvoke[] = [];
  const canonicalInvokeKeys = collectDeferredIndirectSites(input.parsedFiles, input.scopes);
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
  const rawGraphTargets = buildGraphTargetIndex(
    input.scopes,
    input.nodeLookup,
    input.isCallableValueTarget,
    input.graph,
  );
  const rawTargetIndexes = buildCallableTargetIndexes(rawGraphTargets.values(), input.scopes);
  const { targets: graphTargets, aliasesByTargetId } = canonicalizeCallableDeclarations(
    rawGraphTargets,
    rawTargetIndexes,
    input.scopes,
    input.graph,
    input.hasFileLocalCallableLinkage,
  );
  const uniqueGraphTargets = dedupeTargets([...graphTargets.values()]);
  const globalBySimpleName = buildGlobalCallableIndex(uniqueGraphTargets);
  const targetIndexes = buildCallableTargetIndexes(uniqueGraphTargets, input.scopes);

  const bindingKey = (filePath: string, operand: CallableFlowOperand): string =>
    canonicalBindingKey(filePath, operand, input.scopes);
  // Lexical binding lookup is suppressed ONLY for cells bound by formal
  // facts: a parameter whose grammar emits no declaration binding must not
  // adopt a same-named outer function. Value cells (copy/alias/store/load
  // destinations) keep their declaration in the inclusion union — reassigning
  // a declared function through its own name (`greet = other; greet()`) must
  // still count the declaration as a target, or an unresolvable RHS yields
  // zero CALLS for a call that resolved pre-flow (#2522 review finding 8).
  const formalConstrainedBindings = new Set<string>();
  for (const fact of facts) {
    if (fact.site.kind === 'formal') {
      formalConstrainedBindings.add(bindingKey(fact.filePath, fact.site.binding));
    }
  }

  const warnOverflow = (
    key: string,
    count: number,
    context: string,
    cap = MAX_CALLABLE_VALUE_TARGETS,
  ): void => {
    if (overflowWarnings.has(key)) return;
    overflowWarnings.set(key, {
      language: input.language,
      context,
      candidateCount: count,
      cap,
    });
  };

  // Dependency-indexed worklist. Each constraint records the target/address
  // cells it reads; only consumers of a changed cell are re-enqueued. This is
  // the finite inclusion worklist promised by the plan and avoids rescanning
  // every fact for every hop in a reverse-ordered copy chain.
  const workItems: Array<() => void> = [];
  const watchers = new Map<string, Set<number>>();
  const queue: number[] = [];
  const queued = new Set<number>();
  let activeWorkItem: number | undefined;
  const dependencyKey = (kind: 'target' | 'address' | 'call', key: string): string =>
    `${kind}\0${key}`;
  const watch = (kind: 'target' | 'address' | 'call', key: string): void => {
    if (activeWorkItem === undefined) return;
    const dependency = dependencyKey(kind, key);
    let bucket = watchers.get(dependency);
    if (bucket === undefined) {
      bucket = new Set();
      watchers.set(dependency, bucket);
    }
    bucket.add(activeWorkItem);
  };
  const schedule = (id: number): void => {
    if (queued.has(id)) return;
    queued.add(id);
    queue.push(id);
  };
  const notify = (kind: 'target' | 'address' | 'call', key: string): void => {
    for (const id of watchers.get(dependencyKey(kind, key)) ?? []) schedule(id);
  };
  const addWorkItem = (run: () => void): void => {
    const id = workItems.length;
    workItems.push(run);
    schedule(id);
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
      notify('target', key);
      return true;
    }
    bucket.set(target.id, target);
    notify('target', key);
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
      notify('address', key);
      return true;
    }
    bucket.add(cell);
    notify('address', key);
    return true;
  };

  const markTargetOverflow = (key: string, context: string): boolean => {
    if (overflowedTargets.has(key)) return false;
    targetsByBinding.get(key)?.clear();
    overflowedTargets.add(key);
    warnOverflow(`target:${key}`, MAX_CALLABLE_VALUE_TARGETS + 1, context);
    notify('target', key);
    return true;
  };

  const markAddressOverflow = (key: string, context: string): boolean => {
    if (overflowedAddresses.has(key)) return false;
    addressesByBinding.get(key)?.clear();
    overflowedAddresses.add(key);
    warnOverflow(`address:${key}`, MAX_CALLABLE_VALUE_TARGETS + 1, context);
    notify('address', key);
    return true;
  };

  const readTargets = (
    key: string,
  ): { readonly targets: ReadonlyMap<string, Target>; readonly overflow: boolean } => {
    watch('target', key);
    return {
      targets: targetsByBinding.get(key) ?? new Map(),
      overflow: overflowedTargets.has(key),
    };
  };

  const readAddresses = (
    key: string,
  ): { readonly cells: ReadonlySet<string>; readonly overflow: boolean } => {
    watch('address', key);
    return {
      cells: addressesByBinding.get(key) ?? new Set(),
      overflow: overflowedAddresses.has(key),
    };
  };

  const transferTargets = (source: string, destination: string, context: string): boolean => {
    const sourceTargets = readTargets(source);
    if (sourceTargets.overflow) return markTargetOverflow(destination, context);
    let changed = false;
    for (const target of sourceTargets.targets.values()) {
      if (addTarget(destination, target, context)) changed = true;
    }
    return changed;
  };

  const transferAddresses = (source: string, destination: string, context: string): boolean => {
    const sourceAddresses = readAddresses(source);
    if (sourceAddresses.overflow) return markAddressOverflow(destination, context);
    let changed = false;
    for (const cell of sourceAddresses.cells) {
      if (addAddress(destination, cell, context)) changed = true;
    }
    return changed;
  };

  const reachedCells = (
    filePath: string,
    operand: CallableFlowOperand,
  ): { readonly layers: readonly ReadonlySet<string>[]; readonly overflow: boolean } => {
    const layers: ReadonlySet<string>[] = [new Set([bindingKey(filePath, operand)])];
    let current = layers[0]!;
    for (let depth = 0; depth < operand.indirection; depth++) {
      const next = new Set<string>();
      for (const cell of current) {
        const addresses = readAddresses(cell);
        if (addresses.overflow) return { layers, overflow: true };
        for (const reached of addresses.cells) next.add(reached);
      }
      layers.push(next);
      current = next;
      if (current.size === 0) break;
    }
    return { layers, overflow: false };
  };

  const operandTargets = (
    filePath: string,
    operand: CallableFlowOperand,
  ): { readonly targets: Map<string, Target>; readonly overflow: boolean } => {
    const reached = reachedCells(filePath, operand);
    if (reached.overflow) return { targets: new Map(), overflow: true };
    const out = new Map<string, Target>();
    // A function-pointer binding already denotes its pointee. Explicit `*`
    // may therefore terminate at any prefix, while pointer-to-pointer cells
    // continue through address edges. This models fp(), (*fp)(), and (**pp)
    // without treating the final function-designator dereference as a cell hop.
    for (const layer of reached.layers) {
      for (const cell of layer) {
        const candidates = readTargets(cell);
        if (candidates.overflow) return { targets: new Map(), overflow: true };
        for (const target of candidates.targets.values()) {
          out.set(target.id, target);
          if (out.size > MAX_CALLABLE_VALUE_TARGETS) {
            return { targets: new Map(), overflow: true };
          }
        }
      }
    }
    return { targets: out, overflow: false };
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
      targetIndexes,
      input.graph,
    );
    for (const target of candidates) addTarget(destination, target, `binding:${destination}`);
  }

  // Direct callable references used as argument/copy sources acquire lexical
  // targets. A nearest non-callable binding is a hard shadowing boundary.
  for (const fact of facts) {
    const source = sourceOperand(fact.site);
    if (source === undefined) continue;
    const key = bindingKey(fact.filePath, source);
    for (const target of resolveOperandCandidates(
      fact.filePath,
      source,
      undefined,
      input.scopes,
      graphTargets,
      globalBySimpleName,
      targetIndexes,
      input.graph,
      !formalConstrainedBindings.has(key),
    )) {
      addTarget(key, target, `binding:${key}`);
    }
  }

  // Explicitly dereferenced named functions (`(*target)()`) have no source
  // fact of their own; seed their canonical binding from lexical lookup.
  for (const invoke of invokes) {
    const key = bindingKey(invoke.filePath, invoke.site.callee);
    for (const target of resolveOperandCandidates(
      invoke.filePath,
      invoke.site.callee,
      undefined,
      input.scopes,
      graphTargets,
      globalBySimpleName,
      targetIndexes,
      input.graph,
      !formalConstrainedBindings.has(key),
    )) {
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
    targetIndexes,
    aliasesByTargetId,
  );
  const callSignaturesBySite = indexCallSignatures(input.parsedFiles);
  const dynamicCallees = new Map<string, Map<string, Target>>();
  const dynamicOverflow = new Set<string>();
  const dynamicTargetHistory = new Map<string, Set<string>>();

  for (const fact of facts) {
    const site = fact.site;
    const context = `${fact.site.kind}:${fact.filePath}`;
    switch (site.kind) {
      case 'copy':
      case 'alias': {
        addWorkItem(() => {
          const source = bindingKey(fact.filePath, site.source);
          const destination = bindingKey(fact.filePath, site.destination);
          transferTargets(source, destination, context);
          transferAddresses(source, destination, context);
          if (site.kind === 'alias') {
            transferTargets(destination, source, context);
            transferAddresses(destination, source, context);
          }
        });
        break;
      }
      case 'load': {
        addWorkItem(() => {
          const destination = bindingKey(fact.filePath, site.destination);
          const reached = reachedCells(fact.filePath, site.pointer);
          if (reached.overflow) {
            markTargetOverflow(destination, context);
            markAddressOverflow(destination, context);
            return;
          }
          for (const cell of reached.layers.at(-1) ?? []) {
            transferTargets(cell, destination, context);
            transferAddresses(cell, destination, context);
          }
        });
        break;
      }
      case 'store': {
        addWorkItem(() => {
          const sourceTargets = operandTargets(fact.filePath, site.source);
          const reached = reachedCells(fact.filePath, site.pointer);
          if (reached.overflow) return;
          for (const cell of reached.layers.at(-1) ?? []) {
            if (sourceTargets.overflow) {
              markTargetOverflow(cell, context);
              continue;
            }
            for (const target of sourceTargets.targets.values()) addTarget(cell, target, context);
          }
        });
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

  for (const invoke of invokes) {
    addWorkItem(() => {
      const callKey = callableFlowSiteKey(invoke.filePath, invoke.site.callSite);
      const targets = operandTargets(invoke.filePath, invoke.site.callee);
      if (targets.overflow || targets.targets.size > MAX_CALLABLE_VALUE_TARGETS) {
        if (!dynamicOverflow.has(callKey)) {
          dynamicOverflow.add(callKey);
          dynamicCallees.delete(callKey);
          warnOverflow(
            `invoke:${callKey}`,
            Math.max(targets.targets.size, MAX_CALLABLE_VALUE_TARGETS + 1),
            `site:${callKey}`,
          );
          notify('call', callKey);
        }
        return;
      }
      const expanded = expandMemberTargets(
        invoke,
        targets.targets,
        input.scopes,
        graphTargets,
        targetIndexes,
        input.graph,
      );
      const history = dynamicTargetHistory.get(callKey) ?? new Set<string>();
      for (const id of expanded.keys()) history.add(id);
      dynamicTargetHistory.set(callKey, history);
      const previous = dynamicCallees.get(callKey);
      if (!sameTargetSet(previous, expanded)) {
        dynamicCallees.set(callKey, expanded);
        notify('call', callKey);
      }
    });
  }

  for (const fact of facts) {
    if (fact.site.kind !== 'argument') continue;
    const site = fact.site;
    addWorkItem(() => {
      const callKey = callableFlowSiteKey(fact.filePath, site.callSite);
      const callSignature = callSignaturesBySite.get(callKey);
      const indexedFormals = (targetId: string): readonly IndexedFormal[] =>
        narrowIndexedFormals(
          formalsByGraphId.get(targetId)?.get(site.parameterIndex) ?? [],
          callSignature,
        );
      watch('call', callKey);
      const targetIds = new Set<string>();
      for (const id of input.calleeIds.get(fact.filePath)?.get(posKey(site.callSite)) ?? []) {
        targetIds.add(id);
      }
      for (const id of dynamicCallees.get(callKey)?.keys() ?? []) targetIds.add(id);
      let hasIndexedFormal = [...targetIds].some((id) => indexedFormals(id).length > 0);
      if (!hasIndexedFormal && site.directCalleeName !== undefined) {
        for (const target of resolveSeedCandidates(
          fact.filePath,
          site.source.inScope,
          site.directCalleeName,
          undefined,
          callSignature,
          input.scopes,
          graphTargets,
          globalBySimpleName,
          targetIndexes,
          input.graph,
        )) {
          targetIds.add(target.id);
        }
        hasIndexedFormal = [...targetIds].some((id) => indexedFormals(id).length > 0);
      }
      const history = dynamicTargetHistory.get(callKey);
      const callOverflow =
        dynamicOverflow.has(callKey) || targetIds.size > MAX_CALLABLE_VALUE_TARGETS;
      if (callOverflow) {
        for (const targetId of history ?? targetIds) {
          for (const formal of indexedFormals(targetId)) {
            const formalKey = bindingKey(formal.filePath, formal.site.binding);
            markTargetOverflow(formalKey, `actual-formal-overflow:${callKey}`);
            markAddressOverflow(formalKey, `actual-formal-overflow:${callKey}`);
          }
        }
        return;
      }
      if (targetIds.size === 0 || !hasIndexedFormal) return;

      const sourceKey = bindingKey(fact.filePath, site.source);
      const sourceTargets = operandTargets(fact.filePath, site.source);
      for (const targetId of targetIds) {
        for (const formal of indexedFormals(targetId)) {
          const formalKey = bindingKey(formal.filePath, formal.site.binding);
          const context = `actual-formal:${callKey}:${site.parameterIndex}`;
          const contextualTargets = new Map(sourceTargets.targets);
          for (const target of resolveOperandCandidates(
            fact.filePath,
            site.source,
            formal.site.expectedSignature,
            input.scopes,
            graphTargets,
            globalBySimpleName,
            targetIndexes,
            input.graph,
            !formalConstrainedBindings.has(sourceKey),
          )) {
            contextualTargets.set(target.id, target);
          }
          const narrowed = narrowTargetMap(
            contextualTargets,
            formal.site.expectedSignature,
            input.graph,
          );
          if (sourceTargets.overflow || narrowed.size > MAX_CALLABLE_VALUE_TARGETS) {
            markTargetOverflow(formalKey, context);
          } else {
            for (const target of narrowed.values()) addTarget(formalKey, target, context);
          }
          transferAddresses(sourceKey, formalKey, context);
          if (site.source.addressOf) addAddress(formalKey, sourceKey, context);
          if (formal.site.passingMode === 'reference') {
            transferTargets(formalKey, sourceKey, context);
            transferAddresses(formalKey, sourceKey, context);
          }
        }
      }
    });
  }

  let iterations = 0;
  const workBudget = Math.max(2_048, workItems.length * 128);
  let queueHead = 0;
  while (queueHead < queue.length && iterations < workBudget) {
    const id = queue[queueHead++]!;
    queued.delete(id);
    activeWorkItem = id;
    workItems[id]!();
    activeWorkItem = undefined;
    iterations++;
  }
  const workBudgetExceeded = queueHead < queue.length;
  if (workBudgetExceeded) {
    // `invokes` are exactly the deferred sites the ordinary passes already
    // skipped (`collectDeferredIndirectSites` feeds both) — every one of them
    // ends this run with zero CALLS, so the count goes in the warning context
    // rather than being lost (#2522 review finding: budget-bailout honesty).
    warnOverflow(
      'work-budget',
      iterations + queue.length - queueHead,
      `analysis-work-budget:${invokes.length}-deferred-sites-unresolved`,
      workBudget,
    );
  }

  for (const warning of overflowWarnings.values()) input.onWarn?.(warning);

  // No partial graph output when a hostile/corrupt fact graph exhausts the
  // bounded work budget. The caller receives a warning; NOTE this is not
  // free for callers — the deferred invoke sites were already excluded from
  // free-call fallback and reference emission, so they get no edges at all
  // this run. Non-deferred sites keep their ordinary resolution.
  if (workBudgetExceeded) {
    return {
      emitted: 0,
      resolvedInvokes: 0,
      ambiguousInvokes: invokes.length,
      unmatchedInvokes,
      iterations,
    };
  }

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
        tryEmitEdgeWithExplicitTargetId(
          input.graph,
          input.scopes,
          input.nodeLookup,
          { inScope: invoke.site.inScope, atRange: invoke.site.callSite, kind: 'call' },
          target.id,
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
  providerTarget: ((def: SymbolDefinition) => boolean) | undefined,
  graph: KnowledgeGraph,
): ReadonlyMap<string, Target> {
  const out = new Map<string, Target>();
  const byAnchor = buildGraphCallableAnchorIndex(graph);
  for (const def of scopes.defs.byId.values()) {
    if (!isCallable(def) && providerTarget?.(def) !== true) continue;
    const anchorKey = definitionAnchorKey(def);
    const anchored = anchorKey === undefined ? undefined : byAnchor.get(anchorKey);
    const id =
      anchored?.length === 1 ? anchored[0] : resolveDefGraphId(def.filePath, def, nodeLookup);
    // Overloads can intentionally share one graph node ID. Index by the
    // definition identity so contextual signature narrowing still sees the
    // complete overload set before a selected target collapses to graph ID.
    if (id !== undefined) out.set(def.nodeId, { id, def });
  }
  return out;
}

interface CanonicalCallableTargets {
  /** Definition identity remains the key; declaration keys may point at the definition target. */
  readonly targets: ReadonlyMap<string, Target>;
  /** Prototype/declaration graph ids grouped by their canonical definition graph id. */
  readonly aliasesByTargetId: ReadonlyMap<string, readonly string[]>;
}

/**
 * Associate declaration-only callable nodes with their unique out-of-file
 * definition. Function scopes are the body/definition signal; prototypes do
 * not create one. The optional provider predicate is deliberately linkage-
 * only, keeping language rules out of this shared pass and preventing `static`
 * symbols from leaking across translation units.
 */
function canonicalizeCallableDeclarations(
  rawTargets: ReadonlyMap<string, Target>,
  rawIndexes: CallableTargetIndexes,
  scopes: ScopeResolutionIndexes,
  graph: KnowledgeGraph,
  hasFileLocalCallableLinkage: ((def: SymbolDefinition) => boolean) | undefined,
): CanonicalCallableTargets {
  if (hasFileLocalCallableLinkage === undefined) {
    return { targets: rawTargets, aliasesByTargetId: new Map() };
  }

  const definitionAnchors = new Set<string>();
  for (const scope of scopes.scopeTree.byId.values()) {
    if (scope.kind !== 'Function') continue;
    definitionAnchors.add(`${scope.filePath}\0${scope.range.startLine}\0${scope.range.startCol}`);
  }
  const isDefinition = (target: Target): boolean => {
    const position = definitionPosition(target.def);
    return position !== undefined && definitionAnchors.has(position);
  };

  const targets = new Map(rawTargets);
  for (const [defId, declaration] of rawTargets) {
    if (isDefinition(declaration)) continue;
    const qualifiedName = effectiveQualifiedName(declaration.def, scopes);
    if (qualifiedName === undefined) continue;
    const candidates = dedupeTargets(
      (rawIndexes.byQualifiedName.get(qualifiedName) ?? []).filter((candidate) => {
        if (!isDefinition(candidate)) return false;
        if (candidate.def.filePath === declaration.def.filePath) return true;
        if (
          hasFileLocalCallableLinkage(declaration.def) ||
          hasFileLocalCallableLinkage(candidate.def)
        ) {
          return false;
        }
        return declarationSignatureCompatible(declaration, candidate, graph);
      }),
    );
    const byGraphId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    if (byGraphId.size === 1) {
      targets.set(defId, byGraphId.values().next().value as Target);
    }
  }

  const aliases = new Map<string, Set<string>>();
  for (const [defId, raw] of rawTargets) {
    const canonical = targets.get(defId);
    if (canonical === undefined || canonical.id === raw.id) continue;
    let bucket = aliases.get(canonical.id);
    if (bucket === undefined) {
      bucket = new Set();
      aliases.set(canonical.id, bucket);
    }
    bucket.add(raw.id);
  }
  return {
    targets,
    aliasesByTargetId: new Map(
      [...aliases].map(([targetId, graphIds]) => [targetId, [...graphIds]]),
    ),
  };
}

function definitionPosition(def: SymbolDefinition): string | undefined {
  const match = def.nodeId.match(/#(\d+):(\d+):/);
  return match === null ? undefined : `${def.filePath}\0${match[1]}\0${match[2]}`;
}

function declarationSignatureCompatible(
  declaration: Target,
  definition: Target,
  graph: KnowledgeGraph,
): boolean {
  const left = declaration.def;
  const right = definition.def;
  if (
    left.parameterCount !== undefined &&
    right.parameterCount !== undefined &&
    left.parameterCount !== right.parameterCount
  ) {
    return false;
  }
  if (
    left.parameterTypes !== undefined &&
    !sameOptionalArray(left.parameterTypes, right.parameterTypes)
  ) {
    return false;
  }
  if (
    left.parameterTypeClasses !== undefined &&
    !sameOptionalArray(left.parameterTypeClasses, right.parameterTypeClasses)
  ) {
    return false;
  }
  const declarationConst = graph.getNode(declaration.id)?.properties.isConst;
  const definitionConst = graph.getNode(definition.id)?.properties.isConst;
  return typeof declarationConst !== 'boolean' || declarationConst === definitionConst;
}

function buildGraphCallableAnchorIndex(
  graph: KnowledgeGraph,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Function' && node.label !== 'Method' && node.label !== 'Constructor') {
      continue;
    }
    const filePath = node.properties.filePath;
    const name = node.properties.name;
    const zeroBasedLine = node.properties.startLine;
    if (
      typeof filePath !== 'string' ||
      typeof name !== 'string' ||
      typeof zeroBasedLine !== 'number'
    ) {
      continue;
    }
    const key = `${filePath}\0${node.label}\0${zeroBasedLine + 1}\0${name}`;
    const bucket = out.get(key);
    if (bucket === undefined) out.set(key, [node.id]);
    else bucket.push(node.id);
  }
  return out;
}

function definitionAnchorKey(def: SymbolDefinition): string | undefined {
  const line = def.nodeId.match(/#(\d+):(\d+):/)?.[1];
  const name = simpleName(def.qualifiedName);
  if (line === undefined || name === undefined) return undefined;
  return `${def.filePath}\0${def.type}\0${line}\0${name}`;
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

interface CallableTargetIndexes {
  readonly byQualifiedName: ReadonlyMap<string, readonly Target[]>;
  readonly byOwnerAndName: ReadonlyMap<string, readonly Target[]>;
  readonly byFileAndName: ReadonlyMap<string, readonly Target[]>;
}

function buildCallableTargetIndexes(
  targets: Iterable<Target>,
  scopes: ScopeResolutionIndexes,
): CallableTargetIndexes {
  const byQualifiedName = new Map<string, Target[]>();
  const byOwnerAndName = new Map<string, Target[]>();
  const byFileAndName = new Map<string, Target[]>();
  const add = (index: Map<string, Target[]>, key: string | undefined, target: Target): void => {
    if (key === undefined) return;
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [target]);
    else bucket.push(target);
  };
  for (const target of targets) {
    const name = simpleName(target.def.qualifiedName);
    add(byQualifiedName, effectiveQualifiedName(target.def, scopes), target);
    add(
      byOwnerAndName,
      target.def.ownerId === undefined || name === undefined
        ? undefined
        : `${target.def.ownerId}\0${name}`,
      target,
    );
    add(byFileAndName, name === undefined ? undefined : `${target.def.filePath}\0${name}`, target);
  }
  return { byQualifiedName, byOwnerAndName, byFileAndName };
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
        readonly isConst?: boolean;
      }
    | undefined,
  scopes: ScopeResolutionIndexes,
  graphTargets: ReadonlyMap<string, Target>,
  globalBySimpleName: ReadonlyMap<string, readonly Target[]>,
  targetIndexes: CallableTargetIndexes,
  graph: KnowledgeGraph,
): readonly Target[] {
  let candidates: Target[] = [];
  let lexicalShadow = false;
  if (targetQualifiedName !== undefined) {
    for (const defId of scopes.qualifiedNames.get(targetQualifiedName)) {
      const def = scopes.defs.get(defId);
      if (def === undefined) continue;
      const target = targetForDef(def, graphTargets);
      if (target !== undefined) candidates.push(target);
    }
    if (candidates.length === 0) {
      const normalizedTarget = normalizeSymbolName(targetQualifiedName);
      candidates.push(...(targetIndexes.byQualifiedName.get(normalizedTarget) ?? []));
    }
    if (candidates.length === 0) {
      candidates.push(
        ...resolveBoundMemberCandidates(
          targetQualifiedName,
          targetName,
          inScope,
          scopes,
          graphTargets,
          targetIndexes,
        ),
      );
    }
    // HARD INVARIANT — a qualified/bound reference that resolves to nothing
    // must return NOTHING, never degrade to a workspace-wide same-simple-name
    // lookup. Language layers depend on this as their over-capture backstop:
    // Rust's `scoped_identifier` seeds cover non-callables (`Shape::Square`
    // unit variants) and Go emits nothing useful for mis-shaped multi-value
    // forms — both stay edge-free only because this guard holds (#2522
    // review). Relaxing it converts benign over-capture into wrong CALLS.
    if (candidates.length === 0) return [];
  } else {
    const lexical = lexicalCallableLookup(
      { name: targetName, inScope, atRange: zeroRange(), indirection: 0, addressOf: false },
      scopes,
      graphTargets,
    );
    candidates = lexical.targets;
    lexicalShadow = lexical.shadowed;
    if (candidates.length === 0 && !lexicalShadow) {
      candidates = [...(globalBySimpleName.get(targetName) ?? [])];
    }
  }
  candidates = narrowTargetCandidates(dedupeTargets(candidates), expected, graph);
  if (isUnresolvedOverloadSet(candidates)) return [];
  // File-local qualified lookup should not accidentally fan out to same-name
  // defs in unrelated files when the source explicitly names a local target.
  const sameFile = candidates.filter((candidate) => candidate.def.filePath === filePath);
  return sameFile.length > 0 ? sameFile : candidates;
}

function resolveOperandCandidates(
  filePath: string,
  operand: CallableFlowOperand,
  expected: CallableFlowFormalSite['expectedSignature'] | undefined,
  scopes: ScopeResolutionIndexes,
  graphTargets: ReadonlyMap<string, Target>,
  globalBySimpleName: ReadonlyMap<string, readonly Target[]>,
  targetIndexes: CallableTargetIndexes,
  graph: KnowledgeGraph,
  allowBindingLookup = true,
): readonly Target[] {
  // Plain bindings may resolve through an exact lexical/import binding (needed
  // for cross-file `const assigned = importedTarget`) but never through the
  // workspace-wide simple-name fallback. The latter can attach an unrelated
  // same-named function to a parameter or pointer variable.
  if (operand.expressionKind === undefined || operand.expressionKind === 'anonymous-callable') {
    return [];
  }
  if (operand.expressionKind === 'binding') {
    if (!allowBindingLookup) return [];
    const lexical = lexicalCallableLookup(operand, scopes, graphTargets);
    const candidates = narrowTargetCandidates(lexical.targets, expected, graph);
    return isUnresolvedOverloadSet(candidates) ? [] : candidates;
  }
  return resolveSeedCandidates(
    filePath,
    operand.inScope,
    operand.name,
    operand.qualifiedName,
    expected,
    scopes,
    graphTargets,
    globalBySimpleName,
    targetIndexes,
    graph,
  );
}

function resolveBoundMemberCandidates(
  qualifiedName: string,
  memberName: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  graphTargets: ReadonlyMap<string, Target>,
  targetIndexes: CallableTargetIndexes,
): readonly Target[] {
  const normalized = normalizeSymbolName(qualifiedName);
  const lastDot = normalized.lastIndexOf('.');
  if (lastDot <= 0) return [];
  const receiverRaw = normalized.slice(0, lastDot);
  const receiverName = receiverRaw.slice(receiverRaw.lastIndexOf('.') + 1);
  const receiverOperand: CallableFlowOperand = {
    name: receiverName,
    inScope,
    atRange: zeroRange(),
    indirection: 0,
    addressOf: false,
  };
  const typeRef = receiverType(receiverOperand, scopes) ?? receiverName;
  const receiverClass = resolveInheritanceBaseInScope(inScope, typeRef, scopes);
  if (receiverClass === undefined) return [];
  const owners = [receiverClass.nodeId, ...scopes.methodDispatch.mroFor(receiverClass.nodeId)];
  const out: Target[] = [];
  for (const owner of owners) {
    for (const target of targetIndexes.byOwnerAndName.get(`${owner}\0${memberName}`) ?? []) {
      const canonical = targetForDef(target.def, graphTargets);
      if (canonical !== undefined) out.push(canonical);
    }
    if (out.length > 0) break;
  }
  return dedupeTargets(out);
}

function lexicalCallableLookup(
  operand: CallableFlowOperand,
  scopes: ScopeResolutionIndexes,
  graphTargets: ReadonlyMap<string, Target>,
): { readonly targets: Target[]; readonly shadowed: boolean } {
  let current: ScopeId | null = operand.inScope;
  const visited = new Set<ScopeId>();
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const scope = scopes.scopeTree.getScope(current);
    if (scope === undefined) return { targets: [], shadowed: false };
    const refs = nearestScopeBindings(current, operand.name, scope.bindings, scopes);
    if (refs.length > 0) {
      const out: Target[] = [];
      for (const ref of refs) {
        const target = targetForDef(ref.def, graphTargets);
        if (target !== undefined) out.push(target);
      }
      return { targets: dedupeTargets(out), shadowed: true };
    }
    current = scope.parent;
  }
  return { targets: [], shadowed: false };
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

interface IndexedFormal {
  readonly filePath: string;
  readonly site: CallableFlowFormalSite;
  /** Exact definition owning this formal, even when overloads share a graph id. */
  readonly ownerDef?: SymbolDefinition;
}

function indexFormalsByGraphId(
  parsedFiles: readonly ParsedFile[],
  scopes: ScopeResolutionIndexes,
  nodeLookup: GraphNodeLookup,
  targetIndexes: CallableTargetIndexes,
  aliasesByTargetId: ReadonlyMap<string, readonly string[]>,
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
      // Signature-bearing graph ids can be more precise than a scope-only
      // caller lookup. Join the provider-supplied owner identity to canonical
      // defs as a fallback (important for function-reference parameters).
      const fallbackTargets =
        targetIndexes.byFileAndName.get(`${parsed.filePath}\0${site.ownerName}`) ?? [];
      const anchoredFallbacks = fallbackTargets.filter(
        (target) =>
          target.def.filePath === parsed.filePath &&
          definitionStartsAt(target.def, site.ownerRange.startLine, site.ownerRange.startCol),
      );
      const resolvedFallbacks = fallbackTargets.filter((target) => target.id === resolvedCaller);
      const ownerTargets =
        anchoredFallbacks.length > 0
          ? anchoredFallbacks
          : resolvedFallbacks.length === 1
            ? resolvedFallbacks
            : [];
      const indexFormal = (graphId: string, ownerDef?: SymbolDefinition): void => {
        let byIndex = building.get(graphId);
        if (byIndex === undefined) {
          byIndex = new Map();
          building.set(graphId, byIndex);
        }
        const bucket = byIndex.get(site.parameterIndex);
        const indexed = { filePath: parsed.filePath, site, ownerDef };
        if (bucket === undefined) byIndex.set(site.parameterIndex, [indexed]);
        else if (
          !bucket.some(
            (entry) =>
              entry.site.binding.inScope === site.binding.inScope &&
              entry.ownerDef?.nodeId === ownerDef?.nodeId,
          )
        ) {
          bucket.push(indexed);
        }
      };
      for (const target of ownerTargets) {
        if (target.def.filePath !== parsed.filePath) continue;
        if (
          target.def.parameterCount !== undefined &&
          site.parameterIndex >= target.def.parameterCount
        ) {
          continue;
        }
        indexFormal(target.id, target.def);
        for (const aliasId of aliasesByTargetId.get(target.id) ?? []) {
          indexFormal(aliasId, target.def);
        }
      }
      // Some providers can resolve an owner graph node without retaining a
      // callable SymbolDefinition. Preserve that established fallback; it
      // simply cannot participate in overload-owner narrowing.
      if (
        ownerTargets.length === 0 &&
        fallbackTargets.length === 0 &&
        resolvedCaller !== undefined
      ) {
        indexFormal(resolvedCaller);
      }
    }
  }
  return building;
}

function indexCallSignatures(
  parsedFiles: readonly ParsedFile[],
): ReadonlyMap<string, CallableFlowExpectedSignature> {
  const out = new Map<string, CallableFlowExpectedSignature>();
  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'call') continue;
      const signature: CallableFlowExpectedSignature = {
        ...(site.arity !== undefined ? { parameterCount: site.arity } : {}),
        ...(site.argumentTypes !== undefined ? { parameterTypes: site.argumentTypes } : {}),
        ...(site.argumentTypeClasses !== undefined
          ? { parameterTypeClasses: site.argumentTypeClasses }
          : {}),
      };
      const key = callableFlowSiteKey(parsed.filePath, site.atRange);
      const previous = out.get(key);
      if (previous === undefined || signatureEvidence(signature) > signatureEvidence(previous)) {
        out.set(key, signature);
      }
    }
  }
  return out;
}

function signatureEvidence(signature: CallableFlowExpectedSignature): number {
  return (
    (signature.parameterCount === undefined ? 0 : 1) +
    (signature.parameterTypes?.filter((type) => type.length > 0).length ?? 0) +
    (signature.parameterTypeClasses?.length ?? 0)
  );
}

function narrowIndexedFormals(
  formals: readonly IndexedFormal[],
  callSignature: CallableFlowExpectedSignature | undefined,
): readonly IndexedFormal[] {
  if (formals.length < 2 || callSignature === undefined) return formals;
  const owners = dedupeDefinitions(formals.flatMap((formal) => formal.ownerDef ?? []));
  if (owners.length < 2) return formals;
  const narrowed = narrowOverloadCandidates(
    owners,
    callSignature.parameterCount,
    callSignature.parameterTypes,
    { argumentTypeClasses: callSignature.parameterTypeClasses },
  );
  const allowed = new Set(narrowed.map((owner) => owner.nodeId));
  return formals.filter(
    (formal) => formal.ownerDef === undefined || allowed.has(formal.ownerDef.nodeId),
  );
}

function dedupeDefinitions(defs: readonly SymbolDefinition[]): SymbolDefinition[] {
  return [...new Map(defs.map((def) => [def.nodeId, def])).values()];
}

function definitionStartsAt(def: SymbolDefinition, line: number, column: number): boolean {
  const match = def.nodeId.match(/#(\d+):(\d+):/);
  return match !== null && Number(match[1]) === line && Number(match[2]) === column;
}

function expandMemberTargets(
  invoke: FileInvoke,
  targets: ReadonlyMap<string, Target>,
  scopes: ScopeResolutionIndexes,
  graphTargets: ReadonlyMap<string, Target>,
  targetIndexes: CallableTargetIndexes,
  graph: KnowledgeGraph,
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
    // A C++ pointer to a non-virtual member names that exact implementation.
    // Dynamic replacement is legal only when the pointed-to base method is
    // virtual; treating every member pointer as virtual invents derived calls.
    if (graph.getNode(target.id)?.properties.isVirtual !== true) {
      out.set(target.id, target);
      continue;
    }
    let replacement: Target | undefined;
    for (const ownerId of ownerChain) {
      const compatible = (targetIndexes.byOwnerAndName.get(`${ownerId}\0${name}`) ?? []).filter(
        (candidate) => sameCallableSignature(target, candidate, graph),
      );
      const distinct = new Map(compatible.map((candidate) => [candidate.id, candidate]));
      if (distinct.size !== 1) continue;
      const candidate = distinct.values().next().value as Target;
      replacement = targetForDef(candidate.def, graphTargets);
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
  return targets.get(def.nodeId);
}

function isCallable(def: SymbolDefinition): boolean {
  return def.type === 'Function' || def.type === 'Method' || def.type === 'Constructor';
}

function simpleName(qualifiedName: string | undefined): string | undefined {
  if (qualifiedName === undefined || qualifiedName.length === 0) return undefined;
  const normalized = qualifiedName.replaceAll('::', '.').replaceAll('\\', '.');
  return normalized.slice(normalized.lastIndexOf('.') + 1);
}

function effectiveQualifiedName(
  def: SymbolDefinition,
  scopes: ScopeResolutionIndexes,
): string | undefined {
  const ownName = simpleName(def.qualifiedName);
  if (ownName === undefined) return undefined;
  if (def.ownerId === undefined) return normalizeSymbolName(def.qualifiedName!);
  const owner = scopes.defs.get(def.ownerId);
  const ownerName = owner === undefined ? undefined : effectiveQualifiedName(owner, scopes);
  return ownerName === undefined ? ownName : `${ownerName}.${ownName}`;
}

function normalizeSymbolName(name: string): string {
  return name.replaceAll('::', '.').replaceAll('\\', '.');
}

function dedupeTargets(targets: readonly Target[]): Target[] {
  return [...new Map(targets.map((target) => [target.def.nodeId, target])).values()];
}

function narrowTargetCandidates(
  candidates: readonly Target[],
  expected: CallableFlowExpectedSignature | undefined,
  graph: KnowledgeGraph,
): Target[] {
  if (candidates.length === 0) return [];
  const narrowedDefs = narrowOverloadCandidates(
    candidates.map((candidate) => candidate.def),
    expected?.parameterCount,
    expected?.parameterTypes,
  );
  const allowedDefs = new Set(narrowedDefs.map((def) => def.nodeId));
  return candidates.filter((candidate) => {
    if (!allowedDefs.has(candidate.def.nodeId)) return false;
    if (expected?.isConst === undefined) return true;
    const candidateIsConst = graph.getNode(candidate.id)?.properties.isConst === true;
    return candidateIsConst === expected.isConst;
  });
}

function narrowTargetMap(
  targets: ReadonlyMap<string, Target>,
  expected: CallableFlowExpectedSignature | undefined,
  graph: KnowledgeGraph,
): Map<string, Target> {
  return new Map(
    narrowTargetCandidates([...targets.values()], expected, graph).map((target) => [
      target.id,
      target,
    ]),
  );
}

function sameTargetSet(
  left: ReadonlyMap<string, Target> | undefined,
  right: ReadonlyMap<string, Target>,
): boolean {
  if (left === undefined || left.size !== right.size) return false;
  for (const id of left.keys()) if (!right.has(id)) return false;
  return true;
}

function sameCallableSignature(base: Target, candidate: Target, graph: KnowledgeGraph): boolean {
  const left = base.def;
  const right = candidate.def;
  if (
    left.parameterCount !== undefined &&
    right.parameterCount !== undefined &&
    left.parameterCount !== right.parameterCount
  ) {
    return false;
  }
  if (!sameOptionalArray(left.parameterTypes, right.parameterTypes)) return false;
  if (!sameOptionalArray(left.parameterTypeClasses, right.parameterTypeClasses)) return false;
  const leftConst = graph.getNode(base.id)?.properties.isConst === true;
  const rightConst = graph.getNode(candidate.id)?.properties.isConst === true;
  return leftConst === rightConst;
}

function sameOptionalArray<T>(left: readonly T[] | undefined, right: readonly T[] | undefined) {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
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
