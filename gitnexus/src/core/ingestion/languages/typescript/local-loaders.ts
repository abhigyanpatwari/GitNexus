/** Lexical names and statically named loaders shared by TS, JS, and Vue scripts. */
import {
  makeScopeId,
  type Capture,
  type CaptureMatch,
  type NameClaim,
  type Range,
  type ScopeKind,
} from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { canonicalTypeScriptName } from './identifiers.js';

const FUNCTION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
  'method_signature',
  'abstract_method_signature',
]);
const SCOPE_TAGS: Readonly<Record<string, ScopeKind>> = {
  '@scope.module': 'Module',
  '@scope.namespace': 'Namespace',
  '@scope.class': 'Class',
  '@scope.function': 'Function',
  '@scope.block': 'Block',
  '@scope.object': 'Object',
};
interface LexicalScope {
  readonly anchor: Capture;
  readonly kind: ScopeKind;
  readonly matchIndex: number;
  node?: SyntaxNode;
  parent?: LexicalScope;
  readonly claims: NameClaim[];
  readonly names: Set<string>;
}
interface LocatedNode {
  readonly node: SyntaxNode;
  readonly scope: LexicalScope;
}
interface InstanceofGuard {
  readonly name: string;
  readonly type: SyntaxNode;
  readonly consequence: SyntaxNode;
  readonly scope: LexicalScope;
  readonly uses: Array<LocatedNode & { readonly receiver: SyntaxNode }>;
}
type BindingWrite = LocatedNode & {
  readonly name: string;
  readonly executionScope: LexicalScope;
};
type WriteSite = LocatedNode & { readonly names: readonly SyntaxNode[] };

interface BindingWrites {
  readonly nodes: SyntaxNode[];
  readonly executionScopes: Set<LexicalScope>;
}
const rangeKey = (range: Range) =>
  `${range.startLine}:${range.startCol}-${range.endLine}:${range.endCol}`;
const scopeKey = (range: Range, kind: ScopeKind) => `${kind}:${rangeKey(range)}`;
const rangeOf = (node: SyntaxNode): Range => {
  const start = node.startPosition;
  const end = node.endPosition;
  return {
    startLine: start.row + 1,
    startCol: start.column,
    endLine: end.row + 1,
    endCol: end.column,
  };
};
const atEnd = (node: SyntaxNode) => ({
  startLine: node.endPosition.row + 1,
  startCol: node.endPosition.column,
});

/** Binding patterns, not arbitrary descendants: object keys and default RHSs do not bind. */
function boundNames(node: SyntaxNode | null): SyntaxNode[] {
  if (node === null) return [];
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'shorthand_property_identifier_pattern':
      return [node];
    case 'required_parameter':
    case 'optional_parameter':
      return boundNames(node.childForFieldName('pattern'));
    case 'pair_pattern':
      return boundNames(node.childForFieldName('value'));
    case 'assignment_pattern':
    case 'object_assignment_pattern':
      return boundNames(node.childForFieldName('left'));
    case 'rest_pattern':
      return boundNames(node.firstNamedChild);
    case 'object_pattern':
    case 'array_pattern':
    case 'formal_parameters':
      return node.namedChildren.flatMap(boundNames);
    default:
      return [];
  }
}

function functionOwner(scope: LexicalScope): LexicalScope {
  let current = scope;
  while (
    current.parent &&
    current.kind !== 'Function' &&
    current.kind !== 'Module' &&
    current.kind !== 'Namespace'
  )
    current = current.parent;
  return current;
}
function bindingOwner(
  scope: LexicalScope,
  name: string,
  escapedNames?: ReadonlyMap<LexicalScope, ReadonlySet<string>>,
): LexicalScope | undefined {
  for (let current: LexicalScope | undefined = scope; current; current = current.parent) {
    if (current.names.has(name) || escapedNames?.get(current)?.has(name)) return current;
  }
  return undefined;
}
function extraBlock(node: SyntaxNode): boolean {
  return (
    node.type === 'catch_clause' ||
    node.type === 'switch_body' ||
    (node.type === 'for_in_statement' &&
      ['let', 'const'].includes(node.childForFieldName('kind')?.text ?? '')) ||
    (node.type === 'for_statement' &&
      node.childForFieldName('initializer')?.type === 'lexical_declaration')
  );
}
function nodeScopeKind(node: SyntaxNode): ScopeKind | undefined {
  if (FUNCTION_TYPES.has(node.type)) return 'Function';
  switch (node.type) {
    case 'program':
      return 'Module';
    case 'internal_module':
      return 'Namespace';
    case 'class':
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'interface_declaration':
    case 'enum_declaration':
    case 'type_alias_declaration':
      return 'Class';
    case 'object':
      return 'Object';
    case 'statement_block':
      return 'Block';
    default:
      return extraBlock(node) ? 'Block' : undefined;
  }
}
/** A hoisted var initialized conditionally cannot prove a namespace value. */
function conditionalVar(node: SyntaxNode, owner: LexicalScope): boolean {
  if (node.parent?.type !== 'variable_declaration') return false;
  for (
    let current = node.parent.parent;
    current && current.id !== owner.node?.id;
    current = current.parent
  ) {
    if (
      [
        'if_statement',
        'switch_case',
        'switch_default',
        'for_statement',
        'for_in_statement',
        'while_statement',
        'do_statement',
        'catch_clause',
        'try_statement',
      ].includes(current.type)
    )
      return true;
  }
  return false;
}

function readInstanceofGuard(node: SyntaxNode, scope: LexicalScope): InstanceofGuard | undefined {
  let condition = node.childForFieldName('condition');
  while (condition?.type === 'parenthesized_expression') {
    condition = condition.namedChildren.find((child) => child.type !== 'comment') ?? null;
  }
  if (
    condition?.type !== 'binary_expression' ||
    condition.childForFieldName('operator')?.type !== 'instanceof'
  )
    return undefined;
  const value = condition.childForFieldName('left');
  const type = condition.childForFieldName('right');
  const consequence = node.childForFieldName('consequence');
  if (value?.type !== 'identifier' || type?.type !== 'identifier' || !consequence) return undefined;
  return { name: canonicalTypeScriptName(value.text), type, consequence, scope, uses: [] };
}

function unwrapWriteTarget(target: SyntaxNode | null): SyntaxNode | null {
  while (
    target?.type === 'parenthesized_expression' ||
    target?.type === 'non_null_expression' ||
    target?.type === 'as_expression' ||
    target?.type === 'satisfies_expression' ||
    target?.type === 'type_assertion'
  ) {
    target =
      target.namedChildren.find(
        (child) => child.type !== 'comment' && child.type !== 'type_arguments',
      ) ?? null;
  }
  return target;
}

function readWriteSite(
  node: SyntaxNode,
  scope: LexicalScope,
  target: SyntaxNode | null,
): WriteSite | undefined {
  const names = boundNames(unwrapWriteTarget(target));
  return names.length > 0 ? { node, scope, names } : undefined;
}

/** A top-level comma sequence evaluates its operands in order. */
function sequenceWriteStart(statement: SyntaxNode, write: SyntaxNode): number | undefined {
  let expression =
    statement.type === 'expression_statement'
      ? (statement.namedChildren.find((child) => child.type !== 'comment') ?? null)
      : statement;
  while (expression?.type === 'parenthesized_expression') {
    expression = expression.namedChildren.find((child) => child.type !== 'comment') ?? null;
  }
  if (expression?.type !== 'sequence_expression') return undefined;
  for (let operand = write; operand.parent; operand = operand.parent) {
    if (operand.parent.id === expression.id) return operand.startIndex;
    if (operand.id === expression.id) break;
  }
  return undefined;
}

/** First possible write, with statement-level cutoffs for control-flow backedges. */
function narrowingCutoff(guard: InstanceofGuard, writes: readonly SyntaxNode[]): number {
  const { consequence } = guard;
  let low = 0;
  let high = writes.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (writes[mid].startIndex < consequence.startIndex) low = mid + 1;
    else high = mid;
  }
  const write = writes[low];
  if (!write || write.startIndex >= consequence.endIndex) return consequence.endIndex;
  if (consequence.type !== 'statement_block' && consequence.type !== 'expression_statement') {
    return consequence.startIndex;
  }
  let statement = write;
  if (statement.id === consequence.id) return consequence.startIndex;
  for (
    let parent = statement.parent;
    parent && parent.id !== consequence.id;
    parent = parent.parent
  )
    statement = parent;
  if (consequence.type === 'statement_block' || consequence.type === 'expression_statement') {
    // With a block consequence, only the direct expression statement is
    // ordered here. A write inside a loop can affect earlier sites on another iteration.
    if (statement.type === 'expression_statement' || consequence.type === 'expression_statement') {
      return sequenceWriteStart(statement, write) ?? statement.startIndex;
    }
  }
  return statement.startIndex;
}

function indexBindingWrites(writes: readonly BindingWrite[]) {
  const writesByOwner = new Map<LexicalScope, Map<string, BindingWrites>>();
  for (const { scope, name, node, executionScope } of writes) {
    let byName = writesByOwner.get(scope);
    if (!byName) {
      byName = new Map();
      writesByOwner.set(scope, byName);
    }
    let binding = byName.get(name);
    if (!binding) {
      binding = { nodes: [], executionScopes: new Set() };
      byName.set(name, binding);
    }
    binding.nodes.push(node);
    binding.executionScopes.add(executionScope);
  }
  return writesByOwner;
}

function emitInstanceofNarrowings(
  guards: readonly InstanceofGuard[],
  writes: readonly BindingWrite[],
  filePath: string,
  out: CaptureMatch[],
  escapedNames: ReadonlyMap<LexicalScope, ReadonlySet<string>>,
): void {
  if (guards.length === 0) return;
  const writesByOwner = indexBindingWrites(writes);
  for (const guard of guards) {
    if (guard.uses.length === 0) continue;
    const { name, type, scope } = guard;
    const owner = bindingOwner(scope, name, escapedNames);
    if (!owner) continue;
    const functionScope = functionOwner(scope);
    const bindingWrites = writesByOwner.get(owner)?.get(name);
    // A closure can write this binding through a call at an unknown position.
    if (
      bindingWrites &&
      (bindingWrites.executionScopes.size !== 1 ||
        !bindingWrites.executionScopes.has(functionScope))
    )
      continue;
    const cutoff = narrowingCutoff(guard, bindingWrites?.nodes ?? []);
    const lookupScope = makeScopeId({
      filePath,
      range: scope.anchor.range,
      kind: scope.kind,
    });
    for (const { node, scope: atUse, receiver } of guard.uses) {
      if (
        node.startIndex >= cutoff ||
        (bindingWrites && functionOwner(atUse) !== functionScope) ||
        bindingOwner(atUse, name, escapedNames) !== owner
      )
        continue;
      // Anchor only the member expression, so the fact cannot leak to other
      // statements or become a new home for a lexical declaration. The
      // receiver range is strictly inside this scope and will not auto-hoist.
      out.push(
        { '@scope.block': syntheticCapture('@scope.block', node, '') },
        {
          '@type-binding.name': nodeToCapture('@type-binding.name', receiver),
          '@type-binding.type': nodeToCapture('@type-binding.type', type),
          '@type-binding.instanceof-narrow': syntheticCapture(
            '@type-binding.instanceof-narrow',
            receiver,
            '1',
          ),
          // The constructor is a value read in the guard's scope.
          '@type-binding.constructor': syntheticCapture('@type-binding.constructor', receiver, ''),
          '@type.lookup-scope': syntheticCapture('@type.lookup-scope', receiver, lookupScope),
        },
      );
    }
  }
}

function indexEscapedNames(scopes: Iterable<LexicalScope>) {
  const escapedNames = new Map<LexicalScope, Set<string>>();
  for (const scope of scopes) {
    for (const name of scope.names) {
      if (!name.includes('\\')) continue;
      let names = escapedNames.get(scope);
      if (!names) {
        names = new Set();
        escapedNames.set(scope, names);
      }
      names.add(canonicalTypeScriptName(name));
    }
  }
  return escapedNames;
}

/** Observe narrowing events during the same tree walk as loader discovery. */
function createInstanceofNarrowingCollector() {
  const writes: WriteSite[] = [];
  const guards: InstanceofGuard[] = [];
  const pending = new Map<number, InstanceofGuard>();
  const active: Array<{ guard: InstanceofGuard; outer?: InstanceofGuard }> = [];
  const byName = new Map<string, InstanceofGuard>();
  function updateActiveGuards(node: SyntaxNode): void {
    while (active.length > 0 && node.startIndex >= active.at(-1)!.guard.consequence.endIndex) {
      const { guard, outer } = active.pop()!;
      if (outer) byName.set(guard.name, outer);
      else byName.delete(guard.name);
    }
    const begins = pending.size > 0 ? pending.get(node.id) : undefined;
    if (begins) {
      pending.delete(node.id);
      active.push({ guard: begins, outer: byName.get(begins.name) });
      byName.set(begins.name, begins);
    }
  }
  return {
    writes,
    observe(node: SyntaxNode, scope: LexicalScope): void {
      updateActiveGuards(node);
      if (node.type === 'if_statement') {
        const guard = readInstanceofGuard(node, scope);
        if (guard) {
          guards.push(guard);
          pending.set(guard.consequence.id, guard);
        }
      } else if (byName.size > 0 && node.type === 'member_expression') {
        const receiver = node.childForFieldName('object');
        const guard =
          receiver?.type === 'identifier'
            ? byName.get(canonicalTypeScriptName(receiver.text))
            : undefined;
        if (guard && receiver) guard.uses.push({ node, scope, receiver });
      }
      // A var initializer can overwrite an existing parameter or var.
      if (
        node.type === 'variable_declarator' &&
        node.parent?.type === 'variable_declaration' &&
        node.childForFieldName('value') !== null
      ) {
        const write = readWriteSite(node, functionOwner(scope), node.childForFieldName('name'));
        if (write) writes.push(write);
      }
    },
    emit(scopes: Iterable<LexicalScope>, filePath: string, out: CaptureMatch[]): void {
      if (!guards.some((guard) => guard.uses.length > 0)) return;
      const escapedNames = indexEscapedNames(scopes);
      const bindingWrites: BindingWrite[] = [];
      for (const { node, scope, names } of writes) {
        const executionScope = functionOwner(scope);
        for (const name of names) {
          const spelling = canonicalTypeScriptName(name.text);
          const owner = bindingOwner(scope, spelling, escapedNames);
          if (owner) bindingWrites.push({ node, scope: owner, name: spelling, executionScope });
        }
      }
      emitInstanceofNarrowings(guards, bindingWrites, filePath, out, escapedNames);
    },
  };
}

/**
 * Add scope facts and imports in one AST pass. Returned identities and blocked
 * binding names let CommonJS forwarding reject shadowed loaders and written handles.
 * Computed sources and indirect promise/loader chains never become aliases.
 */
export function synthesizeTsLocalImports(
  root: SyntaxNode,
  filePath: string,
  out: CaptureMatch[],
): ReadonlyMap<number, ReadonlySet<string>> {
  const scopes = new Map<string, LexicalScope>();
  const scopesAt = new Map<string, LexicalScope>();
  const calls: LocatedNode[] = [];
  const writes: WriteSite[] = [];
  const bindingWrites: Array<LocatedNode & { readonly name: string }> = [];
  // The operator is a literal token. Files without it need no per-node guard tracking.
  const narrowing = root.text.includes('instanceof')
    ? createInstanceofNarrowingCollector()
    : undefined;
  const recordWrite = (node: SyntaxNode, scope: LexicalScope, target: SyntaxNode | null) => {
    const write = readWriteSite(node, scope, target);
    if (!write) return;
    writes.push(write);
    narrowing?.writes.push(write);
  };
  const uninitializedVarClaims = new Set<NameClaim>();
  const declarations: LocatedNode[] = [];
  const equalsImports: LocatedNode[] = [];
  const scopeTags = Object.entries(SCOPE_TAGS);
  for (let i = 0; i < out.length; i++) {
    for (const [tag, kind] of scopeTags) {
      const anchor = out[i][tag];
      if (anchor)
        scopes.set(scopeKey(anchor.range, kind), {
          anchor,
          kind,
          matchIndex: i,
          claims: [],
          names: new Set(),
        });
    }
  }
  const module = scopes.get(scopeKey(rangeOf(root), 'Module'));
  if (!module) return new Map();

  const add = (
    scope: LexicalScope,
    node: SyntaxNode,
    names: readonly SyntaxNode[],
    extra: Partial<NameClaim> = {},
  ) => {
    for (const name of names) {
      if (extra.purpose !== 'type') scope.names.add(name.text);
      scope.claims.push({
        name: name.text,
        range: rangeOf(node),
        kind: 'binding',
        purpose: 'value',
        ...extra,
      });
    }
  };
  const pending: Array<{ node: SyntaxNode; parent: LexicalScope }> = [
    { node: root, parent: module },
  ];
  while (pending.length) {
    const { node, parent } = pending.pop()!;
    const kind = nodeScopeKind(node);
    let scope = kind ? scopes.get(scopeKey(rangeOf(node), kind)) : undefined;
    if (kind === 'Block' && !scope && extraBlock(node)) {
      const anchor = nodeToCapture('@scope.block', node);
      scope = { anchor, kind: 'Block', matchIndex: out.length, claims: [], names: new Set() };
      scopes.set(scopeKey(anchor.range, 'Block'), scope);
      out.push({ '@scope.block': anchor });
    }
    if (scope && scope !== parent) scope.parent = parent;
    if (scope) scope.node = node;
    const current = scope ?? parent;
    if (node.type === 'import_statement') scopesAt.set(rangeKey(rangeOf(node)), current);

    narrowing?.observe(node, current);

    if (FUNCTION_TYPES.has(node.type)) {
      // JSDoc parameter type facts are anchored on the enclosing function.
      add(
        current,
        node,
        boundNames(node.childForFieldName('parameters') ?? node.childForFieldName('parameter')),
        { hoisted: true },
      );
      const name = node.childForFieldName('name');
      if (
        name &&
        ['function_declaration', 'generator_function_declaration', 'function_signature'].includes(
          node.type,
        )
      ) {
        add(parent, node, [name], { hoisted: true });
      } else if (name && ['function_expression', 'generator_function'].includes(node.type))
        add(current, node, [name], { hoisted: true });
    }
    if (node.type === 'variable_declarator') {
      const owner = node.parent?.type === 'variable_declaration' ? functionOwner(current) : current;
      // Declaration queries anchor values on the whole declaration (and JS
      // also captures its export wrapper). The claim must contain those exact
      // declaration ranges while activation still follows this initializer.
      const declaration = node.parent ?? node;
      const anchor =
        declaration.parent?.type === 'export_statement' ? declaration.parent : declaration;
      const uninitializedVar =
        node.parent?.type === 'variable_declaration' && node.childForFieldName('value') === null;
      const claimStart = owner.claims.length;
      add(
        owner,
        anchor,
        boundNames(node.childForFieldName('name')),
        uninitializedVar ? { hoisted: true } : { availableFrom: atEnd(node) },
      );
      if (uninitializedVar) {
        for (const claim of owner.claims.slice(claimStart)) uninitializedVarClaims.add(claim);
      }
      declarations.push({ node, scope: owner });
    } else if (node.type === 'catch_clause') {
      add(
        current,
        node.childForFieldName('parameter') ?? node,
        boundNames(node.childForFieldName('parameter')),
      );
    } else if (node.type === 'for_in_statement') {
      const kind = node.childForFieldName('kind')?.text;
      const pattern = node.childForFieldName('left');
      if (kind)
        add(
          kind === 'var' ? functionOwner(current) : current,
          pattern ?? node,
          boundNames(pattern),
        );
      if (kind === undefined || kind === 'var')
        recordWrite(node, kind === 'var' ? functionOwner(current) : current, pattern);
    } else if (node.type === 'class') {
      const name = node.childForFieldName('name');
      if (name) add(current, node, [name], { purpose: 'both', hoisted: true });
    } else if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
      const name = node.childForFieldName('name');
      if (name) {
        add(parent, node, [name], { availableFrom: atEnd(node) });
        add(parent, node, [name], { purpose: 'type', hoisted: true });
      }
    } else if (node.type === 'enum_declaration' || node.type === 'internal_module') {
      const name = node.childForFieldName('name');
      if (name)
        add(parent, node, [name], {
          purpose: 'both',
          availableFrom: {
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column,
          },
        });
    } else if (node.type === 'interface_declaration' || node.type === 'type_alias_declaration') {
      const name = node.childForFieldName('name');
      if (name) add(scope ? parent : current, node, [name], { purpose: 'type', hoisted: true });
    }
    if (node.type === 'call_expression') calls.push({ node, scope: current });
    if (
      node.type === 'assignment_expression' ||
      node.type === 'augmented_assignment_expression' ||
      node.type === 'update_expression'
    )
      recordWrite(
        node,
        current,
        node.childForFieldName('left') ?? node.childForFieldName('argument'),
      );
    if (
      node.type === 'import_statement' &&
      node.namedChildren.some((child) => child.type === 'import_require_clause')
    )
      equalsImports.push({ node, scope: current });
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) pending.push({ node: child, parent: current });
    }
  }

  // Static imports establish loader identity before any require call is inspected.
  for (const match of out) {
    const anchor = match['@import.statement'];
    const kind = match['@import.kind']?.text;
    if (
      !anchor ||
      !kind ||
      kind.startsWith('reexport') ||
      kind === 'dynamic' ||
      kind === 'side-effect'
    )
      continue;
    const name = match['@import.alias']?.text ?? match['@import.name']?.text;
    const scope = scopesAt.get(rangeKey(anchor.range));
    if (!name || !scope) continue;
    scope.names.add(name);
    const claim: NameClaim = {
      name,
      range: anchor.range,
      kind: 'import',
      purpose: 'both',
      hoisted: true,
    };
    if (match['@import.type-only']) {
      scope.claims.push(
        { ...claim, purpose: 'type' },
        { ...claim, kind: 'blocked', purpose: 'value' },
      );
    } else scope.claims.push(claim);
  }
  for (const { node, scope } of equalsImports) {
    const clause = node.namedChildren.find((child) => child.type === 'import_require_clause')!;
    const name = clause.namedChildren.find((child) => child.type === 'identifier');
    if (name) scope.names.add(name.text);
  }

  // An assignment to an actual local shadow does not mutate the ambient loader.
  // A write to the ambient loader makes its identity unknown for this file.
  let ambientLoaderWritten = false;
  for (const { node, scope, names } of writes) {
    for (const name of names) {
      const owner = bindingOwner(scope, name.text);
      if (name.text === 'require' && !owner) ambientLoaderWritten = true;
      if (owner) bindingWrites.push({ node, scope: owner, name: name.text });
    }
  }
  narrowing?.emit(scopes.values(), filePath, out);

  const validRequireCalls = new Map<number, Set<string>>();
  const declarationByValue = new Map(
    declarations.map((entry) => [entry.node.childForFieldName('value')?.id, entry]),
  );
  const emit = (
    at: SyntaxNode,
    sourceNode: SyntaxNode,
    source: string,
    kind: string,
    scope: LexicalScope,
    name?: SyntaxNode,
    imported?: string,
    available?: ReturnType<typeof atEnd>,
    typeOnly = false,
  ) => {
    const match: Record<string, Capture> = {
      '@import.statement': nodeToCapture('@import.statement', at),
      '@import.kind': syntheticCapture('@import.kind', at, kind),
      '@import.source': syntheticCapture('@import.source', sourceNode, source),
      '@import.lookup-scope': syntheticCapture(
        '@import.lookup-scope',
        at,
        makeScopeId({ filePath, range: scope.anchor.range, kind: scope.kind }),
      ),
    };
    if (typeOnly) match['@import.type-only'] = syntheticCapture('@import.type-only', at, 'true');
    if (name) {
      match['@import.alias'] = nodeToCapture('@import.alias', name);
      if (imported) match['@import.name'] = syntheticCapture('@import.name', name, imported);
      scope.names.add(name.text);
      // A loader initializer supplies the variable's value; its ordinary
      // declaration must not compete with the imported target at this site.
      for (let i = scope.claims.length - 1; i >= 0; i--) {
        const claim = scope.claims[i];
        if (
          claim.name === name.text &&
          claim.kind === 'binding' &&
          claim.availableFrom?.startLine === available?.startLine &&
          claim.availableFrom?.startCol === available?.startCol
        )
          scope.claims.splice(i, 1);
      }
      const claim: NameClaim = {
        name: name.text,
        range: match['@import.statement'].range,
        kind: 'import',
        purpose: 'both',
        ...(available ? { availableFrom: available } : { hoisted: true }),
      };
      if (typeOnly)
        scope.claims.push(
          { ...claim, purpose: 'type' },
          { ...claim, kind: 'blocked', purpose: 'value' },
        );
      else scope.claims.push(claim);
    }
    out.push(match);
  };
  for (const { node, scope } of calls) {
    const fn = node.childForFieldName('function');
    const requireCall = fn?.type === 'identifier' && fn.text === 'require';
    const importCall = fn?.type === 'import';
    if (!requireCall && !importCall) continue;
    if (requireCall && (ambientLoaderWritten || bindingOwner(scope, 'require'))) continue;
    const args =
      node
        .childForFieldName('arguments')
        ?.namedChildren.filter((child) => child.type !== 'comment') ?? [];
    const sourceNode = args[0];
    if (!sourceNode || sourceNode.type !== 'string' || (requireCall && args.length !== 1)) continue;
    const source = sourceNode.text.slice(1, -1);
    if (requireCall) validRequireCalls.set(node.id, new Set());
    const value = importCall && node.parent?.type === 'await_expression' ? node.parent : node;
    const declaration = declarationByValue.get(value.id);
    if (importCall && value === node) continue; // A promise is not a module namespace.
    if (!declaration) {
      if (requireCall) emit(node, sourceNode, source, 'side-effect', scope);
      continue;
    }
    const name = declaration.node.childForFieldName('name');
    const available = atEnd(declaration.node);
    if (name?.type === 'identifier')
      emit(node, sourceNode, source, 'namespace', declaration.scope, name, undefined, available);
    else if (name?.type === 'object_pattern') {
      for (const field of name.namedChildren) {
        if (field.type === 'shorthand_property_identifier_pattern') {
          emit(node, sourceNode, source, 'named', declaration.scope, field, field.text, available);
        } else if (field.type === 'pair_pattern') {
          const key = field.childForFieldName('key');
          const local = field.childForFieldName('value');
          if (
            key &&
            ['property_identifier', 'identifier', 'string'].includes(key.type) &&
            local?.type === 'identifier'
          ) {
            emit(
              node,
              sourceNode,
              source,
              'named-alias',
              declaration.scope,
              local,
              key.type === 'string' ? key.text.slice(1, -1) : key.text,
              available,
            );
          }
        }
      }
    }
  }
  for (const { node, scope } of equalsImports) {
    const clause = node.namedChildren.find((child) => child.type === 'import_require_clause')!;
    const name = clause.namedChildren.find((child) => child.type === 'identifier');
    const source = clause.childForFieldName('source');
    const typeOnly = node.children.some((child) => child.type === 'type');
    if (
      scope.kind === 'Module' &&
      name &&
      source?.type === 'string' &&
      (typeOnly || (!ambientLoaderWritten && !bindingOwner(scope, 'require')))
    ) {
      emit(
        node,
        source,
        source.text.slice(1, -1),
        'namespace',
        scope,
        name,
        undefined,
        undefined,
        typeOnly,
      );
    }
  }
  // Writes invalidate an imported handle's module proof, including a var loader
  // that shares a name with a function declaration. Ordinary locals retain their
  // type and callable-value inference; an assignment does not erase that evidence.
  for (const { node, scope, name } of bindingWrites) {
    if (
      !scope.claims.some(
        (claim) => claim.name === name && claim.kind === 'import' && claim.purpose !== 'type',
      )
    ) {
      continue;
    }
    const loopBody =
      node.type === 'for_in_statement' ? node.childForFieldName('body')?.startPosition : undefined;
    scope.claims.push({
      name,
      range: rangeOf(node),
      kind: 'blocked',
      purpose: 'value',
      availableFrom: loopBody
        ? { startLine: loopBody.row + 1, startCol: loopBody.column }
        : atEnd(node),
    });
  }
  for (const { node, scope } of declarations) {
    if (!conditionalVar(node, scope)) continue;
    const end = atEnd(node);
    const names = new Set(boundNames(node.childForFieldName('name')).map((name) => name.text));
    for (let i = 0; i < scope.claims.length; i++) {
      const claim = scope.claims[i];
      if (
        claim.kind === 'import' &&
        names.has(claim.name) &&
        claim.availableFrom?.startLine === end.startLine &&
        claim.availableFrom.startCol === end.startCol
      ) {
        scope.claims[i] = { ...claim, kind: 'blocked' };
      }
    }
  }
  // Forwarding exports require a stable handle as well as a genuine loader.
  // Keep the original import facts for calls before a write; remove forwarding
  // proof only for each written handle, preserving unchanged destructured siblings.
  for (const { node, scope } of declarations) {
    const value = node.childForFieldName('value');
    const blockedNames = value && validRequireCalls.get(value.id);
    if (!blockedNames) continue;
    const names = new Set(boundNames(node.childForFieldName('name')).map((name) => name.text));
    for (const claim of scope.claims) {
      if (claim.kind === 'blocked' && names.has(claim.name)) blockedNames.add(claim.name);
    }
  }
  for (const scope of scopes.values()) {
    // `var x;` creates ownership but performs no store. A same-scope parameter,
    // function, or initialized declaration already owns that binding's value.
    const valueNames = new Set(
      scope.claims
        .filter(
          (claim) =>
            !uninitializedVarClaims.has(claim) &&
            claim.kind !== 'blocked' &&
            claim.purpose !== 'type',
        )
        .map((claim) => claim.name),
    );
    const claims = scope.claims.filter(
      (claim) => !uninitializedVarClaims.has(claim) || !valueNames.has(claim.name),
    );
    const selfName =
      scope.node?.type === 'class' ? scope.node.childForFieldName('name')?.text : undefined;
    out[scope.matchIndex] = {
      ...out[scope.matchIndex],
      '@scope.name-claims': {
        ...scope.anchor,
        name: '@scope.name-claims',
        text: JSON.stringify(claims),
      },
      '@scope.lookup-policy': {
        ...scope.anchor,
        name: '@scope.lookup-policy',
        text: JSON.stringify({
          // An assignment can update a binding, but cannot declare a local.
          nameClaimsComplete: true,
          ...(scope.kind === 'Function' ? { deferParentActivation: true } : {}),
          ...(scope.kind === 'Class'
            ? {
                skipFromChildren: true,
                ...(selfName ? { visibleNamesFromChildren: [selfName] } : {}),
              }
            : {}),
        }),
      },
    };
  }
  return validRequireCalls;
}
