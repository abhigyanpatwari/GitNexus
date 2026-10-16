import type {
  FrameworkAllocation,
  FrameworkExpression,
  FrameworkImportResolver,
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
  | { kind: 'handler' };
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
      return 'handler';
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
        return { kind: 'handler' };
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
        const callee = evaluate(expression.callee, filePath, visiting, depth + 1);
        if (callee?.kind === 'factory' && (callee.framework !== 'hono' || expression.construct)) {
          const allocation: FrameworkAllocation = {
            id: expression.id,
            kind: callee.framework === 'express' ? 'app' : callee.framework,
          };
          value = { kind: 'instance', allocation };
          if (!invalidValues.has(keyOf(value))) allocations.set(allocation.id, allocation);
        } else if (expression.callee.kind === 'member' && !expression.construct) {
          const receiver = evaluate(expression.callee.object, filePath, visiting, depth + 1);
          const method = expression.callee.name;
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

  // Resolve property mutation targets before admission, then discard memoized
  // values so writes through imported/local aliases poison all dependent uses.
  for (const file of files)
    for (const mutation of file.mutations) {
      const value = evaluate(mutation, file.filePath);
      if (value) {
        invalidValues.add(keyOf(value));
        if (value.kind === 'factory' && value.framework === 'express')
          invalidValues.add('factory:router');
      }
    }
  cache.clear();
  allocations.clear();
  const result: ResolvedFrameworkRoutes = { allocations: [], registrations: [], mounts: [] };
  for (const file of files) {
    for (const binding of file.bindings)
      evaluate({ kind: 'binding', id: binding.id }, file.filePath);
    for (const call of file.calls) {
      const receiver = evaluate(call.receiver, file.filePath);
      if (!receiver) continue;
      if (
        call.method === 'use' &&
        receiver.kind === 'instance' &&
        receiver.allocation.kind !== 'hono'
      ) {
        const flatten = (value: Value | undefined): (Value | undefined)[] =>
          value?.kind === 'array' ? value.elements.flatMap(flatten) : [value];
        const values = call.arguments.flatMap((argument) =>
          flatten(evaluate(argument, file.filePath)),
        );
        const first = values[0];
        const prefixes =
          call.paths ??
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
        continue;
      }
      if (!VERBS.has(call.method)) continue;
      const builder = receiver.kind === 'builder';
      if (receiver.kind !== 'instance' && !builder) continue;
      if (call.arguments.length < (builder ? 1 : 2)) continue;
      const paths = builder ? receiver.paths : call.paths;
      if (!paths) continue;
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
        handlerBinding?.filePath === file.filePath &&
        handlerBinding.values.length === 1 &&
        handlerBinding.values[0].kind === 'handler' &&
        handler?.kind === 'binding' &&
        evaluate(handler, file.filePath)?.kind === 'handler'
          ? call.handlerName
          : undefined;
      for (const routePath of paths)
        result.registrations.push({
          receiverId: builder ? receiver.receiverId : receiver.allocation.id,
          framework,
          route: {
            frameworkCall: call,
            filePath: file.filePath,
            routePath,
            httpMethod: call.method === 'all' ? '*' : call.method.toUpperCase(),
            decoratorName: `${framework}.${call.method}`,
            lineNumber: call.lineNumber,
            ...(handlerName ? { handlerName } : {}),
          },
        });
    }
  }
  result.allocations = [...allocations.values()];
  return result;
}
