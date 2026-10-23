import type { FetchWrapperDef } from '../workers/parse-worker.js';
import type {
  CalleeTarget,
  FetchWrapperCall,
  FetchWrapperReexport,
  ForwardedCallee,
} from './fetch-wrapper.js';
import { evaluateFetchUrlExpression, type FetchUrlExpression } from './fetch-url-expression.js';

interface NameGroup {
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
  urlsForCall(call: FetchWrapperCall): string[];
} {
  const configured = new Set(configuredNames);
  const seen = new Set<string>();
  const defs: FetchWrapperDef[] = [];
  const bindings = new Map<string, number | null>();
  const exports = new Map<string, number | null>();
  // Name-only fallbacks consider only definitions that can be the target: an
  // unresolvable import names some module's export, an undeclared global a
  // top-level function. Nested and unexported helpers never collide with them.
  const exportedAnywhere = new Map<string, number | null>();
  const topLevel = new Map<string, number | null>();
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
        addUnique(exportedAnywhere, name, index);
      }
      addUnique(topLevel, definition.functionName, index);
    }
    const group = names.get(definition.functionName);
    if (group) {
      group.remainingCarriers++;
      group.hasWrapper ||= definition.seed;
    } else {
      names.set(definition.functionName, {
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
        return exportedAnywhere.get(target.importedName);
      case 'unresolved':
        return topLevel.get(name);
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
    for (const forwarded of [
      ...definition.forwardsTo,
      ...(definition.urlArguments ?? []).map((flow) => flow.callee),
    ]) {
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

  const isWrapperCall = ({
    filePath,
    functionName,
    target,
  }: Pick<FetchWrapperCall, 'filePath' | 'functionName' | 'target'>) => {
    if (configured.has(functionName)) return true;
    if (target.kind === 'member') return names.get(functionName)?.hasWrapper ?? false;
    const index = targetDefinition(filePath, functionName, target);
    return index !== undefined && index !== null && (defs[index].seed || carriers.has(index));
  };
  const urlsForDefinition = (
    index: number,
    input: string,
    active: Set<number>,
    budget: { remaining: number },
  ): string[] => {
    if (active.has(index) || active.size >= 32 || --budget.remaining < 0) return [];
    const definition = defs[index];
    // Existing/configured wrappers without string-operation evidence retain
    // their literal path. New facts with an empty list explicitly prove none.
    if (definition.urlArguments === undefined) return [input];
    active.add(index);
    const evaluate = (expression: FetchUrlExpression): string | undefined =>
      evaluateFetchUrlExpression(expression, input, (callee, argument) =>
        returnedUrl(index, callee, argument, active, budget),
      );
    const urls = new Set<string>();
    for (const flow of definition.urlArguments) {
      if (--budget.remaining < 0) break;
      const argument = evaluate(flow.argument);
      if (argument === undefined) continue;
      if (flow.fetch || configured.has(flow.callee.callee)) urls.add(argument);
      else {
        const target = targetDefinition(
          definition.filePath,
          flow.callee.callee,
          flow.callee.target,
        );
        if (target !== undefined && target !== null && (defs[target].seed || carriers.has(target)))
          for (const url of urlsForDefinition(target, argument, active, budget)) urls.add(url);
      }
    }
    active.delete(index);
    return [...urls];
  };
  const returnedUrl = (
    from: number,
    callee: ForwardedCallee,
    input: string,
    active: Set<number>,
    budget: { remaining: number },
  ): string | undefined => {
    const target = targetDefinition(defs[from].filePath, callee.callee, callee.target);
    if (
      target === undefined ||
      target === null ||
      active.has(target) ||
      active.size >= 32 ||
      --budget.remaining < 0
    )
      return undefined;
    const expression = defs[target].urlReturn;
    if (expression === undefined) return undefined;
    active.add(target);
    const result = evaluateFetchUrlExpression(expression, input, (nested, value) =>
      returnedUrl(target, nested, value, active, budget),
    );
    active.delete(target);
    return result;
  };
  return {
    isWrapperCall,
    urlsForCall: (call) => {
      if (!isWrapperCall(call)) return [];
      const index = targetDefinition(call.filePath, call.functionName, call.target);
      // Configuration explicitly establishes an opaque HTTP sink, including
      // custom clients whose internals are outside auto-detection's evidence.
      if (
        configured.has(call.functionName) &&
        (index === undefined || index === null || (!defs[index].seed && !carriers.has(index)))
      )
        return [call.fetchURL];
      return index === undefined || index === null
        ? [call.fetchURL]
        : urlsForDefinition(index, call.fetchURL, new Set(), { remaining: 256 });
    },
  };
}

/**
 * Resolve serialized import facts with the pipeline's existing project resolver.
 * Only providers whose modules link by ECMAScript rules emit re-export facts, so
 * the barrel walk applies ResolveExport; it names no language and consults no
 * provider.
 */
export function resolveFetchWrapperTargets(
  definitions: readonly FetchWrapperDef[],
  calls: readonly FetchWrapperCall[],
  resolveModuleTargets: (fromFile: string, specifier: string) => readonly string[],
  reexports: readonly FetchWrapperReexport[] = [],
): { definitions: FetchWrapperDef[]; calls: FetchWrapperCall[] } {
  const modules = new Map<string, readonly string[]>();
  const moduleTargets = (filePath: string, specifier: string): readonly string[] => {
    const key = `${filePath}\0${specifier}`;
    let targets = modules.get(key);
    if (targets === undefined) {
      targets = resolveModuleTargets(filePath, specifier);
      modules.set(key, targets);
    }
    return targets;
  };
  // Each export name maps to the declaration it names; a name two declarations
  // claim keeps a name-only identity, so it never merges with another export.
  const declared = new Map<string, string>();
  for (const definition of definitions)
    if (definition.moduleScope)
      for (const name of definition.exportedNames) {
        const key = `${definition.filePath}\0${name}`;
        const identity = `${definition.filePath}\0${definition.definitionId}`;
        const existing = declared.get(key);
        declared.set(key, existing === undefined || existing === identity ? identity : `${key}\0`);
      }
  const named = new Map<string, FetchWrapperReexport[]>();
  const stars = new Map<string, FetchWrapperReexport[]>();
  for (const reexport of reexports) {
    const [index, key] =
      reexport.exportedName === '*'
        ? [stars, reexport.filePath]
        : [named, `${reexport.filePath}\0${reexport.exportedName}`];
    const bucket = index.get(key);
    if (bucket) bucket.push(reexport);
    else index.set(key, [reexport]);
  }
  // Follow a barrel to the module declaring the export. Local and named exports
  // shadow `export *`; star exports never carry `default`, and conflicting star
  // exports leave the name unexported (ECMAScript ResolveExport).
  interface ExportFrame {
    filePath: string;
    name: string;
    candidates: readonly FetchWrapperReexport[];
    cursor: number;
    found: Map<string, CalleeTarget>;
    /** A branch stopped at an export already on this walk, so the result is not reusable. */
    partial: boolean;
  }
  type ExportStep = { frame: ExportFrame } | { value: CalleeTarget | undefined; partial?: true };
  // Fully explored exports, shared by every walk: calls that enter a chain at
  // different hops reuse the hops below, keeping the work linear in the chain.
  const resolvedExports = new Map<string, CalleeTarget | undefined>();
  // Explicit frames instead of recursion, so long re-export chains cannot
  // exhaust the call stack. One walk shares `seen` across all of its branches.
  const exporter = (startFile: string, startName: string): CalleeTarget | undefined => {
    const seen = new Set<string>();
    const open = (filePath: string, name: string): ExportStep => {
      const key = `${filePath}\0${name}`;
      if (declared.has(key))
        return { value: { kind: 'resolved-import', filePath, importedName: name } };
      if (resolvedExports.has(key)) return { value: resolvedExports.get(key) };
      if (seen.has(key)) return { value: undefined, partial: true };
      seen.add(key);
      const candidates =
        named.get(key) ?? (name === 'default' ? undefined : stars.get(filePath)) ?? [];
      return { frame: { filePath, name, candidates, cursor: 0, found: new Map(), partial: false } };
    };
    // Star exports conflict only when they reach different bindings, so two
    // export names of one declaration are one candidate.
    const record = (frame: ExportFrame, target: CalleeTarget | undefined) => {
      if (!target) return;
      const identity =
        target.kind === 'resolved-import'
          ? declared.get(`${target.filePath}\0${target.importedName}`)
          : undefined;
      const key = identity ?? JSON.stringify(target);
      if (!frame.found.has(key)) frame.found.set(key, target);
    };
    const first = open(startFile, startName);
    if ('value' in first) return first.value;
    const frames = [first.frame];
    let finished: CalleeTarget | undefined;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      let nested: ExportFrame | undefined;
      let local = false;
      while (frame.cursor < frame.candidates.length) {
        const { from } = frame.candidates[frame.cursor++];
        // A local export that declares no wrapper shadows every forwarded name.
        if (!from) {
          local = true;
          break;
        }
        const targets = moduleTargets(frame.filePath, from.specifier);
        if (targets.length !== 1) continue;
        const step = open(targets[0], from.importedName === '*' ? frame.name : from.importedName);
        if ('value' in step) {
          record(frame, step.value);
          if (step.partial) frame.partial = true;
        } else {
          nested = step.frame;
          break;
        }
      }
      if (nested) {
        frames.push(nested);
        continue;
      }
      frames.pop();
      // A local non-wrapper export is still an export: it shadows star exports
      // here and conflicts with a wrapper another star export reaches.
      finished = local
        ? { kind: 'resolved-import', filePath: frame.filePath, importedName: frame.name }
        : frame.found.size > 1
          ? { kind: 'blocked' }
          : frame.found.values().next().value;
      if (!frame.partial) resolvedExports.set(`${frame.filePath}\0${frame.name}`, finished);
      const parent = frames[frames.length - 1];
      if (parent) {
        record(parent, finished);
        if (frame.partial) parent.partial = true;
      }
    }
    return finished;
  };
  const resolve = (filePath: string, target: CalleeTarget): CalleeTarget => {
    if (target.kind !== 'import') return target;
    const targets = moduleTargets(filePath, target.specifier);
    if (targets.length === 0) return target;
    if (targets.length !== 1) return { kind: 'blocked' };
    return (
      exporter(targets[0], target.importedName) ?? {
        kind: 'resolved-import',
        filePath: targets[0],
        importedName: target.importedName,
      }
    );
  };
  const resolveExpression = (
    filePath: string,
    expression: FetchUrlExpression,
  ): FetchUrlExpression => {
    if (typeof expression === 'string' || expression.kind === 'parameter') return expression;
    if (expression.kind === 'call')
      return {
        ...expression,
        callee: { ...expression.callee, target: resolve(filePath, expression.callee.target) },
        argument: resolveExpression(filePath, expression.argument),
      };
    if (expression.kind === 'concat')
      return {
        ...expression,
        parts: expression.parts.map((part) => resolveExpression(filePath, part)),
      };
    return {
      ...expression,
      value: resolveExpression(filePath, expression.value),
      consequence: resolveExpression(filePath, expression.consequence),
      alternative: resolveExpression(filePath, expression.alternative),
    };
  };
  // Aggregates share facts with the parse cache. Keep its raw specifiers intact
  // so a warm parse resolves imports against the current project configuration.
  return {
    definitions: definitions.map((definition) =>
      definition.forwardsTo.some((forwarded) => forwarded.target.kind === 'import') ||
      definition.urlArguments !== undefined ||
      definition.urlReturn !== undefined
        ? {
            ...definition,
            forwardsTo: definition.forwardsTo.map((forwarded) => ({
              ...forwarded,
              target: resolve(definition.filePath, forwarded.target),
            })),
            ...(definition.urlArguments !== undefined
              ? {
                  urlArguments: definition.urlArguments.map((flow) => ({
                    ...flow,
                    callee: {
                      ...flow.callee,
                      target: resolve(definition.filePath, flow.callee.target),
                    },
                    argument: resolveExpression(definition.filePath, flow.argument),
                  })),
                }
              : {}),
            ...(definition.urlReturn !== undefined
              ? {
                  urlReturn: resolveExpression(definition.filePath, definition.urlReturn),
                }
              : {}),
          }
        : definition,
    ),
    calls: calls.map((call) =>
      call.target.kind === 'import'
        ? { ...call, target: resolve(call.filePath, call.target) }
        : call,
    ),
  };
}
