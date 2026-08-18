import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getZigParser, getZigScopeQuery } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { synthesizeCallableFlowCaptures } from '../../utils/callable-flow-captures.js';

/** Zig container node types: `struct`, `enum`, `union` and the fieldless
 *  `opaque` all bind through `const T = <container> {…}` and may own methods.
 *  Single source for the class/field/method extractor configs. */
export const ZIG_CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'struct_declaration',
  'enum_declaration',
  'union_declaration',
  'opaque_declaration',
]);

/** Is this variable_declaration a container binding (`const T = struct {…}`)
 *  or an import binding (`const x = @import("…")`)? Those groups are emitted
 *  by their dedicated query rules; the plain @declaration.variable match for
 *  the same node must be dropped so the name binds exactly once. Shared with
 *  the variable extractor config so the structure-phase Variable records and
 *  the scope-side bindings agree on what counts as a plain variable. */
export function isZigContainerOrImportBinding(declNode: SyntaxNode): boolean {
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (child === null) continue;
    if (ZIG_CONTAINER_TYPES.has(child.type)) return true;
    if (child.type === 'builtin_function') {
      const builtin = child.namedChild(0);
      if (builtin?.type === 'builtin_identifier' && builtin.text === '@import') return true;
    }
  }
  return false;
}

/** A `fn` nested in a struct/enum/union/opaque container is a method. Single
 *  predicate shared between the provider's `labelOverride` (worker
 *  structure phase) and the scope-capture relabel below, so the graph
 *  node label and the scope-side def label cannot drift apart. The loose
 *  parameter shape matches what `labelOverride` receives.
 *
 *  Only a `function_declaration` can be a method: a named `test "…" {}`
 *  inside a container is also a Function definition, but the method
 *  extractor does not know test blocks (no parameters, no `self`), so
 *  relabelling it would mint a Method id the definition phase never
 *  builds. Tests stay Functions wherever they sit. */
export function isZigContainerMethod(
  captureNode: { readonly type?: string; readonly parent?: SyntaxNode | null } | null | undefined,
): boolean {
  if (captureNode?.type !== undefined && captureNode.type !== 'function_declaration') return false;
  let ancestor = captureNode?.parent;
  while (ancestor) {
    if (ZIG_CONTAINER_TYPES.has(ancestor.type)) return true;
    ancestor = ancestor.parent;
  }
  return false;
}

/**
 * Callable-value-flow vocabulary for tree-sitter-zig 1.1.2 (verified by AST
 * dump). Two grammar quirks drive the callbacks:
 *
 * - `variable_declaration` is FIELDLESS apart from `type:` — `const f = target;`
 *   is `(variable_declaration (identifier) (identifier))`, and a bare
 *   re-assignment statement `f = target;` parses to the SAME node shape. The
 *   shared `left`/`name`/`value` fallback decomposes nothing, so
 *   `extractAssignment` pairs first-identifier → last-child positionally.
 *   `assignment_expression` (`self.f = target`) carries real `left`/`right`
 *   fields and is left to the shared path.
 * - `call_expression` has NO argument-list wrapper: `invoke(second)` is
 *   `(call_expression function: (identifier) (identifier))`. Arguments are
 *   every named child other than the `function` field, hence
 *   `extractCallArguments`.
 *
 * `builtin_function` (`@import`, `@sizeOf`, …) is deliberately not a call node:
 * builtins never take user callables as flow arguments.
 */
const ZIG_CALLABLE_CAPTURE_OPTIONS = {
  functionNodeTypes: new Set(['function_declaration']),
  callNodeTypes: new Set(['call_expression']),
  parameterListNodeTypes: new Set(['parameters']),
  parameterNodeTypes: new Set(['parameter']),
  bindingNodeTypes: new Set(['variable_declaration']),
  assignmentNodeTypes: new Set(['assignment_expression']),
  identifierNodeTypes: new Set(['identifier']),
  extractAssignment: (node: SyntaxNode) => {
    if (node.type !== 'variable_declaration') return undefined;
    const named = node.namedChildren.filter((child): child is SyntaxNode => child !== null);
    if (named.length < 2 || named[0]!.type !== 'identifier') return undefined;
    const source = named[named.length - 1]!;
    // `const x: T;` (extern) — the trailing child is the type, not a value.
    if (source.id === node.childForFieldName('type')?.id) return undefined;
    return { destination: named[0]!, source };
  },
  extractCallArguments: (call: SyntaxNode) => {
    const callee = call.childForFieldName('function');
    return call.namedChildren.filter(
      (child): child is SyntaxNode =>
        child !== null && child.id !== callee?.id && child.type !== 'comment',
    );
  },
} as const;

export function emitZigScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getZigParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getZigParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const rawMatches = getZigScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue; // skip anonymous predicate captures
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    // Drop the plain-variable group for container/import bindings — their
    // dedicated rules already bind the name (as Struct/Enum/Union or import).
    const variableAnchor = nodeMap['@declaration.variable'];
    if (variableAnchor !== undefined && isZigContainerOrImportBinding(variableAnchor)) {
      continue;
    }

    // Zig's receiver convention is specifically the FIRST parameter named
    // `self`. Tag first-position parameters so `interpretZigTypeBinding` can
    // require the position and not just the name — a later `self` parameter
    // (legal Zig) is an ordinary parameter, not a receiver. The synthetic
    // capture sits on the name node (smaller than the `parameter` anchor), so
    // it never displaces the anchor.
    const paramAnchor = nodeMap['@type-binding.parameter'];
    const paramName = nodeMap['@type-binding.name'];
    if (
      paramAnchor !== undefined &&
      paramName !== undefined &&
      paramAnchor.previousNamedSibling === null
    ) {
      grouped['@type-binding.first-parameter'] = syntheticCapture(
        '@type-binding.first-parameter',
        paramName,
        'true',
      );
    }

    // Relabel container-nested fns Function → Method (provider labelOverride
    // parity). The anchor capture name carries the kind, so rebuild it.
    const fnAnchor = nodeMap['@declaration.function'];
    if (fnAnchor !== undefined && isZigContainerMethod(fnAnchor)) {
      const fnCapture = grouped['@declaration.function']!;
      delete grouped['@declaration.function'];
      grouped['@declaration.method'] = { ...fnCapture, name: '@declaration.method' };
    }

    out.push(grouped);
  }

  out.push(...synthesizeCallableFlowCaptures(tree.rootNode, ZIG_CALLABLE_CAPTURE_OPTIONS));

  return out;
}
