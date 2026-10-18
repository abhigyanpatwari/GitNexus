import type {
  FrameworkAllocation,
  FrameworkCallFact,
  FrameworkExpression,
  FrameworkImportResolver,
  FrameworkMount,
  FrameworkRouteFacts,
  ResolvedFrameworkRoutes,
} from './framework-route-types.js';

const VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all']);
const MAX_RESOLUTION_DEPTH = 128;
const MAX_RESOLUTION_STEPS = 10_000;
type Value =
  | { kind: 'factory'; framework: 'express' | 'router' | 'hono' }
  | { kind: 'module'; filePath: string }
  | { kind: 'instance'; allocation: FrameworkAllocation }
  | { kind: 'builder'; receiverId: string; paths: string[] }
  | { kind: 'array'; elements: (Value | undefined)[] }
  | { kind: 'handler'; fn?: string };
type ExportResult = { found: boolean; value?: Value };
const keyOf = (value: Value): string => {
  switch (value.kind) {
    case 'factory':
      return `factory:${value.framework}`;
    case 'module':
      return `module:${value.filePath}`;
    case 'instance':
      return `instance:${value.allocation.id}`;
    case 'builder':
      return `builder:${value.receiverId}:${JSON.stringify(value.paths)}`;
    case 'array':
      return `array:${value.elements.map((element) => element && keyOf(element)).join(',')}`;
    case 'handler':
      return `handler:${value.fn ?? ''}`;
  }
};

/** Resolve explicit static provenance without parsing, filesystem guesses, or execution. */
export function resolveFrameworkRouteFacts(
  files: readonly FrameworkRouteFacts[],
  resolveImportTargets: FrameworkImportResolver,
): ResolvedFrameworkRoutes {
  const byFile = new Map(files.map((file) => [file.filePath, file]));
  const bindings = new Map<string, { filePath: string; values: FrameworkExpression[] }>();
  const invalidBindings = new Set(files.flatMap((file) => file.invalidBindings));
  for (const file of files)
    for (const binding of file.bindings) {
      const entry = bindings.get(binding.id) ?? { filePath: file.filePath, values: [] };
      entry.values.push(binding.value);
      bindings.set(binding.id, entry);
    }
  const allocations = new Map<string, FrameworkAllocation>();
  const cache = new Map<string, Value>();
  let remainingSteps = MAX_RESOLUTION_STEPS;
  const invalidValues = new Set<string>();
  const moduleTargets = new Map<string, readonly string[]>();
  const targetFor = (filePath: string, source: string): string | undefined => {
    const key = `${filePath}\0${source}`;
    if (!moduleTargets.has(key)) {
      moduleTargets.set(key, [...new Set(resolveImportTargets(filePath, source))]);
    }
    const targets = moduleTargets.get(key)!;
    return targets.length === 1 && byFile.has(targets[0]) ? targets[0] : undefined;
  };
  const exportValue = (
    filePath: string,
    name: string,
    visiting: Set<string>,
    depth: number,
  ): ExportResult => {
    const key = `export:${filePath}\0${name}`;
    // Unknown due to a bound must compete with other star candidates; treating
    // it as absent could publish a winner from an incompletely explored barrel.
    if (--remainingSteps <= 0 || depth > MAX_RESOLUTION_DEPTH) return { found: true };
    if (visiting.has(key)) return { found: false };
    const file = byFile.get(filePath);
    if (!file) return { found: false };
    const direct = file.exports.filter((entry) => entry.name === name);
    const next = new Set(visiting).add(key);
    if (direct.length)
      return {
        found: true,
        ...(direct.length === 1
          ? { value: evaluate(direct[0].value, filePath, next, depth + 1) }
          : {}),
      };
    // A star export never republishes default. Explicit exports above win.
    if (name === 'default') return { found: false };
    const candidates: ExportResult[] = [];
    for (const source of file.starExports) {
      const target = targetFor(filePath, source);
      if (!target) {
        candidates.push({ found: true });
        continue;
      }
      const candidate = exportValue(target, name, next, depth + 1);
      if (candidate.found) candidates.push(candidate);
    }
    if (remainingSteps <= 0) return { found: true };
    if (!candidates.length) return { found: false };
    const first = candidates[0].value;
    return {
      found: true,
      value:
        first &&
        candidates.every((candidate) => candidate.value && keyOf(candidate.value) === keyOf(first))
          ? first
          : undefined,
    };
  };
  const imported = (
    filePath: string,
    source: string,
    name: string,
    visiting: Set<string>,
    depth: number,
  ): Value | undefined => {
    // Configured repository targets are authoritative even when their module
    // specifier matches a framework package name (e.g. a tsconfig path alias).
    const target = targetFor(filePath, source);
    if (!target) {
      if (moduleTargets.get(`${filePath}\0${source}`)?.length) return undefined;
      if (source === 'express') {
        if (name === 'Router') return { kind: 'factory', framework: 'router' };
        if (name === 'default' || name === '*' || name === 'require')
          return { kind: 'factory', framework: 'express' };
        return undefined;
      }
      if (source === 'hono') {
        if (name === 'Hono') return { kind: 'factory', framework: 'hono' };
        if (name === '*' || name === 'require') return { kind: 'module', filePath: 'package:hono' };
        return undefined;
      }
      return undefined;
    }
    if (name === '*') return { kind: 'module', filePath: target };
    if (name === 'require') {
      return (
        exportValue(target, 'default', visiting, depth + 1).value ?? {
          kind: 'module',
          filePath: target,
        }
      );
    }
    return exportValue(target, name, visiting, depth + 1).value;
  };
  const member = (
    value: Value | undefined,
    name: string,
    visiting: Set<string>,
    depth: number,
  ): Value | undefined => {
    if (value?.kind === 'factory' && value.framework === 'express') {
      if (name === 'Router') return { kind: 'factory', framework: 'router' };
      if (name === 'default') return value;
    }
    if (value?.kind === 'module') {
      if (value.filePath === 'package:hono')
        return name === 'Hono' ? { kind: 'factory', framework: 'hono' } : undefined;
      return exportValue(value.filePath, name, visiting, depth + 1).value;
    }
    return undefined;
  };
  const evaluate = (
    expression: FrameworkExpression,
    filePath: string,
    visiting = new Set<string>(),
    depth = 0,
  ): Value | undefined => {
    if (depth === 0) remainingSteps = MAX_RESOLUTION_STEPS;
    if (--remainingSteps <= 0 || depth > MAX_RESOLUTION_DEPTH) return undefined;
    let value: Value | undefined;
    switch (expression.kind) {
      case 'unknown':
        return undefined;
      case 'handler':
        return { kind: 'handler', ...(expression.fn ? { fn: expression.fn } : {}) };
      case 'array':
        return {
          kind: 'array',
          elements: expression.elements.map((element) =>
            evaluate(element, filePath, visiting, depth + 1),
          ),
        };
      case 'binding': {
        if (invalidBindings.has(expression.id) || visiting.has(expression.id)) return undefined;
        const cached = cache.get(expression.id);
        if (cached) return invalidValues.has(keyOf(cached)) ? undefined : cached;
        const binding = bindings.get(expression.id);
        if (!binding || binding.values.length !== 1) return undefined;
        value = evaluate(
          binding.values[0],
          binding.filePath,
          new Set(visiting).add(expression.id),
          depth + 1,
        );
        if (value) cache.set(expression.id, value);
        break;
      }
      case 'import':
        value = imported(filePath, expression.source, expression.name, visiting, depth + 1);
        break;
      case 'member':
        value = member(
          evaluate(expression.object, filePath, visiting, depth + 1),
          expression.name,
          visiting,
          depth + 1,
        );
        break;
      case 'call': {
        // A fluent call's receiver can itself be a call chain. Evaluate it once
        // for both member lookup and fluent propagation to avoid exponential work.
        const memberCallee = expression.callee.kind === 'member' ? expression.callee : undefined;
        const receiver = memberCallee
          ? evaluate(memberCallee.object, filePath, visiting, depth + 2)
          : undefined;
        const callee = memberCallee
          ? member(receiver, memberCallee.name, visiting, depth + 2)
          : evaluate(expression.callee, filePath, visiting, depth + 1);
        if (remainingSteps <= 0 || (callee && invalidValues.has(keyOf(callee)))) return undefined;
        if (callee?.kind === 'factory' && (callee.framework !== 'hono' || expression.construct)) {
          const allocation: FrameworkAllocation = {
            id: expression.id,
            kind: callee.framework === 'express' ? 'app' : callee.framework,
          };
          value = { kind: 'instance', allocation };
          if (!invalidValues.has(keyOf(value))) allocations.set(allocation.id, allocation);
        } else if (memberCallee && !expression.construct) {
          const method = memberCallee.name;
          if (
            receiver?.kind === 'instance' &&
            receiver.allocation.kind !== 'hono' &&
            method === 'route' &&
            expression.paths
          ) {
            value = {
              kind: 'builder',
              receiverId: receiver.allocation.id,
              paths: expression.paths,
            };
          } else if (
            receiver?.kind === 'builder' &&
            VERBS.has(method) &&
            expression.argumentCount >= 1
          )
            value = receiver;
          else if (
            receiver?.kind === 'instance' &&
            VERBS.has(method) &&
            expression.argumentCount >= 2 &&
            expression.paths
          )
            value = receiver;
          else if (
            receiver?.kind === 'instance' &&
            receiver.allocation.kind !== 'hono' &&
            method === 'use' &&
            expression.argumentCount >= 1
          )
            value = receiver;
        }
      }
    }
    return value && remainingSteps > 0 && !invalidValues.has(keyOf(value)) ? value : undefined;
  };

  const flatten = (value: Value | undefined): (Value | undefined)[] =>
    value?.kind === 'array' ? value.elements.flatMap(flatten) : [value];
  // Resolve all targets before poisoning any value: invalidating a namespace
  // must not hide a later mutation of another Router exported by that module.
  const mutatedValues = files.flatMap((file) =>
    file.mutations.map((mutation) => evaluate(mutation, file.filePath)),
  );
  // Retain proven incoming mounts before invalidation. An uncertain parent
  // cannot justify a path, but its child must not become a standalone Router.
  const uncertainMounts = new Map<FrameworkCallFact, FrameworkMount[]>();
  if (mutatedValues.some((value) => value !== undefined))
    for (const file of files)
      for (const call of file.calls) {
        if (call.method !== 'use') continue;
        const parent = evaluate(call.receiver, file.filePath);
        if (parent?.kind !== 'instance' || parent.allocation.kind === 'hono') continue;
        const mounts: FrameworkMount[] = [];
        for (const argument of call.arguments)
          for (const child of flatten(evaluate(argument, file.filePath)))
            if (child?.kind === 'instance' && child.allocation.kind !== 'hono')
              mounts.push({
                parentId: parent.allocation.id,
                childId: child.allocation.id,
                prefixes: null,
              });
        if (mounts.length) uncertainMounts.set(call, mounts);
      }
  for (const value of mutatedValues)
    if (value) {
      invalidValues.add(keyOf(value));
      if (value.kind === 'factory' && value.framework === 'express')
        invalidValues.add('factory:router');
    }
  cache.clear();
  allocations.clear();

  // One call-site hop (#3487): a registration whose receiver, path or mounted
  // child is a parameter of a named function takes that argument from each
  // call of the function. A site argument that is itself a parameter does not
  // resolve, so forwarding never chains, and a reassigned parameter is null.
  const parameterOf = new Map<string, { fn: string; index: number }>();
  /** The names each function is bound or exported under, for the call-site filter below. */
  const fnNames = new Map<string, Set<string>>();
  for (const file of files)
    for (const { name, value } of [
      ...file.bindings.map(({ id, value }) => ({
        name: id.slice(id.lastIndexOf('\0') + 1),
        value,
      })),
      ...file.exports,
    ])
      if (value.kind === 'handler' && value.fn) {
        value.params?.forEach((param, index) => {
          if (param && !invalidBindings.has(param))
            parameterOf.set(param, { fn: value.fn!, index });
        });
        fnNames.set(value.fn, (fnNames.get(value.fn) ?? new Set()).add(name));
      }
  const parameter = (expression: FrameworkExpression | undefined) =>
    expression?.kind === 'binding' ? parameterOf.get(expression.id) : undefined;
  // Only calls that can reach a function registering on its parameters are
  // evaluated: resolving every helper call in a large repo is the cost cliff.
  const forwardingNames = new Set<string>();
  for (const file of files)
    for (const call of file.calls)
      for (const expression of [call.receiver, ...call.arguments]) {
        const fn = parameter(expression)?.fn;
        for (const name of (fn && fnNames.get(fn)) ?? []) forwardingNames.add(name);
      }
  /** Local and imported names a callee may be known by (`import { a as b }` gives both). */
  const calleeNames = (callee: FrameworkExpression): string[] =>
    callee.kind === 'binding'
      ? [
          callee.id.slice(callee.id.lastIndexOf('\0') + 1),
          ...(bindings.get(callee.id)?.values ?? []).flatMap((value) =>
            value.kind === 'import' ? [value.name] : [],
          ),
        ]
      : callee.kind === 'import' || callee.kind === 'member'
        ? [callee.name]
        : [];
  const sitesOf = new Map<
    string,
    { filePath: string; arguments: FrameworkExpression[]; paths: (string[] | null)[] }[]
  >();
  for (const file of files)
    for (const invocation of forwardingNames.size ? file.invocations : []) {
      if (!calleeNames(invocation.callee).some((name) => forwardingNames.has(name))) continue;
      const callee = evaluate(invocation.callee, file.filePath);
      if (callee?.kind !== 'handler' || !callee.fn) continue;
      const sites = sitesOf.get(callee.fn) ?? [];
      sites.push({ filePath: file.filePath, ...invocation });
      sitesOf.set(callee.fn, sites);
    }
  interface Target {
    receiver: Value | undefined;
    paths: string[] | null;
    /** Evaluates an argument of the call, through the site for a forwarded parameter. */
    argument: (expression: FrameworkExpression) => Value | undefined;
  }
  /** Receiver, paths and arguments per call site, or undefined when nothing is forwarded. */
  const forwardedTargets = (call: FrameworkCallFact, filePath: string): Target[] | undefined => {
    const receiverParam = parameter(call.receiver);
    const pathParam = call.paths ? undefined : parameter(call.arguments[0]);
    // The receiver, the path or any argument (a mounted child) may be forwarded;
    // all of them must come from the same function.
    const fns = new Set(
      [call.receiver, ...call.arguments].flatMap((expression) => parameter(expression)?.fn ?? []),
    );
    const [fn] = fns;
    const sites = fn ? sitesOf.get(fn) : undefined;
    // No call site proves an argument: evaluate the call as written, which keeps
    // an unknown mount path suppressing its child router (no invented root).
    if (!fn || !sites || fns.size > 1) return undefined;
    return sites.map((site) => {
      const fromSite = (expression: FrameworkExpression | undefined) => {
        const forwarded = parameter(expression);
        return forwarded?.fn === fn
          ? evaluate(site.arguments[forwarded.index] ?? { kind: 'unknown' }, site.filePath)
          : expression && evaluate(expression, filePath);
      };
      return {
        receiver: fromSite(call.receiver),
        paths: call.paths ?? (pathParam ? (site.paths[pathParam.index] ?? null) : null),
        argument: fromSite,
      };
    });
  };

  const result: ResolvedFrameworkRoutes = { allocations: [], registrations: [], mounts: [] };
  for (const file of files) {
    for (const binding of file.bindings)
      evaluate({ kind: 'binding', id: binding.id }, file.filePath);
    for (const call of file.calls)
      for (const target of forwardedTargets(call, file.filePath) ?? [
        {
          receiver: evaluate(call.receiver, file.filePath),
          paths: call.paths,
          argument: (expression: FrameworkExpression) => evaluate(expression, file.filePath),
        },
      ])
        register(file.filePath, call, target);
  }
  result.allocations = [...allocations.values()];
  return result;

  function register(
    filePath: string,
    call: FrameworkCallFact,
    { receiver, paths: callPaths, argument }: Target,
  ): void {
    if (!receiver) {
      result.mounts.push(...(uncertainMounts.get(call) ?? []));
      return;
    }
    if (
      call.method === 'use' &&
      receiver.kind === 'instance' &&
      receiver.allocation.kind !== 'hono'
    ) {
      const values = call.arguments.flatMap((expression) => flatten(argument(expression)));
      // An invalidated argument can hide a known child even when its parent
      // still resolves. Keep that incoming edge without asserting a path.
      if (values.some((value) => value === undefined))
        result.mounts.push(...(uncertainMounts.get(call) ?? []));
      const first = values[0];
      const prefixes =
        callPaths ??
        (first?.kind === 'handler' ||
        (first?.kind === 'instance' && first.allocation.kind !== 'hono')
          ? ['']
          : null);
      for (const child of values)
        if (child?.kind === 'instance' && child.allocation.kind !== 'hono') {
          result.mounts.push({
            parentId: receiver.allocation.id,
            childId: child.allocation.id,
            prefixes,
          });
        }
      return;
    }
    if (!VERBS.has(call.method)) return;
    const builder = receiver.kind === 'builder';
    if (receiver.kind !== 'instance' && !builder) return;
    if (call.arguments.length < (builder ? 1 : 2)) return;
    const paths = builder ? receiver.paths : callPaths;
    if (!paths) return;
    const framework =
      receiver.kind === 'instance' && receiver.allocation.kind === 'hono' ? 'hono' : 'express';
    // The shared symbol model resolves a bare name only within this file.
    // Retain that evidence only for the exact lexical callable declaration;
    // parameters, imported aliases and unknown values must not borrow a
    // same-named function elsewhere in the file.
    const handler = call.arguments.at(-1);
    const handlerBinding = handler?.kind === 'binding' ? bindings.get(handler.id) : undefined;
    const handlerName =
      call.handlerName &&
      handlerBinding?.filePath === filePath &&
      handlerBinding.values.length === 1 &&
      handlerBinding.values[0].kind === 'handler' &&
      handler?.kind === 'binding' &&
      evaluate(handler, filePath)?.kind === 'handler'
        ? call.handlerName
        : undefined;
    for (const routePath of paths)
      result.registrations.push({
        receiverId: builder ? receiver.receiverId : receiver.allocation.id,
        framework,
        route: {
          frameworkCall: call,
          filePath,
          routePath,
          httpMethod: call.method === 'all' ? '*' : call.method.toUpperCase(),
          decoratorName: `${framework}.${call.method}`,
          lineNumber: call.lineNumber,
          ...(handlerName ? { handlerName } : {}),
        },
      });
  }
}
