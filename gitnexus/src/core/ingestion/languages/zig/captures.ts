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

/** Is `node` the `@import(…)` builtin call? */
function isZigImportBuiltin(node: SyntaxNode | null): boolean {
  if (node?.type !== 'builtin_function') return false;
  const builtin = node.namedChild(0);
  return builtin?.type === 'builtin_identifier' && builtin.text === '@import';
}

/** The `@import(…)` call at the ROOT of a value expression: the value itself
 *  (`@import("x.zig")`) or the leftmost object of a member chain
 *  (`@import("x.zig").Foo`, `@import("std").mem.Allocator`). Null otherwise. */
export function zigImportRootOf(value: SyntaxNode | null): SyntaxNode | null {
  let cur = value;
  while (cur?.type === 'field_expression') cur = cur.childForFieldName('object');
  return isZigImportBuiltin(cur) ? cur : null;
}

/** Is this `@import(…)` builtin the receiver of a member call —
 *  `@import("dump.zig").root(...)` — i.e. the `object` of a `field_expression`
 *  that is the `function` of a `call_expression`? A deeper chain
 *  (`@import("x.zig").Foo.init()`) is not: its receiver is `….Foo`, and the
 *  builtin is only the module the chain starts from. */
export function isZigInlineImportReceiver(importNode: SyntaxNode): boolean {
  const field = importNode.parent;
  if (field?.type !== 'field_expression') return false;
  if (field.childForFieldName('object')?.id !== importNode.id) return false;
  const call = field.parent;
  return call?.type === 'call_expression' && call.childForFieldName('function')?.id === field.id;
}

/** Is this variable_declaration a container binding (`const T = struct {…}`)
 *  or an import binding (`const x = @import("…")`, `const X = @import("…").X`)?
 *  Those groups are emitted by their dedicated query rules; the plain
 *  @declaration.variable / @definition.const match for the same node must be
 *  dropped so the name binds exactly once (and no Const node shadows the
 *  Struct / import). Shared by the scope walker, the variable extractor and
 *  the provider's `shouldSkipDefinitionCapture` so the structure-phase records
 *  and the scope-side bindings agree on what counts as a plain variable. */
export function isZigContainerOrImportBinding(declNode: SyntaxNode): boolean {
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (child === null) continue;
    if (ZIG_CONTAINER_TYPES.has(child.type)) return true;
    if (zigImportRootOf(child) !== null) return true;
  }
  return false;
}

/** Does this `variable_declaration` carry a `const` / `var` keyword child?
 *  tree-sitter-zig 1.1.2 parses statement-position ASSIGNMENTS (`x = 5;`,
 *  `x += 1;`, `_ = expr;`) as `variable_declaration` too — the only thing
 *  that separates a real binding from a re-assignment is the keyword. Query
 *  rules match the keyword literally; this is the JS-side twin for the
 *  extractors and the phantom-local guard in `emitZigScopeCaptures`. */
export function isZigKeywordDeclaration(declNode: SyntaxNode): boolean {
  for (let i = 0; i < declNode.childCount; i++) {
    const t = declNode.child(i)?.type;
    if (t === 'const' || t === 'var') return true;
  }
  return false;
}

/** The binding name of a Zig container node, or undefined for a truly
 *  anonymous one. Two shapes carry a name:
 *    - `const Point = struct {…}` — the first identifier of the wrapping
 *      `variable_declaration`;
 *    - `pub fn List(comptime T: type) type { return struct {…}; }` — the
 *      generic type constructor. Zig has no other spelling for a generic
 *      type, and every reader calls the returned container `List`, so the
 *      enclosing function's name IS the type name (`ArrayList(u8)`).
 *  Single source for the class/field/method extractor configs. */
export function zigContainerName(containerNode: SyntaxNode): string | undefined {
  const parent = containerNode.parent;
  if (parent === null || parent === undefined) return undefined;
  if (parent.type === 'variable_declaration') {
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (child?.type === 'identifier') return child.text;
    }
    return undefined;
  }
  return zigTypeConstructorOf(containerNode)?.childForFieldName('name')?.text;
}

/** For a container that is the direct `return` value of a function whose
 *  return type is `type` — `fn List(comptime T: type) type { return struct
 *  {…}; }` — the function_declaration; null for any other placement. Only the
 *  literal `return_expression → expression_statement → block → fn` chain
 *  counts: a container nested deeper (`return struct {…}.field`, a container
 *  inside an `if`) is not the type the function constructs. */
export function zigTypeConstructorOf(containerNode: SyntaxNode): SyntaxNode | null {
  if (!ZIG_CONTAINER_TYPES.has(containerNode.type)) return null;
  const ret = containerNode.parent;
  if (ret?.type !== 'return_expression') return null;
  const stmt = ret.parent;
  if (stmt?.type !== 'expression_statement') return null;
  const block = stmt.parent;
  if (block?.type !== 'block') return null;
  const fn = block.parent;
  if (fn?.type !== 'function_declaration' || fn.childForFieldName('body')?.id !== block.id) {
    return null;
  }
  return fn.childForFieldName('type')?.text === 'type' ? fn : null;
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

  // Pre-pass: this file's `@import` bindings (`const counter =
  // @import("counter.zig")` → counter ↦ the string node), so a member alias
  // `const Counter = counter.Counter;` can be promoted to a named import of
  // `Counter` from `counter.zig` below. Aliases are collected in the same
  // pass so their plain-variable group is dropped (a local Const binding
  // would outrank the import binding it stands for).
  const importSources = new Map<string, SyntaxNode>();
  const aliasDeclIds = new Set<number>();
  // The `@import(…)` string nodes a BINDING rule (or the keyword-less
  // side-effect rule) matched, by node id, plus their texts. The catch-all
  // `@import.inline` rule matches those same builtins again; the id set
  // keeps a bound import from being doubled, the text set keeps a second
  // spelling of an already-imported file from adding a redundant edge.
  const claimedImportSourceIds = new Set<number>();
  const importedSourceTexts = new Set<string>();
  for (const m of rawMatches) {
    const byName = new Map(m.captures.map((c) => [c.name, c.node] as const));
    const importName = byName.get('import.name');
    const importSource = byName.get('import.source');
    const importStmt = byName.get('import.statement');
    if (
      importSource !== undefined &&
      (importStmt !== undefined ||
        byName.get('import.side-effect') !== undefined ||
        byName.get('import.wildcard') !== undefined)
    ) {
      claimedImportSourceIds.add(importSource.id);
      importedSourceTexts.add(importSource.text);
    }
    if (
      importName !== undefined &&
      importSource !== undefined &&
      byName.get('import.imported') === undefined &&
      importStmt !== undefined &&
      importStmt.parent?.type === 'source_file' &&
      isZigKeywordDeclaration(importStmt)
    ) {
      importSources.set(importName.text, importSource);
    }
  }
  for (const m of rawMatches) {
    const byName = new Map(m.captures.map((c) => [c.name, c.node] as const));
    const stmt = byName.get('alias.statement');
    const ns = byName.get('alias.namespace');
    if (stmt !== undefined && ns !== undefined && importSources.has(ns.text)) {
      aliasDeclIds.add(stmt.id);
    }
  }

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

    // `_ = @import("x.zig");` and any other keyword-less `<ident> =
    // @import(…)`: a statement (tree-sitter-zig reuses variable_declaration
    // for assignments), not a declaration. It references the file without
    // binding a name → side-effect import (file edge only). The query rule
    // cannot exclude the keyword-bearing shapes, so drop those here — they
    // are the binding rules' matches. A keyword-less shape never enters
    // `importSources`, so it cannot promote aliases.
    const sideEffectStmt = nodeMap['@import.side-effect'];
    if (sideEffectStmt !== undefined) {
      if (isZigKeywordDeclaration(sideEffectStmt)) continue;
      out.push({
        '@import.side-effect': grouped['@import.side-effect']!,
        '@import.source': grouped['@import.source']!,
      });
      continue;
    }

    // `@import("…")` in expression position — a tuple element, a call
    // argument, a comparison operand, a member-call receiver, a chain deeper
    // than the binding rules follow. Skip the builtins a binding rule (or the
    // keyword-less side-effect rule) already owns; the rest are file
    // dependencies without a name. The receiver of a member call
    // (`try @import("dump.zig").root(...)`) is more: it is a namespace used
    // in place. Bind it as a namespace import whose local name IS the
    // builtin's own text — `@reference.receiver` on that call carries the
    // same text, so the shared Case-1 namespace-receiver lookup resolves
    // `root` in dump.zig exactly as it would for `const dump =
    // @import("dump.zig"); dump.root(...)`. Anything else is a side-effect
    // import (file edge only), emitted once per distinct source per file.
    const inlineImport = nodeMap['@import.inline'];
    if (inlineImport !== undefined) {
      const source = nodeMap['@import.source']!;
      if (claimedImportSourceIds.has(source.id)) continue;
      const sourceCapture = grouped['@import.source']!;
      if (isZigInlineImportReceiver(inlineImport)) {
        const key = `receiver:${source.text}`;
        if (importedSourceTexts.has(key)) continue;
        importedSourceTexts.add(key);
        out.push({
          '@import.statement': nodeToCapture('@import.statement', inlineImport),
          '@import.name': nodeToCapture('@import.name', inlineImport),
          '@import.source': sourceCapture,
        });
        continue;
      }
      if (importedSourceTexts.has(source.text)) continue;
      importedSourceTexts.add(source.text);
      out.push({
        '@import.side-effect': nodeToCapture('@import.side-effect', inlineImport),
        '@import.source': sourceCapture,
      });
      continue;
    }

    // Member aliases: promote to a named import when the object is one of
    // this file's @import bindings; otherwise the group is inert (the same
    // node is also matched by the plain-variable rule).
    const aliasStmt = nodeMap['@alias.statement'];
    if (aliasStmt !== undefined) {
      if (!aliasDeclIds.has(aliasStmt.id)) continue;
      const source = importSources.get(nodeMap['@alias.namespace']!.text)!;
      out.push({
        '@import.statement': nodeToCapture('@import.statement', aliasStmt),
        '@import.name': nodeToCapture('@import.name', nodeMap['@alias.name']!),
        '@import.imported': nodeToCapture('@import.imported', nodeMap['@alias.member']!),
        '@import.source': nodeToCapture('@import.source', source),
      });
      continue;
    }

    // Drop the plain-variable group for container/import bindings — their
    // dedicated rules already bind the name (as Struct/Enum/Union or import).
    // The query already requires a `const`/`var` keyword, so statement
    // assignments (`x = 5;`, `_ = expr;` — same node type, no keyword) never
    // mint phantom locals; `isZigKeywordDeclaration` is the belt to that
    // brace should the rule ever be loosened.
    const variableAnchor = nodeMap['@declaration.variable'];
    if (
      variableAnchor !== undefined &&
      (isZigContainerOrImportBinding(variableAnchor) ||
        aliasDeclIds.has(variableAnchor.id) ||
        !isZigKeywordDeclaration(variableAnchor))
    ) {
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

    // Mark containers returned by a generic type constructor so
    // `zigBindingScopeFor` hoists their name to the module scope (beside the
    // Function def of the same name) instead of the fn body it sits in.
    for (const kind of ['@declaration.struct', '@declaration.union', '@declaration.enum']) {
      const containerAnchor = nodeMap[kind];
      const nameNode = nodeMap['@declaration.name'];
      if (
        containerAnchor !== undefined &&
        nameNode !== undefined &&
        zigTypeConstructorOf(containerAnchor) !== null
      ) {
        grouped['@declaration.type-constructor'] = syntheticCapture(
          '@declaration.type-constructor',
          nameNode,
          'true',
        );
      }
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

  // A generic type constructor yields two module-scope defs of one name: the
  // Function `Stack` and the Struct `Stack` it returns. Import materialization
  // keeps the FIRST def of a name (finalize `indexExportsByName`), and query
  // order puts the fn (outer node) first — so `const Stack =
  // @import("x.zig").Stack;` bound the Function and `Stack(u8){}` typed
  // nothing. Emit the container def ahead of its constructor: the type is what
  // an importer instantiates, and the free call `Stack(u8)` still resolves
  // (a Struct is a valid call target — the constructor-reference path).
  for (let i = 0; i < out.length; i++) {
    const group = out[i]!;
    if (group['@declaration.type-constructor'] === undefined) continue;
    const anchor =
      group['@declaration.struct'] ?? group['@declaration.union'] ?? group['@declaration.enum'];
    if (anchor === undefined) continue;
    for (let j = 0; j < i; j++) {
      const fn = out[j]!['@declaration.function'];
      if (fn === undefined) continue;
      if (
        fn.range.startLine < anchor.range.startLine ||
        (fn.range.startLine === anchor.range.startLine &&
          fn.range.startCol <= anchor.range.startCol)
      ) {
        if (
          fn.range.endLine > anchor.range.endLine ||
          (fn.range.endLine === anchor.range.endLine && fn.range.endCol >= anchor.range.endCol)
        ) {
          out.splice(j, 0, ...out.splice(i, 1));
          break;
        }
      }
    }
  }

  out.push(...synthesizeCallableFlowCaptures(tree.rootNode, ZIG_CALLABLE_CAPTURE_OPTIONS));

  return out;
}
