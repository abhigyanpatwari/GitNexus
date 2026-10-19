import type { FetchWrapperDef } from '../workers/parse-worker.js';
import type { CalleeTarget, FetchWrapperCall } from './fetch-wrapper.js';

interface NameGroup {
  /** null means more than one distinct definition has this name. */
  unique: number | null;
  remainingCarriers: number;
  hasWrapper: boolean;
  dependents: number[];
}

function addUnique(index: Map<string, number | null>, key: string, definition: number): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, definition);
  else if (existing !== definition) index.set(key, null);
}

/** Build target indexes and propagate URL carriers once through each dependency. */
export function buildFetchWrapperIndex(
  definitions: readonly FetchWrapperDef[],
  configuredNames: readonly string[] = [],
): {
  isWrapperCall(call: Pick<FetchWrapperCall, 'filePath' | 'functionName' | 'target'>): boolean;
} {
  const configured = new Set(configuredNames);
  const seen = new Set<string>();
  const defs: FetchWrapperDef[] = [];
  const bindings = new Map<string, number | null>();
  const exports = new Map<string, number | null>();
  const names = new Map<string, NameGroup>();

  for (const definition of definitions) {
    const identity = `${definition.filePath}\0${definition.definitionId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const index = defs.length;
    defs.push(definition);
    if (definition.bindingId !== undefined) {
      addUnique(bindings, `${definition.filePath}\0${definition.bindingId}`, index);
    }
    if (definition.moduleScope) {
      for (const name of definition.exportedNames) {
        addUnique(exports, `${definition.filePath}\0${name}`, index);
      }
    }
    const group = names.get(definition.functionName);
    if (group) {
      group.unique = null;
      group.remainingCarriers++;
      group.hasWrapper ||= definition.seed;
    } else {
      names.set(definition.functionName, {
        unique: index,
        remainingCarriers: 1,
        hasWrapper: definition.seed,
        dependents: [],
      });
    }
  }

  const targetDefinition = (
    filePath: string,
    name: string,
    target: CalleeTarget,
  ): number | null | undefined => {
    switch (target.kind) {
      case 'binding':
        return bindings.get(`${filePath}\0${target.bindingId}`);
      case 'resolved-import':
        return exports.get(`${target.filePath}\0${target.importedName}`);
      case 'import':
        return names.get(target.importedName)?.unique;
      case 'unresolved':
        return names.get(name)?.unique;
      case 'blocked':
      case 'member':
        return undefined;
    }
  };

  const carriers = new Set<number>();
  const queue: number[] = [];
  const dependents: number[][] = Array.from({ length: defs.length }, () => []);
  const activate = (index: number): void => {
    if (carriers.has(index)) return;
    carriers.add(index);
    queue.push(index);
  };

  for (let index = 0; index < defs.length; index++) {
    const definition = defs[index];
    if (definition.forwardsUrl) activate(index);
    for (const forwarded of definition.forwardsTo) {
      if (configured.has(forwarded.callee)) {
        activate(index);
      } else if (forwarded.target.kind === 'member') {
        // Preserve member forwarding's existing all-definitions requirement.
        names.get(forwarded.callee)?.dependents.push(index);
      } else {
        const target = targetDefinition(definition.filePath, forwarded.callee, forwarded.target);
        if (target !== undefined && target !== null) dependents[target].push(index);
      }
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = queue[cursor];
    for (const dependent of dependents[index]) activate(dependent);
    const group = names.get(defs[index].functionName);
    if (!group) continue;
    group.hasWrapper = true;
    if (--group.remainingCarriers === 0) {
      for (const dependent of group.dependents) activate(dependent);
    }
  }

  return {
    isWrapperCall: ({ filePath, functionName, target }) => {
      if (configured.has(functionName)) return true;
      if (target.kind === 'member') return names.get(functionName)?.hasWrapper ?? false;
      const index = targetDefinition(filePath, functionName, target);
      return index !== undefined && index !== null && (defs[index].seed || carriers.has(index));
    },
  };
}

/** Resolve serialized import facts with the pipeline's existing project resolver. */
export function resolveFetchWrapperTargets(
  definitions: readonly FetchWrapperDef[],
  calls: readonly FetchWrapperCall[],
  resolveModuleTargets: (fromFile: string, specifier: string) => readonly string[],
): { definitions: FetchWrapperDef[]; calls: FetchWrapperCall[] } {
  const modules = new Map<string, readonly string[]>();
  const resolve = (filePath: string, target: CalleeTarget): CalleeTarget => {
    if (target.kind !== 'import') return target;
    const key = `${filePath}\0${target.specifier}`;
    let targets = modules.get(key);
    if (targets === undefined) {
      targets = resolveModuleTargets(filePath, target.specifier);
      modules.set(key, targets);
    }
    if (targets.length === 0) return target;
    if (targets.length !== 1) return { kind: 'blocked' };
    return { kind: 'resolved-import', filePath: targets[0], importedName: target.importedName };
  };
  // Aggregates share facts with the parse cache. Keep its raw specifiers intact
  // so a warm parse resolves imports against the current project configuration.
  return {
    definitions: definitions.map((definition) => ({
      ...definition,
      forwardsTo: definition.forwardsTo.map((forwarded) => ({
        ...forwarded,
        target: resolve(definition.filePath, forwarded.target),
      })),
    })),
    calls: calls.map((call) => ({ ...call, target: resolve(call.filePath, call.target) })),
  };
}
