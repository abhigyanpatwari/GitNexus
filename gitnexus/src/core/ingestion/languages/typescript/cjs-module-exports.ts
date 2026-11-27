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
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { deriveDefaultExportHocName } from '../../ts-js-hoc-utils.js';
import { defaultExportNameCollides, isCommonJsModule } from './cjs-export-assignment.js';
import { canonicalTypeScriptName } from './identifiers.js';
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

/** The real wrapper is an object, so neither fallback operand executes. */
function retainsWrapper(value: SyntaxNode | null): boolean {
  value = ungroup(value);
  return (
    isModuleIdentifier(value) ||
    (value?.type === 'binary_expression' &&
      ['||', '??'].includes(value.childForFieldName('operator')?.type ?? '') &&
      isModuleIdentifier(value.childForFieldName('left')))
  );
}

/** A callable kept only under its unused local name cannot run during module evaluation. */
function unusedLocalCallable(root: SyntaxNode) {
  let nameCounts: Map<string, number> | undefined;
  return (fn: SyntaxNode) => {
    const binding = fn.type.endsWith('_declaration')
      ? fn.childForFieldName('name')
      : fn.parent?.type === 'variable_declarator'
        ? fn.parent.childForFieldName('name')
        : null;
    if (binding?.type !== 'identifier') return false;
    if (!nameCounts) {
      nameCounts = new Map();
      for (const node of root.descendantsOfType(['identifier', 'shorthand_property_identifier'])) {
        const name = canonicalTypeScriptName(node.text);
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
    }
    return !nameCounts.has('eval') && nameCounts.get(canonicalTypeScriptName(binding.text)) === 1;
  };
}

/** Unknown branch conditions join both paths. Indirect invocations have no known write position. */
function wrapperWriteExecution(
  write: SyntaxNode,
  unused: (fn: SyntaxNode) => boolean,
): 'always' | 'conditional' | 'deferred' | undefined {
  let conditional = false;
  for (let child = write, parent = write.parent; parent; child = parent, parent = parent.parent) {
    if (FUNCTION_NODE_TYPES.has(parent.type) || parent.type === 'generator_function') {
      let callee = parent;
      while (callee.parent?.type === 'parenthesized_expression') callee = callee.parent;
      if (
        callee.parent?.type === 'call_expression' &&
        callee.parent.childForFieldName('function')?.id === callee.id
      ) {
        if (
          parent.type === 'generator_function' ||
          parent.children.some((token) => token.type === 'async')
        )
          return 'deferred';
        continue;
      }
      return unused(parent) ? undefined : 'deferred';
    }
    switch (parent.type) {
      case 'program':
        return conditional ? 'conditional' : 'always';
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
        if (
          (op === '&&' && left?.type === 'false') ||
          (op === '||' && left?.type === 'true') ||
          ((op === '||' || op === '??') && isModuleIdentifier(left))
        )
          return undefined;
        conditional = true;
        break;
      }
      default:
        conditional = true;
    }
  }
}

type WrapperEvent =
  | { at: number; kind: 'save' }
  | { at: number; kind: 'write'; savedAt?: number; conditional?: boolean };

/** Lexical declarations replace the wrapper itself. Initialized vars write its shared binding. */
function moduleDeclarationWrites(
  root: SyntaxNode,
  captures: CaptureMatch[],
): WrapperEvent[] | undefined {
  const scope = captures.find((capture) => capture['@scope.module']);
  const names = scope?.['@scope.name-claims']?.text;
  if (!names) return undefined;
  const claims: NameClaim[] = JSON.parse(names);
  const events: WrapperEvent[] = [];
  for (const claim of claims) {
    if (claim.purpose === 'type' || canonicalTypeScriptName(claim.name) !== 'module') continue;
    const pos = { row: claim.range.startLine - 1, column: claim.range.startCol };
    let node: SyntaxNode | null = root.namedDescendantForPosition(pos);
    let variable: SyntaxNode | undefined;
    while (node && node.type !== 'program') {
      if (node.type === 'ambient_declaration' || node.type === 'class_static_block') break;
      if (node.type === 'variable_declaration') variable = node;
      node = node.parent;
    }
    if (node?.type !== 'program') continue;
    if (!variable) return undefined;
    const at = claim.availableFrom;
    if (!at) continue;
    const declarator = variable.namedChildren.find(
      (child) =>
        child.endPosition.row + 1 === at.startLine && child.endPosition.column === at.startCol,
    );
    if (
      declarator &&
      isModuleIdentifier(declarator.childForFieldName('name')) &&
      retainsWrapper(declarator.childForFieldName('value'))
    )
      continue;
    events.push({ at: declarator?.endIndex ?? variable.endIndex, kind: 'write' });
  }
  return events;
}

/** Advance once through stores and const snapshots, in the same order as the export sites. */
function wrapperAtExport(
  root: SyntaxNode,
  captures: CaptureMatch[],
  writes: LocalImportFacts['wrapperWrites'],
) {
  const events = moduleDeclarationWrites(root, captures);
  if (!events) return () => false;
  const unused = unusedLocalCallable(root);
  for (const { node, savedAt } of writes) {
    const execution = wrapperWriteExecution(node, unused);
    if (!execution) continue;
    const direct = isModuleIdentifier(node.childForFieldName('left'));
    const op = node.childForFieldName('operator')?.type;
    if (direct && (op === '||=' || op === '??=')) continue;
    if (
      direct &&
      (node.type === 'assignment_expression' || op === '&&=') &&
      retainsWrapper(node.childForFieldName('right'))
    )
      continue;
    if (execution === 'deferred') return () => false;
    const alias =
      direct && (node.type === 'assignment_expression' || op === '&&=') ? savedAt : undefined;
    if (alias !== undefined) events.push({ at: alias, kind: 'save' });
    events.push({
      at: node.endIndex,
      kind: 'write',
      savedAt: alias,
      conditional: execution === 'conditional' || op === '&&=',
    });
  }
  events.sort((a, b) => a.at - b.at);
  const savedWrapper = new Set<number>();
  let index = 0;
  let original = true;
  return (position: number) => {
    while (index < events.length && events[index].at <= position) {
      const event = events[index++];
      if (event.kind === 'write')
        original =
          (!event.conditional || original) &&
          event.savedAt !== undefined &&
          savedWrapper.has(event.savedAt);
      else if (original) savedWrapper.add(event.at);
    }
    return original;
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
