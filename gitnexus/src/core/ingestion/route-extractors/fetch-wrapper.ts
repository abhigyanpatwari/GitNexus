/** Binding-aware HTTP evidence collected from the provider's existing AST. */
import type Parser from 'tree-sitter';
import type { ParsedFile } from 'gitnexus-shared';
import type { ExtractedFetchCall } from '../workers/parse-worker.js';
import { stripLeadingTemplatePrefix } from './route-path.js';
import {
  createLexicalBindings,
  LEXICAL_FUNCTION_TYPES,
  patternBindingNames,
  type LexicalBindings,
} from './lexical-bindings.js';

type Node = Parser.SyntaxNode;
export type CalleeTarget =
  | { kind: 'binding'; bindingId: string }
  | { kind: 'import'; specifier: string; importedName: string }
  | { kind: 'resolved-import'; filePath: string; importedName: string }
  | { kind: 'unresolved' }
  | { kind: 'blocked' }
  | { kind: 'member' };

export interface FetchWrapperCall extends ExtractedFetchCall {
  functionName: string;
  target: CalleeTarget;
}
export interface ForwardedCallee {
  callee: string;
  target: CalleeTarget;
}
export interface FetchWrapperFacts {
  definitionId: string;
  bindingId?: string;
  moduleScope: boolean;
  exportedNames: string[];
  seed: boolean;
  forwardsUrl: boolean;
  forwardsTo: ForwardedCallee[];
}
/** A module export relevant to barrel resolution. */
export interface FetchWrapperReexport {
  filePath: string;
  /** Exported name, or `*` for `export * from`. */
  exportedName: string;
  /** The forwarded export. Absent for a local export, recorded only beside an
   * `export *` because only there can it shadow a forwarded name. */
  from?: { specifier: string; importedName: string };
}
export interface FetchWrapperContext {
  bindings: LexicalBindings;
  facts(definition: Node, nameNode?: Node): FetchWrapperFacts | undefined;
  calls(): FetchWrapperCall[];
  reexports(): FetchWrapperReexport[];
}

/** A repo-relative module path without its extension or `/index`. */
export function moduleStem(filePath: string): string {
  return filePath.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
}

function calleeName(node: Parser.SyntaxNode | null): string | undefined {
  // The TS grammar puts `await f<T>(...)` inside the call's function field.
  while (node?.type === 'await_expression') {
    node = node.namedChildren.find((child) => child.type !== 'comment') ?? null;
  }
  // Unlike constant names, configured wrapper names may start with this/super.
  const parts: string[] = [];
  while (node?.type === 'member_expression') {
    const property = node.childForFieldName('property');
    if (property?.type !== 'property_identifier') return undefined;
    parts.push(property.text);
    node = node.childForFieldName('object');
  }
  if (!node || !['identifier', 'this', 'super'].includes(node.type)) return undefined;
  parts.push(node.text);
  return parts.reverse().join('.');
}

function unwrap(node: Node | null): Node | null {
  while (
    node &&
    [
      'parenthesized_expression',
      'as_expression',
      'satisfies_expression',
      'non_null_expression',
      'await_expression',
    ].includes(node.type)
  ) {
    node = node.namedChildren.find((child) => child.type !== 'comment') ?? null;
  }
  return node;
}
function parameterPattern(node: Node | null): Node | null {
  if (node?.type === 'required_parameter' || node?.type === 'optional_parameter')
    node = node.childForFieldName('pattern');
  if (node?.type === 'assignment_pattern') node = node.childForFieldName('left');
  return node;
}
function storedName(node: Node, parents: ReadonlyMap<number, Node>): Node | null {
  let parent = parents.get(node.id);
  while (parent && unwrap(parent)?.id === unwrap(node)?.id) {
    node = parent;
    parent = parents.get(node.id);
  }
  if (parent?.type === 'variable_declarator' && parent.childForFieldName('value')?.id === node.id)
    return parent.childForFieldName('name');
  if (parent?.type === 'assignment_pattern' && parent.childForFieldName('right')?.id === node.id)
    return parent.childForFieldName('left');
  if (
    (parent?.type === 'required_parameter' || parent?.type === 'optional_parameter') &&
    parent.childForFieldName('value')?.id === node.id
  )
    return parameterPattern(parent);
  return null;
}
interface Region {
  node: Node;
  references: Set<string>;
  edges: Set<Region>;
  calls: Node[];
}

/** Fresh construction is intentional: callers may cache only at the per-file provider boundary. */
export function createFetchWrapperContext(
  tree: Parser.Tree,
  parsedFile: ParsedFile,
  lineOffset = 0,
): FetchWrapperContext {
  const bindings = createLexicalBindings(parsedFile, lineOffset, tree.rootNode);
  const filePath = parsedFile.filePath;
  const imports = new Map<string, CalleeTarget>();
  for (const imported of parsedFile.parsedImports) {
    if (!('localName' in imported) || !('importedName' in imported)) continue;
    const id = `${imported.declaredAtScope ?? parsedFile.moduleScope}\0${imported.localName}`;
    const target: CalleeTarget =
      'typeOnly' in imported && imported.typeOnly
        ? { kind: 'blocked' }
        : {
            kind: 'import',
            specifier: imported.targetRaw,
            importedName: imported.importedName,
          };
    if (imports.has(id)) imports.set(id, { kind: 'blocked' });
    else imports.set(id, target);
  }
  const stableBinding = (node: Node, atUse = true): string | undefined => {
    const id = bindings.bindingId(node, node.text, atUse);
    return id && !bindings.ambiguous(id) ? id : undefined;
  };
  const targetOf = (callee: Node | null): CalleeTarget => {
    const node = unwrap(callee);
    if (!node) return { kind: 'blocked' };
    if (node.type === 'member_expression') return { kind: 'member' };
    if (node.type !== 'identifier') return { kind: 'blocked' };
    const owner = bindings.ownership(node, node.text, true);
    if (owner?.status === 'absent') return { kind: 'unresolved' };
    const id = stableBinding(node);
    return id && !invalid.has(id)
      ? (imports.get(id) ?? { kind: 'binding', bindingId: id })
      : { kind: 'blocked' };
  };
  const platformFetch = (expression: Node | null): boolean => {
    const node = unwrap(expression);
    if (!node) return false;
    if (node.type === 'identifier')
      return node.text === 'fetch' && bindings.isGlobal(node, 'fetch');
    if (node.type !== 'member_expression' || node.childForFieldName('property')?.text !== 'fetch')
      return false;
    const root = node.childForFieldName('object');
    return (
      !!root &&
      root.type === 'identifier' &&
      ['globalThis', 'window', 'self'].includes(root.text) &&
      bindings.isGlobal(root, root.text)
    );
  };
  const namesFetch = (expression: Node | null): boolean => {
    const node = unwrap(expression);
    if (!node) return false;
    if (node.type === 'binary_expression') {
      const operator = node.childForFieldName('operator')?.text;
      return (
        (operator === '??' || operator === '||') &&
        (namesFetch(node.childForFieldName('left')) || namesFetch(node.childForFieldName('right')))
      );
    }
    if (node.type === 'ternary_expression')
      return (
        namesFetch(node.childForFieldName('consequence')) ||
        namesFetch(node.childForFieldName('alternative'))
      );
    return platformFetch(node);
  };
  const regions: Region[] = [];
  const callableRegions = new Map<number, Region>();
  const boundRegions = new Map<string, Region[]>();
  const declarationNodes = new Set<number>();
  const aliases = new Set<string>();
  const invalid = new Set<string>();
  const initialized = new Map<string, number>();
  const parameters = new Set<string>();
  const exports = new Map<string, Set<string>>();
  const allCalls: Node[] = [];
  // Native parent lookup descends from the tree root; retain traversal edges once.
  const parents = new Map<number, Node>();
  const region = (node: Node): Region => {
    const result = {
      node,
      references: new Set<string>(),
      edges: new Set<Region>(),
      calls: [] as Node[],
    };
    regions.push(result);
    return result;
  };
  const bindRegion = (name: Node | null, value: Region) => {
    if (!name || !['identifier', 'type_identifier'].includes(name.type)) return;
    declarationNodes.add(name.id);
    const id = stableBinding(name, false);
    if (!id) return;
    const bucket = boundRegions.get(id);
    if (bucket) bucket.push(value);
    else boundRegions.set(id, [value]);
  };
  const markPattern = (pattern: Node | null) => {
    const names = patternBindingNames(pattern);
    for (const name of names) declarationNodes.add(name.id);
    return names;
  };
  const invalidate = (pattern: Node | null) => {
    for (const name of patternBindingNames(pattern)) {
      declarationNodes.add(name.id);
      const id = bindings.bindingId(name);
      if (id) invalid.add(id);
    }
  };
  const initialize = (pattern: Node | null, value: Node | null, parameter = false) => {
    for (const name of markPattern(pattern)) {
      const id = stableBinding(name, false);
      if (!id) continue;
      if (parameter) parameters.add(id);
      if (!value) continue;
      initialized.set(id, (initialized.get(id) ?? 0) + 1);
      if (!parameter && parameters.has(id)) invalid.add(id);
      if (pattern?.type === 'identifier' && namesFetch(value)) aliases.add(id);
    }
  };
  const exported = (local: Node, name: string) => {
    const id = stableBinding(local, false);
    if (!id) return;
    let names = exports.get(id);
    if (!names) exports.set(id, (names = new Set()));
    names.add(name);
  };
  const pending: { node: Node; parent?: Node; region: Region; classRegion?: Region }[] = [
    { node: tree.rootNode, region: region(tree.rootNode) },
  ];
  while (pending.length) {
    const entry = pending.pop()!;
    const node = entry.node;
    const parent = entry.parent;
    if (parent) parents.set(node.id, parent);
    const active = entry.region;
    if (
      node.type === 'comment' ||
      node.type === 'ERROR' ||
      ['type_annotation', 'type_parameters', 'type_arguments', 'import_statement'].includes(
        node.type,
      )
    )
      continue;
    const children = node.namedChildren;
    // A bodyless overload or ambient signature declares no separate callable:
    // its implementation alone owns the binding.
    if (LEXICAL_FUNCTION_TYPES.has(node.type) && !node.childForFieldName('body')) continue;
    if (LEXICAL_FUNCTION_TYPES.has(node.type)) {
      const callable = region(node);
      callableRegions.set(node.id, callable);
      const name = node.childForFieldName('name');
      const stored = storedName(node, parents);
      const declaration =
        node.type === 'function_declaration' || node.type === 'generator_function_declaration';
      bindRegion(declaration ? name : stored, callable);
      if (!declaration && name?.type === 'identifier') bindRegion(name, callable);
      if (name) declarationNodes.add(name.id);
      if (node.type === 'method_definition') (entry.classRegion ?? active).edges.add(callable);
      else if (!declaration && !stored) active.edges.add(callable);
      if (declaration && name) {
        const id = stableBinding(name, false);
        if (id && parameters.has(id)) invalid.add(id);
      }
      const formals = node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
      for (const name of markPattern(formals)) {
        const id = stableBinding(name, false);
        if (id) parameters.add(id);
      }
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        // Computed names and decorators are evaluated when the method is created.
        pending.push({
          node: child,
          parent: node,
          region:
            child.type === 'computed_property_name' || child.type === 'decorator'
              ? active
              : callable,
        });
      }
      continue;
    }
    if (node.type === 'class_declaration' || node.type === 'class') {
      const deferred = region(node);
      const name = node.childForFieldName('name');
      const stored = storedName(node, parents);
      bindRegion(stored ?? name, deferred);
      if (stored && name) bindRegion(name, deferred);
      if (!stored && !name) active.edges.add(deferred);
      for (let i = children.length - 1; i >= 0; i--)
        pending.push({ node: children[i], parent: node, region: active, classRegion: deferred });
      continue;
    }
    if (node.type === 'field_definition' || node.type === 'public_field_definition') {
      const isStatic = node.children.some((child) => child.type === 'static');
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        const evaluated =
          child.type === 'computed_property_name' || child.type === 'decorator' || isStatic;
        pending.push({
          node: child,
          parent: node,
          region: evaluated ? active : (entry.classRegion ?? active),
        });
      }
      continue;
    }
    if (node.type === 'variable_declarator')
      initialize(node.childForFieldName('name'), node.childForFieldName('value'));
    else if (node.type === 'required_parameter' || node.type === 'optional_parameter')
      initialize(parameterPattern(node), node.childForFieldName('value'), true);
    else if (node.type === 'assignment_pattern')
      initialize(node.childForFieldName('left'), node.childForFieldName('right'), true);
    else if (node.type === 'catch_clause') markPattern(node.childForFieldName('parameter'));
    else if (
      node.type === 'assignment_expression' ||
      node.type === 'augmented_assignment_expression'
    )
      invalidate(node.childForFieldName('left'));
    else if (node.type === 'update_expression') invalidate(node.childForFieldName('argument'));
    else if (node.type === 'for_in_statement') {
      const left = node.childForFieldName('left');
      if (node.childForFieldName('kind')) markPattern(left);
      invalidate(left);
    }
    if (node.type === 'export_statement') {
      const declaration = node.childForFieldName('declaration');
      const value = node.childForFieldName('value');
      const isDefault = node.children.some((child) => child.type === 'default');
      if (declaration) {
        const name = declaration.childForFieldName('name');
        if (name?.type === 'identifier') exported(name, isDefault ? 'default' : name.text);
        else
          for (const declarator of declaration.namedChildren) {
            for (const local of patternBindingNames(declarator.childForFieldName('name')))
              exported(local, isDefault ? 'default' : local.text);
          }
      } else if (isDefault && value?.type === 'identifier') exported(value, 'default');
    } else if (
      node.type === 'export_specifier' &&
      !(parent && parents.get(parent.id))?.childForFieldName('source')
    ) {
      const name = node.childForFieldName('name');
      if (name) exported(name, node.childForFieldName('alias')?.text ?? name.text);
    }
    if (
      (node.type === 'identifier' || node.type === 'shorthand_property_identifier') &&
      !declarationNodes.has(node.id)
    ) {
      const id = stableBinding(node);
      if (id) active.references.add(id);
    }
    if (node.type === 'call_expression' && !node.hasError) {
      active.calls.push(node);
      allCalls.push(node);
    }
    for (let i = children.length - 1; i >= 0; i--)
      pending.push({
        node: children[i],
        parent: node,
        region: active,
        classRegion: entry.classRegion,
      });
  }
  for (const [id, count] of initialized) if (count > 1) invalid.add(id);
  for (const id of invalid) aliases.delete(id);
  for (const value of regions)
    for (const reference of value.references) {
      if (invalid.has(reference)) continue;
      const targets = boundRegions.get(reference);
      if (targets?.length === 1) value.edges.add(targets[0]);
    }
  const firstParameter = (fn: Node): string | undefined => {
    const first =
      fn.childForFieldName('parameter') ??
      fn.childForFieldName('parameters')?.namedChildren.find((child) => child.type !== 'comment') ??
      null;
    const name = parameterPattern(first);
    if (name?.type !== 'identifier') return undefined;
    const id = stableBinding(name, false);
    return id && !invalid.has(id) ? id : undefined;
  };
  const argumentBindings = new Map<number, ReadonlySet<string>>();
  const carried = (argument: Node | undefined): ReadonlySet<string> => {
    if (!argument) return new Set();
    const cached = argumentBindings.get(argument.id);
    if (cached) return cached;
    const result = new Set<string>();
    const pending = ['identifier', 'template_string', 'binary_expression'].includes(argument.type)
      ? [argument]
      : [];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'identifier') {
        const id = stableBinding(node);
        if (id && !invalid.has(id)) result.add(id);
      } else if (!LEXICAL_FUNCTION_TYPES.has(node.type)) pending.push(...node.namedChildren);
    }
    argumentBindings.set(argument.id, result);
    return result;
  };
  const findFunction = (definition: Node, nameNode?: Node): Node | undefined => {
    // A declaration list can hold several declarators; follow the captured one.
    const declarator = nameNode && parents.get(nameNode.id);
    let node: Node | null =
      declarator?.type === 'variable_declarator' &&
      declarator.childForFieldName('name')?.id === nameNode!.id
        ? declarator
        : definition;
    while (node && !callableRegions.has(node.id)) {
      node = unwrap(
        node.childForFieldName('declaration') ??
          node.childForFieldName('value') ??
          node.namedChildren.find((child) => child.type === 'variable_declarator') ??
          null,
      );
    }
    return node ?? undefined;
  };
  const contains = (outer: Node, inner: Node) =>
    outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
  interface CallEvidence {
    region: Region;
    argument?: Node;
    callee: Node | null;
    name: string;
    seed: boolean;
  }
  const directSeeds = new Set<Region>();
  const parameterCalls = new Map<string, CallEvidence[]>();
  for (const region of regions)
    for (const call of region.calls) {
      const callee = unwrap(call.childForFieldName('function'));
      const name = calleeName(callee);
      if (!name) continue;
      const argument = call
        .childForFieldName('arguments')
        ?.namedChildren.find((child) => child.type !== 'comment');
      const alias = callee?.type === 'identifier' ? stableBinding(callee) : undefined;
      const seed = platformFetch(callee) || !!(alias && aliases.has(alias));
      if (seed) directSeeds.add(region);
      const evidence = { region, argument, callee, name, seed };
      for (const id of carried(argument)) {
        const bucket = parameterCalls.get(id);
        if (bucket) bucket.push(evidence);
        else parameterCalls.set(id, [evidence]);
      }
    }
  // A nested region's seed and outward references are reusable for every
  // enclosing definition. Sibling references escape a helper summary and are
  // followed only when analyzing a region that actually contains both helpers.
  interface Summary {
    seed: boolean;
    external: Set<Region>;
  }
  const summaries = new Map<Region, Summary>();
  const summarize = (root: Region): Summary => {
    const cached = summaries.get(root);
    if (cached) return cached;
    const result: Summary = { seed: directSeeds.has(root), external: new Set() };
    const seen = new Set<Region>([root]);
    const queue = [...root.edges];
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i];
      if (seen.has(next)) continue;
      seen.add(next);
      if (!contains(root.node, next.node)) {
        result.external.add(next);
        continue;
      }
      const child = summarize(next);
      result.seed ||= child.seed;
      queue.push(...child.external);
    }
    summaries.set(root, result);
    return result;
  };
  const factsCache = new Map<number, FetchWrapperFacts>();
  const facts: FetchWrapperContext['facts'] = (definition, nameNode) => {
    const fn = findFunction(definition, nameNode);
    if (!fn) return undefined;
    const cached = factsCache.get(fn.id);
    if (cached) return cached;
    const name = nameNode ?? storedName(fn, parents) ?? fn.childForFieldName('name');
    const id = name ? stableBinding(name, false) : undefined;
    const url = firstParameter(fn);
    const root = callableRegions.get(fn.id)!;
    const seed = summarize(root).seed;
    let forwardsUrl = false;
    const forwardsTo = new Map<string, ForwardedCallee>();
    let reachable: Set<Region> | undefined;
    const reaches = (target: Region): boolean => {
      if (target === root) return true;
      if (!contains(fn, target.node)) return false;
      if (!reachable) {
        reachable = new Set([root]);
        const queue = [root];
        for (let i = 0; i < queue.length; i++)
          for (const next of queue[i].edges) {
            if (contains(fn, next.node) && !reachable.has(next)) {
              reachable.add(next);
              queue.push(next);
            }
          }
      }
      return reachable.has(target);
    };
    for (const call of url ? (parameterCalls.get(url) ?? []) : []) {
      if (!reaches(call.region)) continue;
      if (call.seed) forwardsUrl = true;
      if (call.argument?.type === 'identifier') {
        const target = targetOf(call.callee);
        const forwarded = { callee: call.name, target };
        forwardsTo.set(JSON.stringify(forwarded), forwarded);
      }
    }
    const parent = parents.get(fn.id);
    const defaultExport =
      parent?.type === 'export_statement' &&
      parent.children.some((child) => child.type === 'default');
    const result: FetchWrapperFacts = {
      definitionId: `${filePath}:${fn.startPosition.row + lineOffset + 1}:${fn.startPosition.column}:${fn.endPosition.row + lineOffset + 1}:${fn.endPosition.column}`,
      ...(id ? { bindingId: id } : {}),
      moduleScope: defaultExport || (!!id && id.startsWith(`${parsedFile.moduleScope}\0`)),
      exportedNames: [
        ...new Set([...(id ? (exports.get(id) ?? []) : []), ...(defaultExport ? ['default'] : [])]),
      ],
      seed,
      forwardsUrl,
      forwardsTo: [...forwardsTo.values()],
    };
    factsCache.set(fn.id, result);
    return result;
  };
  return {
    bindings,
    facts,
    reexports: () => {
      const result: FetchWrapperReexport[] = [];
      for (const imported of parsedFile.parsedImports) {
        if ('typeOnly' in imported && imported.typeOnly) continue;
        if (imported.kind === 'reexport')
          result.push({
            filePath,
            exportedName: imported.localName,
            from: { specifier: imported.targetRaw, importedName: imported.importedName },
          });
        else if (imported.kind === 'wildcard')
          result.push({
            filePath,
            exportedName: '*',
            from: { specifier: imported.targetRaw, importedName: '*' },
          });
      }
      const star = result.some((reexport) => reexport.exportedName === '*');
      for (const [id, names] of exports) {
        const target = imports.get(id);
        for (const exportedName of names) {
          // `import { x } from './y'; export { x };` forwards the imported binding.
          if (target?.kind === 'import')
            result.push({
              filePath,
              exportedName,
              from: { specifier: target.specifier, importedName: target.importedName },
            });
          else if (star) result.push({ filePath, exportedName });
        }
      }
      return result;
    },
    calls: () => {
      const calls: FetchWrapperCall[] = [];
      for (const call of allCalls) {
        const argument = call
          .childForFieldName('arguments')
          ?.namedChildren.find((child) => child.type !== 'comment');
        if (argument?.type !== 'string' && argument?.type !== 'template_string') continue;
        const fetchURL = argument.text.slice(1, -1);
        if (!stripLeadingTemplatePrefix(fetchURL)?.startsWith('/')) continue;
        const callee = call.childForFieldName('function');
        const functionName = calleeName(callee);
        if (!functionName) continue;
        const target = targetOf(callee);
        calls.push({
          filePath,
          functionName,
          fetchURL,
          lineNumber: call.startPosition.row + lineOffset + 1,
          target,
        });
      }
      return calls;
    },
  };
}

export function extractFetchWrapperCalls(
  tree: Parser.Tree,
  parsedFile: ParsedFile,
  lineOffset: number,
): FetchWrapperCall[] {
  return createFetchWrapperContext(tree, parsedFile, lineOffset).calls();
}
export function fetchWrapperFacts(
  definition: Node,
  parsedFile: ParsedFile,
  lineOffset = 0,
): FetchWrapperFacts | undefined {
  return createFetchWrapperContext(definition.tree, parsedFile, lineOffset).facts(definition);
}
