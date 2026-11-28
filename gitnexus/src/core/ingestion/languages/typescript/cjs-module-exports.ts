/**
 * CommonJS module-export capture synthesis, shared by the JavaScript and
 * TypeScript emitters (#2723; TS parity per the #2729 review, F7).
 *
 * These declarations cannot come from the tree-sitter queries: the anonymous
 * default export takes its name from the FILE, which a query pattern cannot
 * see. They therefore had to be synthesized in the emitter — and living only in
 * `javascript/captures.ts` meant a `.ts` file emitted the default-export NODE
 * (the query and `labelOverride` are wired on both providers) while nothing
 * ever declared it. That is precisely the "found, zero callers" half-fix state
 * this issue set out to remove, reintroduced for TypeScript.
 *
 * Every grammar node named here exists in both `tree-sitter-javascript` and
 * `tree-sitter-typescript`, so one implementation serves both.
 *
 * Pure given the input nodes. No I/O, no globals.
 */

import type { CaptureMatch, NameClaim } from 'gitnexus-shared';
import {
  FUNCTION_NODE_TYPES,
  nodeToCapture,
  outerParenthesizedExpression,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { deriveDefaultExportHocName } from '../../ts-js-hoc-utils.js';
import { defaultExportNameCollides, isCommonJsModule } from './cjs-export-assignment.js';
import { decodeStringLiteral } from '../../utils/ecmascript-literals.js';
import { canonicalTypeScriptName, literalMethodName, numericLiteralValue } from './identifiers.js';
import type { LocalImportFacts } from './local-loaders.js';
import { recordPossibleCommonJsDefault } from './module-kind.js';

/**
 * Synthesize re-export markers for CJS forwarding assignments (#2723).
 *
 *   const lib = require('./lib');
 *   exports.forwarded = lib.imported;   // re-export of `imported` from ./lib
 *   const { imported } = require('./lib');
 *   exports.alsoForwarded = imported;   // same, through a named binding
 *
 * The right-hand side is an existing symbol rather than a function literal, so
 * no definition rule reaches it and importers of `forwarded` resolved to
 * nothing. Emitted with the `named-alias` vocabulary the destructured
 * `require()` form already uses, so `interpretJsImport` needs no new case.
 *
 * `exports.foo = localFn` (a locally DECLARED function) is deliberately not
 * handled here: the module scope already binds `localFn`, importers already
 * resolve through it, and synthesizing a second binding would re-create the
 * ambiguity the shadow guard exists to prevent.
 */
export function synthesizeCjsReExports(
  root: SyntaxNode,
  out: CaptureMatch[],
  validRequireCalls?: ReadonlyMap<number, ReadonlySet<string>>,
): void {
  // Namespace and named bindings introduced by require(), by local name.
  const namespaceSources = new Map<string, { source: string; node: SyntaxNode }>();
  const namedSources = new Map<string, { source: string; name: string; node: SyntaxNode }>();

  for (const child of root.namedChildren) {
    if (child.type !== 'lexical_declaration' && child.type !== 'variable_declaration') continue;
    for (const declarator of child.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const value = declarator.childForFieldName('value');
      if (value === null || value.type !== 'call_expression') continue;
      if (value.childForFieldName('function')?.text !== 'require') continue;
      if (validRequireCalls !== undefined && !validRequireCalls.has(value.id)) continue;
      const blockedNames = validRequireCalls?.get(value.id);
      const arg = value.childForFieldName('arguments')?.namedChild(0);
      if (arg === undefined || arg === null || arg.type !== 'string') continue;
      const source = arg.namedChild(0)?.text ?? arg.text.slice(1, -1);

      const nameNode = declarator.childForFieldName('name');
      if (nameNode === null) continue;
      if (nameNode.type === 'identifier') {
        if (blockedNames?.has(nameNode.text)) continue;
        namespaceSources.set(nameNode.text, { source, node: arg });
      } else if (nameNode.type === 'object_pattern') {
        for (const field of nameNode.namedChildren) {
          if (field.type === 'shorthand_property_identifier_pattern') {
            if (blockedNames?.has(field.text)) continue;
            namedSources.set(field.text, { source, name: field.text, node: arg });
          } else if (field.type === 'pair_pattern') {
            const key = field.childForFieldName('key');
            const local = field.childForFieldName('value');
            if (
              key !== null &&
              local !== null &&
              local.type === 'identifier' &&
              !blockedNames?.has(local.text)
            )
              namedSources.set(local.text, { source, name: key.text, node: arg });
          }
        }
      }
    }
  }

  if (namespaceSources.size === 0 && namedSources.size === 0) return;

  for (const child of root.namedChildren) {
    if (child.type !== 'expression_statement') continue;
    const assignment = child.namedChild(0);
    if (assignment === null || assignment.type !== 'assignment_expression') continue;

    const left = assignment.childForFieldName('left');
    if (left === null || left.type !== 'member_expression') continue;
    const receiver = left.childForFieldName('object');
    const exposed = left.childForFieldName('property');
    if (receiver === null || exposed === null || exposed.type !== 'property_identifier') continue;

    const isExportsReceiver =
      (receiver.type === 'identifier' && receiver.text === 'exports') ||
      (receiver.type === 'member_expression' &&
        receiver.childForFieldName('object')?.text === 'module' &&
        receiver.childForFieldName('property')?.text === 'exports');
    if (!isExportsReceiver) continue;

    const right = assignment.childForFieldName('right');
    if (right === null) continue;

    // `exports.fwd = ns.member`
    if (right.type === 'member_expression') {
      const ns = right.childForFieldName('object');
      const member = right.childForFieldName('property');
      if (ns === null || member === null || ns.type !== 'identifier') continue;
      const origin = namespaceSources.get(ns.text);
      if (origin === undefined) continue;
      out.push({
        '@import.statement': syntheticCapture('@import.statement', assignment, origin.source),
        '@import.kind': syntheticCapture('@import.kind', assignment, 'reexport-alias'),
        '@import.name': syntheticCapture('@import.name', member, member.text),
        '@import.alias': syntheticCapture('@import.alias', exposed, exposed.text),
        '@import.source': syntheticCapture('@import.source', origin.node, origin.source),
      });
      continue;
    }

    // `exports.fwd = importedName`
    if (right.type === 'identifier') {
      const origin = namedSources.get(right.text);
      if (origin === undefined) continue;
      out.push({
        '@import.statement': syntheticCapture('@import.statement', assignment, origin.source),
        '@import.kind': syntheticCapture('@import.kind', assignment, 'reexport-alias'),
        '@import.name': syntheticCapture('@import.name', right, origin.name),
        '@import.alias': syntheticCapture('@import.alias', exposed, exposed.text),
        '@import.source': syntheticCapture('@import.source', origin.node, origin.source),
      });
    }
  }
}

function ungroup(node: SyntaxNode | null): SyntaxNode | null {
  while (node?.type === 'parenthesized_expression')
    node = node.namedChildren.find((child) => child.type !== 'comment') ?? null;
  return node;
}

function isModuleIdentifier(node: SyntaxNode | null): boolean {
  node = ungroup(node);
  return node?.type === 'identifier' && canonicalTypeScriptName(node.text) === 'module';
}

// Each bit represents a value the binding may hold on a reachable path.
const enum WrapperValue {
  Original = 1,
  Truthy = 2,
  Falsy = 4,
  Nullish = 8,
  Unknown = Original | Truthy | Falsy | Nullish,
}

function literalWrapperValue(value: SyntaxNode | null, globalUndefined: boolean): WrapperValue {
  switch (value?.type) {
    case 'null':
      return WrapperValue.Nullish;
    case 'undefined':
      return globalUndefined ? WrapperValue.Nullish : WrapperValue.Unknown;
    case 'false':
      return WrapperValue.Falsy;
    case 'true':
    case 'object':
    case 'array':
    case 'arrow_function':
    case 'function_expression':
    case 'class':
      return WrapperValue.Truthy;
    case 'number':
    case 'string': {
      const literal =
        value.type === 'number' ? numericLiteralValue(value.text) : decodeStringLiteral(value.text);
      if (literal == null) return WrapperValue.Unknown;
      return literal ? WrapperValue.Truthy : WrapperValue.Falsy;
    }
    case 'unary_expression':
      if (value.childForFieldName('operator')?.type === 'void') return WrapperValue.Nullish;
  }
  return WrapperValue.Unknown;
}

const logicalWriteMask: Record<string, WrapperValue> = {
  '||': WrapperValue.Falsy | WrapperValue.Nullish,
  '??': WrapperValue.Nullish,
  '&&': WrapperValue.Original | WrapperValue.Truthy,
};

/**
 * In a direct synchronous IIFE the arguments run before the parameters and body.
 * Swap those two source intervals within each enclosing call. Nested calls keep
 * their internal order and every event stays inside its original call's extent.
 */
function evaluationPosition(node: SyntaxNode, at = node.endIndex): number {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type !== 'call_expression') continue;
    const callee = parent.childForFieldName('function');
    const fn = ungroup(callee);
    if (fn?.type !== 'function_expression' && fn?.type !== 'arrow_function') continue;
    if (fn.children.some((token) => token.type === 'async')) continue;
    const args = parent.childForFieldName('arguments');
    if (args?.type !== 'arguments') continue;
    if (child.id === args.id) at -= args.startIndex - parent.startIndex;
    else if (child.id === callee.id) at += parent.endIndex - args.startIndex;
  }
  return at;
}

/** A local callable cannot execute before its first possible use or escape. */
function localCallableFirstUse(root: SyntaxNode) {
  let references: Map<string, SyntaxNode[]> | undefined;
  const byBinding = new Map<number, number>();
  return (fn: SyntaxNode): number => {
    const binding = fn.type.endsWith('_declaration')
      ? fn.childForFieldName('name')
      : fn.parent?.type === 'variable_declarator'
        ? fn.parent.childForFieldName('name')
        : null;
    if (binding?.type !== 'identifier') return 0;
    const cached = byBinding.get(binding.id);
    if (cached !== undefined) return cached;
    if (!references) {
      references = new Map();
      for (const node of root.descendantsOfType(['identifier', 'shorthand_property_identifier'])) {
        const name = canonicalTypeScriptName(node.text);
        const uses = references.get(name);
        if (uses) uses.push(node);
        else references.set(name, [node]);
      }
    }
    if (references.has('eval')) return 0;
    let first = Infinity;
    for (const ref of references.get(canonicalTypeScriptName(binding.text)) ?? []) {
      if (ref.id === binding.id) continue;
      // A function declaration containing the reference may have been called before its source.
      if (ref.closest(['function_declaration', 'generator_function_declaration'])) {
        first = 0;
        break;
      }
      first = Math.min(first, evaluationPosition(ref, ref.startIndex));
    }
    byBinding.set(binding.id, first);
    return first;
  };
}

/** Unknown branch conditions join both paths. Indirect invocations have no known write position. */
function wrapperWriteExecution(
  write: SyntaxNode,
  firstUse: (fn: SyntaxNode) => number,
  afterLastExportStore: (at: number) => boolean,
): { when: WrapperValue; conditional: boolean } | { deferredAt: number } | undefined {
  let when = WrapperValue.Unknown;
  let conditional = false;
  let deferredCall: number | undefined;
  // If a later export could use either wrapper, an earlier one is not a proven final default.
  const deferred = (at: number) => {
    if (at === Infinity) return undefined;
    if (deferredCall === undefined) return { deferredAt: at };
    return afterLastExportStore(at) ? undefined : { deferredAt: 0 };
  };
  for (let child = write, parent = write.parent; parent; child = parent, parent = parent.parent) {
    if (FUNCTION_NODE_TYPES.has(parent.type) || parent.type === 'generator_function') {
      const callee = outerParenthesizedExpression(parent);
      if (
        callee.parent?.type === 'call_expression' &&
        callee.parent.childForFieldName('function')?.id === callee.id
      ) {
        if (
          parent.type === 'generator_function' ||
          parent.children.some((token) => token.type === 'async')
        ) {
          // Even an async prefix or an immediately resumed generator must reach this call first.
          // An enclosing indirect function may itself have run before its declaration.
          deferredCall = evaluationPosition(callee.parent, callee.parent.startIndex);
        }
        continue;
      }
      const at = firstUse(parent);
      return deferred(at);
    }
    switch (parent.type) {
      case 'program':
        return deferredCall === undefined ? { when, conditional } : deferred(deferredCall);
      case 'parenthesized_expression':
      case 'sequence_expression':
      case 'expression_statement':
      case 'statement_block':
      case 'else_clause':
      case 'variable_declarator':
      case 'lexical_declaration':
      case 'variable_declaration':
      case 'arguments':
        break;
      case 'call_expression':
        if (
          child.type === 'arguments' &&
          parent.children.some((token) => token.type === 'optional_chain' || token.type === '?.')
        )
          conditional = true;
        break;
      case 'if_statement': {
        const condition = parent.childForFieldName('condition');
        if (child.id === condition?.id) break;
        const test = ungroup(condition)?.type;
        if (test !== 'true' && test !== 'false') conditional = true;
        else if ((test === 'true') !== (child.id === parent.childForFieldName('consequence')?.id))
          return undefined;
        break;
      }
      case 'binary_expression': {
        const left = ungroup(parent.childForFieldName('left'));
        const op = parent.childForFieldName('operator')?.type;
        if (child.id !== parent.childForFieldName('right')?.id) break;
        if ((op === '&&' && left?.type === 'false') || (op === '||' && left?.type === 'true'))
          return undefined;
        if (logicalWriteMask[op] && isModuleIdentifier(left) && ungroup(child)?.id === write.id)
          when &= logicalWriteMask[op];
        else conditional = true;
        break;
      }
      default:
        conditional = true;
    }
  }
}

type WrapperEvent =
  | { at: number; kind: 'save'; savedAt: number }
  | { at: number; kind: 'deferred'; when: WrapperValue }
  | {
      at: number;
      kind: 'write';
      value: WrapperValue;
      when: WrapperValue;
      savedAt?: number;
      conditional?: boolean;
    };

/** A module-level var shares the CommonJS parameter. Other declarations shadow it. */
function hasWrapperBinding(root: SyntaxNode, captures: CaptureMatch[]): boolean {
  const scope = captures.find((capture) => capture['@scope.module']);
  const names = scope?.['@scope.name-claims']?.text;
  if (!names) return false;
  for (const claim of JSON.parse(names) as NameClaim[]) {
    if (claim.purpose === 'type' || canonicalTypeScriptName(claim.name) !== 'module') continue;
    const pos = { row: claim.range.startLine - 1, column: claim.range.startCol };
    let node: SyntaxNode | null = root.namedDescendantForPosition(pos);
    let sharedVar = false;
    while (node && node.type !== 'program') {
      if (node.type === 'ambient_declaration' || node.type === 'class_static_block') break;
      if (node.type === 'variable_declaration') sharedVar = true;
      node = node.parent;
    }
    if (node?.type === 'program' && !sharedVar) return false;
  }
  return true;
}

/** A wrapper alias may reach the exports slot, but a different constant key cannot. */
function mayStoreExports(target: SyntaxNode | null): boolean {
  target = ungroup(target);
  switch (target?.type) {
    case 'member_expression':
      return (
        canonicalTypeScriptName(target.childForFieldName('property')?.text ?? '') === 'exports'
      );
    case 'subscript_expression': {
      const key = literalMethodName(target.childForFieldName('index'));
      return key === undefined || key === 'exports';
    }
    case 'pair_pattern':
      return mayStoreExports(target.childForFieldName('value'));
    case 'assignment_pattern':
    case 'object_assignment_pattern':
      return mayStoreExports(target.childForFieldName('left'));
    case 'array_pattern':
    case 'object_pattern':
    case 'rest_pattern':
      return target.namedChildren.some(mayStoreExports);
    default:
      return false;
  }
}

/** Advance once through stores and const snapshots, in the same order as the export sites. */
function wrapperAtExport(
  root: SyntaxNode,
  captures: CaptureMatch[],
  writes: LocalImportFacts['wrapperWrites'],
) {
  if (!hasWrapperBinding(root, captures)) return () => false;
  const events: WrapperEvent[] = [];
  const firstUse = localCallableFirstUse(root);
  let lastExportStore: number | undefined;
  const afterLastExportStore = (at: number) => {
    if (lastExportStore === undefined) {
      lastExportStore = -1;
      for (const write of root.descendantsOfType([
        'assignment_expression',
        'augmented_assignment_expression',
        'update_expression',
        'unary_expression',
      ])) {
        const op = write.childForFieldName('operator')?.type;
        if (write.type === 'unary_expression' && op !== 'delete') continue;
        if (
          !mayStoreExports(write.childForFieldName('left') ?? write.childForFieldName('argument'))
        )
          continue;
        // A nested callable can make the store after its position in the source.
        if (write.closest([...FUNCTION_NODE_TYPES, 'generator_function'])) {
          lastExportStore = Infinity;
          break;
        }
        lastExportStore = Math.max(lastExportStore, write.endIndex);
      }
    }
    return at > lastExportStore;
  };
  for (const { node, savedAt, globalUndefined } of writes) {
    const execution = wrapperWriteExecution(node, firstUse, afterLastExportStore);
    if (!execution) continue;
    const declarator = node.type === 'variable_declarator';
    const direct = isModuleIdentifier(node.childForFieldName(declarator ? 'name' : 'left'));
    let op = node.childForFieldName('operator')?.type.replace(/=$/u, '');
    const assignment =
      direct && (declarator || node.type === 'assignment_expression' || logicalWriteMask[op]);
    let value = assignment ? ungroup(node.childForFieldName(declarator ? 'value' : 'right')) : null;
    if (isModuleIdentifier(value)) continue;
    if (
      (declarator || node.type === 'assignment_expression') &&
      value?.type === 'binary_expression' &&
      isModuleIdentifier(value.childForFieldName('left'))
    ) {
      const binary = value.childForFieldName('operator')?.type;
      if (logicalWriteMask[binary]) {
        op = binary;
        value = ungroup(value.childForFieldName('right'));
      }
    }
    const when = logicalWriteMask[op] ?? WrapperValue.Unknown;
    if ('deferredAt' in execution) {
      events.push({ at: execution.deferredAt, kind: 'deferred', when });
      continue;
    }
    const alias = assignment ? savedAt : undefined;
    if (alias !== undefined) {
      const snapshot = root.namedDescendantForIndex(alias - 1);
      events.push({ at: evaluationPosition(snapshot, alias), kind: 'save', savedAt: alias });
    }
    events.push({
      at: evaluationPosition(node),
      kind: 'write',
      value: literalWrapperValue(value, globalUndefined),
      when: when & execution.when,
      savedAt: alias,
      conditional: execution.conditional,
    });
  }
  events.sort((a, b) => a.at - b.at);
  const snapshots = new Map<number, WrapperValue>();
  let index = 0;
  let current = WrapperValue.Original;
  let deferredWhen = 0;
  return (position: number) => {
    while (index < events.length && events[index].at <= position) {
      const event = events[index++];
      if (event.kind === 'save') {
        snapshots.set(event.savedAt, current);
        continue;
      }
      if (event.kind === 'deferred') {
        deferredWhen |= event.when;
        if (current & deferredWhen) current = WrapperValue.Unknown;
        continue;
      }
      const when = event.when;
      if (!(current & when)) continue;
      const next =
        event.savedAt === undefined
          ? event.value
          : (snapshots.get(event.savedAt) ?? WrapperValue.Unknown);
      current = (event.conditional ? current : current & ~when) | next;
      if (current & deferredWhen) current = WrapperValue.Unknown;
    }
    return current === WrapperValue.Original;
  };
}

/**
 * Synthesize the scope declaration for `module.exports = <function>` (#2723).
 *
 * The graph node for this comes from the definition query, but the scope query
 * cannot produce its name: an anonymous default export takes its name from the
 * FILE, which a tree-sitter pattern has no access to. Without a declaration the
 * node exists and nothing resolves to it — the half-fixed state this issue's
 * first commit already had to correct once.
 *
 * A named function expression (`module.exports = function named() {}`) keeps
 * its own name; the anonymous forms use `deriveDefaultExportHocName`, the
 * convention already applied to anonymous default exports elsewhere.
 */
export function synthesizeCjsDefaultExport(
  root: SyntaxNode,
  filePath: string,
  out: CaptureMatch[],
  wrapperWrites: LocalImportFacts['wrapperWrites'],
): void {
  let hasWrapper: ReturnType<typeof wrapperAtExport> | undefined;
  for (const child of root.namedChildren) {
    if (child.type !== 'expression_statement') continue;
    const assignment = child.namedChild(0);
    if (assignment === null || assignment.type !== 'assignment_expression') continue;

    const left = assignment.childForFieldName('left');
    if (left === null || left.type !== 'member_expression') continue;
    if (left.childForFieldName('object')?.text !== 'module') continue;
    if (left.childForFieldName('property')?.text !== 'exports') continue;

    const value = assignment.childForFieldName('right');
    if (value === null) continue;
    if (
      value.type !== 'function_expression' &&
      value.type !== 'arrow_function' &&
      value.type !== 'generator_function'
    )
      continue;

    const ownName = value.childForFieldName('name');
    const name = ownName?.text ?? deriveDefaultExportHocName(filePath);

    // Mirror the worker's suppression: when the DERIVED name collides with a
    // callable the module already declares, emit nothing. Declaring it anyway
    // would bind a second callable under one name, merging two functions onto
    // one node and fabricating a self-recursive call edge (#2729 review F4).
    if (ownName === null && defaultExportNameCollides(assignment, root, name)) continue;
    hasWrapper ??= wrapperAtExport(root, out, wrapperWrites);
    const wrapperBinding = hasWrapper(assignment.startIndex);
    const exported = wrapperBinding && isCommonJsModule(root, filePath);
    if (wrapperBinding && !exported && /\.tsx?$/.test(filePath))
      recordPossibleCommonJsDefault(filePath, value);

    // Anchored on the INNER function so the declaration range matches the
    // `@scope.function` range — the same anchor discipline as every other
    // closure-binding rule.
    out.push({
      '@declaration.function': nodeToCapture('@declaration.function', value),
      '@declaration.name': syntheticCapture('@declaration.name', ownName ?? value, name),
      '@declaration.is-exported': syntheticCapture(
        '@declaration.is-exported',
        value,
        String(exported),
      ),
      '@declaration.is-default-export': syntheticCapture(
        '@declaration.is-default-export',
        value,
        String(exported),
      ),
      '@declaration.named-exports': syntheticCapture('@declaration.named-exports', value, '[]'),
    });
  }
}

/** Run every CommonJS export-capture synthesis pass for one file. */
export function synthesizeCjsModuleExports(
  root: SyntaxNode,
  filePath: string,
  out: CaptureMatch[],
  facts: LocalImportFacts,
): void {
  synthesizeCjsReExports(root, out, facts.validRequireCalls);
  synthesizeCjsDefaultExport(root, filePath, out, facts.wrapperWrites);
}
