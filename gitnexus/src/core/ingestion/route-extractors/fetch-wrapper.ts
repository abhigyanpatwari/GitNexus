/** Binding-aware HTTP evidence collected from the provider's existing AST. */
import type Parser from 'tree-sitter';
import type { ParsedFile } from 'gitnexus-shared';
import type { ExtractedFetchCall } from '../workers/parse-worker.js';
import { stripLeadingTemplatePrefix } from './route-path.js';
import {
  bindingKey,
  createLexicalBindings,
  importBindingKey,
  LEXICAL_FUNCTION_TYPES,
  parameterPattern,
  patternBindingNames,
  TRANSPARENT_EXPRESSION_TYPES,
  transparentInner,
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
  /** The forwarded export; absent for a local export, which shadows `export *`
   * and makes a star-exported name ambiguous when another module exports it too. */
  from?: { specifier: string; importedName: string };
}
export interface FetchWrapperContext {
  bindings: LexicalBindings;
  facts(definition: Node, nameNode?: Node): FetchWrapperFacts | undefined;
  calls(): FetchWrapperCall[];
  reexports(): FetchWrapperReexport[];
}

const firstNamed = (node: Node | null | undefined): Node | null =>
  node ? transparentInner(node) : null;

function calleeName(node: Parser.SyntaxNode | null): string | undefined {
  // The TS grammar puts `await f<T>(...)` inside the call's function field.
  while (node?.type === 'await_expression') node = firstNamed(node);
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
  while (node && (TRANSPARENT_EXPRESSION_TYPES.has(node.type) || node.type === 'await_expression'))
    node = firstNamed(node);
  return node;
}
const UNWRAPPED_TYPES: ReadonlySet<string> = new Set([
  ...TRANSPARENT_EXPRESSION_TYPES,
  'await_expression',
]);
const SKIPPED_TYPES: ReadonlySet<string> = new Set([
  'comment',
  'type_annotation',
  'type_parameters',
  'type_arguments',
  'import_statement',
]);
/** Node types whose handlers need the node itself; the walk reads others from the cursor. */
const INSPECTED_TYPES: ReadonlySet<string> = new Set([
  'variable_declarator',
  'required_parameter',
  'optional_parameter',
  'assignment_pattern',
  'catch_clause',
  'assignment_expression',
  'augmented_assignment_expression',
  'update_expression',
  'for_in_statement',
  'export_statement',
  'export_specifier',
  'call_expression',
]);
/** Fetch implementations imported from packages, by module specifier and export name.
 * A namespace or `require` value is recorded under the specifier itself. */
const FETCH_EXPORTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['node-fetch', new Set(['default', 'node-fetch'])],
  ['cross-fetch', new Set(['default', 'fetch', 'cross-fetch'])],
  ['isomorphic-fetch', new Set(['default', 'isomorphic-fetch'])],
  ['whatwg-fetch', new Set(['fetch'])],
  ['undici', new Set(['fetch'])],
]);

interface Region {
  node: Node;
  edges: Set<Region>;
  calls: Node[];
}
/** A visited ancestor of the cursor. */
interface Frame {
  type: string;
  /** Whether it is its parent's first non-comment named child, which `unwrap` follows. */
  first: boolean;
  /** Its field in the parent; read only for nodes a stored binding may be found through. */
  field?: string;
  /** Present only for node types whose handlers inspect the node. */
  node?: Node;
  region: Region;
  classRegion?: Region;
  /** How children are assigned regions: `inner` is the callable or the deferred class body. */
  children: 'plain' | 'callable' | 'class' | 'field';
  inner: Region;
  isStatic?: boolean;
  defaultExport?: boolean;
  /** Whether a non-comment named child has been visited. */
  named: boolean;
  /** Inside an instance-field initializer, which runs at construction, after the module body. */
  deferred?: boolean;
  /** Inside recovered syntax: only complete calls are trusted there. */
  error?: boolean;
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
    // `export { x } from` declares no local binding; reexports() reads it directly.
    if (!('localName' in imported) || !('importedName' in imported) || imported.kind === 'reexport')
      continue;
    const id = importBindingKey(parsedFile, imported);
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
  // `atUse` is false for code that runs after the module body, where a later
  // declaration is already initialized.
  const targetOf = (callee: Node | null, atUse = true): CalleeTarget => {
    const node = unwrap(callee);
    if (!node) return { kind: 'blocked' };
    if (node.type === 'member_expression') return { kind: 'member' };
    if (node.type !== 'identifier') return { kind: 'blocked' };
    const owner = bindings.ownership(node, node.text, atUse);
    if (owner?.status === 'absent') return { kind: 'unresolved' };
    const id = stableBinding(node, atUse);
    return id && !invalid.has(id)
      ? (imports.get(id) ?? { kind: 'binding', bindingId: id })
      : { kind: 'blocked' };
  };
  const platformFetch = (expression: Node | null): boolean => {
    const node = unwrap(expression);
    if (!node) return false;
    if (node.type === 'identifier') {
      if (node.text === 'fetch' && bindings.isGlobal(node, 'fetch')) return true;
      const id = stableBinding(node);
      const imported = id && !invalid.has(id) ? imports.get(id) : undefined;
      return (
        imported?.kind === 'import' &&
        (FETCH_EXPORTS.get(imported.specifier)?.has(imported.importedName) ?? false)
      );
    }
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
    // An explicit stack: generated `a ?? b ?? …` chains can be thousands deep.
    const pending = [expression];
    while (pending.length > 0) {
      const node = unwrap(pending.pop() ?? null);
      if (!node) continue;
      if (node.type === 'binary_expression') {
        const operator = node.childForFieldName('operator')?.text;
        if (operator === '??' || operator === '||')
          pending.push(node.childForFieldName('right'), node.childForFieldName('left'));
      } else if (node.type === 'ternary_expression')
        pending.push(node.childForFieldName('alternative'), node.childForFieldName('consequence'));
      else if (platformFetch(node)) return true;
    }
    return false;
  };
  const regions: Region[] = [];
  const callableRegions = new Map<number, Region>();
  const boundRegions = new Map<string, Region[]>();
  // Declared identifiers by start offset: leaves never share one, and the
  // walk can test an offset without materializing the node.
  const declarations = new Set<number>();
  const aliases = new Set<string>();
  const invalid = new Set<string>();
  const initialized = new Map<string, number>();
  const parameters = new Set<string>();
  const exports = new Map<string, Set<string>>();
  const boundNames = new Set<string>();
  // Identifier text and offsets only: most references never name a bound
  // callable, so their nodes are never materialized.
  const references: {
    text: string;
    start: number;
    end: number;
    region: Region;
    deferred?: boolean;
  }[] = [];
  const allCalls: Node[] = [];
  const deferredCalls = new Set<Node>();
  // Native parent lookup descends from the tree root, so the walk records the
  // ancestor facts that later queries need.
  const storedNames = new Map<number, Node | null>();
  const defaultExports = new Set<number>();
  const declarators = new Map<number, Node>();
  const region = (node: Node): Region => {
    const result = {
      node,
      edges: new Set<Region>(),
      calls: [] as Node[],
    };
    regions.push(result);
    return result;
  };
  const bindRegion = (name: Node | null, value: Region) => {
    if (!name || !['identifier', 'type_identifier'].includes(name.type)) return;
    declarations.add(name.startIndex);
    boundNames.add(name.text);
    const id = stableBinding(name, false);
    if (!id) return;
    const bucket = boundRegions.get(id);
    if (bucket) bucket.push(value);
    else boundRegions.set(id, [value]);
  };
  const markPattern = (pattern: Node | null) => {
    const names = patternBindingNames(pattern);
    for (const name of names) declarations.add(name.startIndex);
    return names;
  };
  const invalidate = (pattern: Node | null) => {
    for (const name of patternBindingNames(pattern)) {
      declarations.add(name.startIndex);
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
  // Values exported inline by CommonJS assignments; resolved to callables after the walk.
  const exportedValues: { value: Node; name: string }[] = [];
  const exportValue = (value: Node | null, name: string) => {
    const node = unwrap(value);
    if (node?.type === 'identifier' || node?.type === 'shorthand_property_identifier')
      exported(node, name);
    else if (node) exportedValues.push({ value: node, name });
  };
  const commonJsGlobal = (node: Node | null, name: string) =>
    node?.type === 'identifier' && node.text === name && bindings.isGlobal(node, name);
  const moduleExports = (node: Node | null) =>
    node?.type === 'member_expression' &&
    node.childForFieldName('property')?.text === 'exports' &&
    commonJsGlobal(node.childForFieldName('object'), 'module');
  // `module.exports = …`, `module.exports.name = …` and `exports.name = …`.
  const commonJsExport = (left: Node | null, right: Node | null) => {
    if (left?.type !== 'member_expression') return;
    if (moduleExports(left)) {
      const value = unwrap(right);
      if (value?.type !== 'object') return exportValue(value, 'default');
      for (const member of value.namedChildren) {
        if (member.type === 'shorthand_property_identifier') exported(member, member.text);
        else if (member.type === 'pair') {
          const key = member.childForFieldName('key');
          const name =
            key?.type === 'property_identifier'
              ? key.text
              : key?.type === 'string'
                ? key.namedChildren.find((child) => child.type === 'string_fragment')?.text
                : undefined;
          if (name) exportValue(member.childForFieldName('value'), name);
        }
      }
      return;
    }
    const object = left.childForFieldName('object');
    const property = left.childForFieldName('property');
    if (
      property?.type === 'property_identifier' &&
      (commonJsGlobal(object, 'exports') || moduleExports(object))
    )
      exportValue(right, property.text);
  };
  // The binding a callable or class value is stored into. Ancestors that only
  // wrap the value (`(fn)`, `fn as T`, `await fn`) are climbed first.
  const storedAt = (frames: readonly Frame[], first: boolean, field?: string): Node | null => {
    let i = frames.length - 1;
    while (first && UNWRAPPED_TYPES.has(frames[i].type)) {
      ({ first, field } = frames[i]);
      i--;
    }
    const { type, node } = frames[i];
    if (!node) return null;
    if (type === 'variable_declarator' && field === 'value') return node.childForFieldName('name');
    if (type === 'assignment_pattern' && field === 'right') return node.childForFieldName('left');
    if ((type === 'required_parameter' || type === 'optional_parameter') && field === 'value')
      return parameterPattern(node);
    return null;
  };
  // A cursor walk reads types and offsets without materializing every node;
  // only the node types the handlers inspect become SyntaxNodes.
  const rootNode = tree.rootNode;
  const rootRegion = region(rootNode);
  const frames: Frame[] = [
    {
      type: rootNode.type,
      first: false,
      node: rootNode,
      region: rootRegion,
      children: 'plain',
      inner: rootRegion,
      named: false,
      error: rootNode.type === 'ERROR',
    },
  ];
  const cursor = tree.walk();
  const enter = (): Frame | undefined => {
    if (!cursor.nodeIsNamed) return undefined;
    const type = cursor.nodeType;
    const parent = frames[frames.length - 1];
    // `unwrap` skips comments and the type arguments of `<T>value`.
    const counted = type !== 'comment' && type !== 'type_arguments';
    const first = counted && !parent.named;
    if (counted) parent.named = true;
    if (SKIPPED_TYPES.has(type)) return undefined;
    if (parent.error || type === 'ERROR') {
      // Recovered syntax can still hold complete calls; nothing else in it is trusted.
      if (type === 'call_expression') {
        const node = cursor.currentNode;
        if (!node.hasError) allCalls.push(node);
      }
      return {
        type,
        first,
        region: parent.region,
        children: 'plain',
        inner: parent.region,
        named: false,
        error: true,
      };
    }
    // Computed names and decorators are evaluated where the member is created;
    // other method and instance-field code runs later, in its own region.
    const evaluated = type === 'computed_property_name' || type === 'decorator';
    const active =
      parent.children === 'callable' && !evaluated
        ? parent.inner
        : parent.children === 'field' && !evaluated && !parent.isStatic
          ? (parent.classRegion ?? parent.region)
          : parent.region;
    const classRegion =
      parent.children === 'class'
        ? parent.inner
        : parent.children === 'plain'
          ? parent.classRegion
          : undefined;
    const deferred =
      parent.deferred || (parent.children === 'field' && !parent.isStatic && !evaluated);
    if (type === 'identifier' || type === 'shorthand_property_identifier') {
      if (!declarations.has(cursor.startIndex))
        references.push({
          text: cursor.nodeText,
          start: cursor.startIndex,
          end: cursor.endIndex,
          region: active,
          deferred,
        });
      return undefined;
    }
    const frame: Frame = {
      type,
      first,
      region: active,
      classRegion,
      children: 'plain',
      inner: active,
      named: false,
      deferred,
    };
    if (LEXICAL_FUNCTION_TYPES.has(type)) {
      const node = cursor.currentNode;
      // A bodyless overload or ambient signature declares no separate callable:
      // its implementation alone owns the binding.
      if (!node.childForFieldName('body')) return undefined;
      const id = node.id;
      const callable = region(node);
      callableRegions.set(id, callable);
      const name = node.childForFieldName('name');
      const stored = storedAt(frames, first, cursor.currentFieldName);
      storedNames.set(id, stored);
      if (parent.defaultExport) defaultExports.add(id);
      const declaration =
        type === 'function_declaration' || type === 'generator_function_declaration';
      bindRegion(declaration ? name : stored, callable);
      if (!declaration && name?.type === 'identifier') bindRegion(name, callable);
      if (name) declarations.add(name.startIndex);
      if (type === 'method_definition') (classRegion ?? active).edges.add(callable);
      else if (!declaration && !stored) active.edges.add(callable);
      if (declaration && name) {
        const nameId = stableBinding(name, false);
        if (nameId) {
          // A declaration initializes its binding, so a `var` initializer rebinds it.
          initialized.set(nameId, (initialized.get(nameId) ?? 0) + 1);
          if (parameters.has(nameId)) invalid.add(nameId);
        }
      }
      const formals = node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
      for (const formal of markPattern(formals)) {
        const formalId = stableBinding(formal, false);
        if (formalId) parameters.add(formalId);
      }
      return { ...frame, children: 'callable', inner: callable };
    }
    if (type === 'class_declaration' || type === 'class') {
      const node = cursor.currentNode;
      const deferred = region(node);
      const name = node.childForFieldName('name');
      const stored = storedAt(frames, first, cursor.currentFieldName);
      bindRegion(stored ?? name, deferred);
      if (stored && name) bindRegion(name, deferred);
      if (!stored && !name) active.edges.add(deferred);
      return { ...frame, children: 'class', inner: deferred };
    }
    if (type === 'field_definition' || type === 'public_field_definition') {
      const isStatic = cursor.currentNode.children.some((child) => child.type === 'static');
      return { ...frame, children: 'field', isStatic };
    }
    if (UNWRAPPED_TYPES.has(type)) frame.field = cursor.currentFieldName;
    if (!INSPECTED_TYPES.has(type)) return frame;
    const node = cursor.currentNode;
    frame.node = node;
    if (type === 'variable_declarator') {
      const name = node.childForFieldName('name');
      if (name) declarators.set(name.id, node);
      initialize(name, node.childForFieldName('value'));
    } else if (type === 'required_parameter' || type === 'optional_parameter')
      initialize(parameterPattern(node), node.childForFieldName('value'), true);
    else if (type === 'assignment_pattern')
      initialize(node.childForFieldName('left'), node.childForFieldName('right'), true);
    else if (type === 'catch_clause') markPattern(node.childForFieldName('parameter'));
    else if (type === 'assignment_expression') {
      invalidate(node.childForFieldName('left'));
      commonJsExport(node.childForFieldName('left'), node.childForFieldName('right'));
    } else if (type === 'augmented_assignment_expression')
      invalidate(node.childForFieldName('left'));
    else if (type === 'update_expression') invalidate(node.childForFieldName('argument'));
    else if (type === 'for_in_statement') {
      const left = node.childForFieldName('left');
      if (node.childForFieldName('kind')) markPattern(left);
      invalidate(left);
    } else if (type === 'export_statement') {
      const declaration = node.childForFieldName('declaration');
      const value = node.childForFieldName('value');
      const isDefault = node.children.some((child) => child.type === 'default');
      frame.defaultExport = isDefault;
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
      type === 'export_specifier' &&
      // `export { x } from './y'` declares no local export.
      !frames[frames.length - 2]?.node?.childForFieldName('source')
    ) {
      const name = node.childForFieldName('name');
      if (name) exported(name, node.childForFieldName('alias')?.text ?? name.text);
    } else if (type === 'call_expression' && !node.hasError) {
      active.calls.push(node);
      allCalls.push(node);
      if (deferred) deferredCalls.add(node);
    }
    return frame;
  };
  for (let more = !SKIPPED_TYPES.has(rootNode.type) && cursor.gotoFirstChild(); more; ) {
    const frame = enter();
    if (frame) {
      frames.push(frame);
      if (cursor.gotoFirstChild()) continue;
      frames.pop();
    }
    while (more && !cursor.gotoNextSibling()) {
      cursor.gotoParent();
      frames.pop();
      more = frames.length > 0;
    }
  }
  for (const [id, count] of initialized) if (count > 1) invalid.add(id);
  for (const id of invalid) aliases.delete(id);
  // Only references naming a bound callable or class can add an edge, so other
  // identifiers skip the lexical lookup.
  for (const { text, start, end, region: owner, deferred } of references) {
    if (!boundNames.has(text)) continue;
    const id = stableBinding(rootNode.descendantForIndex(start, end), !deferred);
    if (!id || invalid.has(id)) continue;
    const targets = boundRegions.get(id);
    if (targets?.length === 1) owner.edges.add(targets[0]);
  }
  const firstParameter = (fn: Node): string | undefined => {
    const first =
      fn.childForFieldName('parameter') ?? firstNamed(fn.childForFieldName('parameters'));
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
    const stack = ['identifier', 'template_string', 'binary_expression'].includes(argument.type)
      ? [argument]
      : [];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === 'identifier') {
        const id = stableBinding(node);
        if (id && !invalid.has(id)) result.add(id);
      } else if (!LEXICAL_FUNCTION_TYPES.has(node.type))
        for (const child of node.namedChildren) stack.push(child);
    }
    argumentBindings.set(argument.id, result);
    return result;
  };
  const findFunction = (definition: Node, nameNode?: Node): Node | undefined => {
    // A declaration list can hold several declarators; follow the captured one.
    let node: Node | null = (nameNode && declarators.get(nameNode.id)) ?? definition;
    while (node && !callableRegions.has(node.id)) {
      node = unwrap(
        node.type === 'call_expression'
          ? // A higher-order wrapper (`useCallback((url) => …)`) defines its callable argument.
            (node.childForFieldName('arguments')?.namedChildren.find((child) => {
              const value = unwrap(child);
              return !!value && (callableRegions.has(value.id) || value.type === 'call_expression');
            }) ?? null)
          : (node.childForFieldName('declaration') ??
              node.childForFieldName('value') ??
              // `exports.x = function …` is captured as its assignment.
              node.childForFieldName('right') ??
              node.namedChildren.find((child) => child.type === 'variable_declarator') ??
              null),
      );
    }
    return node ?? undefined;
  };
  const inlineExports = new Map<number, string[]>();
  for (const { value, name } of exportedValues) {
    const fn = findFunction(value);
    if (fn) inlineExports.set(fn.id, [...(inlineExports.get(fn.id) ?? []), name]);
  }
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
  for (const owner of regions)
    for (const call of owner.calls) {
      const callee = unwrap(call.childForFieldName('function'));
      const name = calleeName(callee);
      if (!name) continue;
      const argument = firstNamed(call.childForFieldName('arguments')) ?? undefined;
      const alias = callee?.type === 'identifier' ? stableBinding(callee) : undefined;
      const seed = platformFetch(callee) || !!(alias && aliases.has(alias));
      if (seed) directSeeds.add(owner);
      const evidence = { region: owner, argument, callee, name, seed };
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
  interface SummaryFrame {
    root: Region;
    result: Summary;
    seen: Set<Region>;
    queue: Region[];
    cursor: number;
  }
  const openSummary = (root: Region): SummaryFrame => ({
    root,
    result: { seed: directSeeds.has(root), external: new Set() },
    seen: new Set([root]),
    queue: [...root.edges],
    cursor: 0,
  });
  const absorb = (frame: SummaryFrame, child: Summary) => {
    frame.result.seed ||= child.seed;
    for (const next of child.external) frame.queue.push(next);
  };
  // Explicit frames instead of recursion: nested regions are summarized first,
  // so nesting depth cannot exhaust the call stack.
  const summarize = (start: Region): Summary => {
    const cached = summaries.get(start);
    if (cached) return cached;
    const frames = [openSummary(start)];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      let nested: Region | undefined;
      while (frame.cursor < frame.queue.length) {
        const next = frame.queue[frame.cursor++];
        if (frame.seen.has(next)) continue;
        frame.seen.add(next);
        if (!contains(frame.root.node, next.node)) {
          frame.result.external.add(next);
          continue;
        }
        const child = summaries.get(next);
        if (child) absorb(frame, child);
        else {
          nested = next;
          break;
        }
      }
      if (nested) {
        frames.push(openSummary(nested));
        continue;
      }
      summaries.set(frame.root, frame.result);
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) absorb(parent, frame.result);
    }
    return summaries.get(start)!;
  };
  const factsCache = new Map<string, FetchWrapperFacts>();
  const facts: FetchWrapperContext['facts'] = (definition, nameNode) => {
    const fn = findFunction(definition, nameNode);
    if (!fn) return undefined;
    // The name node picks the binding, so it is part of the key.
    const key = `${fn.id}\0${nameNode?.id ?? ''}`;
    const cached = factsCache.get(key);
    if (cached) return cached;
    // Only a binding identifier names a lexical binding; object keys and
    // method names are properties.
    const candidate = nameNode ?? storedNames.get(fn.id) ?? fn.childForFieldName('name');
    const name = candidate?.type === 'identifier' ? candidate : undefined;
    const id = name ? stableBinding(name, false) : undefined;
    const inline = inlineExports.get(fn.id) ?? [];
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
    const defaultExport = defaultExports.has(fn.id);
    // A rebound binding no longer names this function, so it proves no wrapper
    // across files either; its names are kept so they still collide.
    const rebound = !!id && invalid.has(id);
    const result: FetchWrapperFacts = {
      definitionId: `${filePath}:${fn.startPosition.row + lineOffset + 1}:${fn.startPosition.column}:${fn.endPosition.row + lineOffset + 1}:${fn.endPosition.column}`,
      ...(id ? { bindingId: id } : {}),
      moduleScope:
        defaultExport ||
        inline.length > 0 ||
        (!!name && id === bindingKey(parsedFile.moduleScope, name.text)),
      exportedNames: [
        ...new Set([
          ...(id ? (exports.get(id) ?? []) : []),
          ...inline,
          ...(defaultExport ? ['default'] : []),
        ]),
      ],
      seed: seed && !rebound,
      forwardsUrl: forwardsUrl && !rebound,
      forwardsTo: rebound ? [] : [...forwardsTo.values()],
    };
    factsCache.set(key, result);
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
      for (const [id, names] of exports) {
        const target = imports.get(id);
        for (const exportedName of names)
          result.push(
            // `import { x } from './y'; export { x };` forwards the imported binding.
            target?.kind === 'import'
              ? {
                  filePath,
                  exportedName,
                  from: { specifier: target.specifier, importedName: target.importedName },
                }
              : { filePath, exportedName },
          );
      }
      return result;
    },
    calls: () => {
      const calls: FetchWrapperCall[] = [];
      for (const call of allCalls) {
        const argument = firstNamed(call.childForFieldName('arguments'));
        if (argument?.type !== 'string' && argument?.type !== 'template_string') continue;
        const fetchURL = argument.text.slice(1, -1);
        if (!stripLeadingTemplatePrefix(fetchURL)?.startsWith('/')) continue;
        const callee = call.childForFieldName('function');
        const functionName = calleeName(callee);
        if (!functionName) continue;
        const target = targetOf(callee, !deferredCalls.has(call));
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
