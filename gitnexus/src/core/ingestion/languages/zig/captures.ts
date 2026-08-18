import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getZigParser, getZigScopeQuery } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { synthesizeCallableFlowCaptures } from '../../utils/callable-flow-captures.js';
import { hasZigPubKeyword } from '../../export-detection.js';

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
/** A binding whose name the type system already owns: a container / import
 *  binding, or the top-level `@This()` self-alias of a file-struct. None of
 *  these may mint a Const beside the Struct / import they stand for. */
export function isZigTypeShadowingBinding(declNode: SyntaxNode): boolean {
  if (isZigContainerOrImportBinding(declNode)) return true;
  return isZigFileThisAlias(declNode) && isZigFileStruct(declNode.parent);
}

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

/** Is `root` a FILE-STRUCT — a `.zig` file whose top level declares at least
 *  one container field? In Zig every file is a struct; one with fields is an
 *  instantiable type whose name is the file stem (`Page.zig` declares `Page`,
 *  `@typeName(Page)` is `"Page"`), and its top-level `fn`s taking `self` are
 *  its methods. A file WITHOUT fields is only a namespace and stays a Module:
 *  its fns keep their `Function` ids. The MISSING-identifier placeholder
 *  tree-sitter-zig recovers for an empty body is not a field (see
 *  `zigFieldConfig.extractName`). */
export function isZigFileStruct(root: SyntaxNode | null | undefined): boolean {
  if (root?.type !== 'source_file') return false;
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child?.type !== 'container_field') continue;
    const name = child.childForFieldName('name');
    if (name !== null && name.text.length > 0) return true;
  }
  return false;
}

/** The type name a file-struct declares: the file stem (`src/browser/Page.zig`
 *  → `Page`). This is what importers write (`const Page = @import("Page.zig")`)
 *  and what `@typeName` reports; the in-file `const Page = @This();` alias is
 *  a second spelling of the same type (see `zigThisAliasTargets`). */
export function zigFileStructName(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  return base.endsWith('.zig') ? base.slice(0, -'.zig'.length) : base;
}

/** Is `declNode` a top-level `const X = @This();` — the idiomatic self-alias of
 *  a file-struct? Such a binding names the FILE's own type, so a file-struct
 *  must not mint a `Const` (graph node or scope binding) beside the `Struct`
 *  it aliases — the Const would shadow the type for every `x: *Page`. */
export function isZigFileThisAlias(declNode: SyntaxNode): boolean {
  if (declNode.type !== 'variable_declaration' || declNode.parent?.type !== 'source_file') {
    return false;
  }
  if (!isZigKeywordDeclaration(declNode)) return false;
  const named = declNode.namedChildren.filter((c): c is SyntaxNode => c !== null);
  if (named.length !== 2 || named[0]!.type !== 'identifier') return false;
  const value = named[1]!;
  return (
    value.type === 'builtin_function' &&
    value.namedChild(0)?.type === 'builtin_identifier' &&
    value.namedChild(0)?.text === '@This'
  );
}

/** Does this module-level import binding REPUBLISH the name? `pub const Arena
 *  = @import("Arena.zig");` at file scope makes `Arena` part of this file's
 *  public surface: a third file reaches it as `lp.Arena` (Lightpanda's
 *  `lightpanda.zig` is one long list of these). Same fact as a Python
 *  `__init__.py` `from .impl import X` — the shared contract's
 *  `reexportsName` flag. Only `pub` at container level publishes; a `const`
 *  inside a fn body binds locally. */
export function isZigPublishingImport(declNode: SyntaxNode): boolean {
  return declNode.parent?.type === 'source_file' && hasZigPubKeyword(declNode);
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
export function zigContainerName(containerNode: SyntaxNode, filePath?: string): string | undefined {
  if (containerNode.type === 'source_file') {
    return filePath !== undefined && isZigFileStruct(containerNode)
      ? zigFileStructName(filePath)
      : undefined;
  }
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

/** F7 — is `call` an instantiation of a generic type constructor —
 *  `List(u8)`, `util.List(u8)`, `js.Bridge(T)`, `std.AutoHashMapUnmanaged(K, V)`?
 *  Zig spells a generic type as a CALL, and the grammar cannot separate it
 *  from a value call; the one signal is the naming convention (types and
 *  type constructors are TitleCase, functions camelCase), so the callee's
 *  last identifier decides. Heuristic by nature — say so wherever it is used. */
export function isZigTypeConstructorCall(call: SyntaxNode): boolean {
  if (call.type !== 'call_expression') return false;
  let callee = call.childForFieldName('function');
  if (callee?.type === 'field_expression') callee = callee.childForFieldName('member');
  if (callee?.type !== 'identifier') return false;
  return /^[A-Z]/.test(callee.text);
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
    // A top-level fn of a FILE-STRUCT is a method of the file's type.
    if (ancestor.type === 'source_file') return isZigFileStruct(ancestor);
    ancestor = ancestor.parent;
  }
  return false;
}

/** `{ '@import.reexports': 'true' }` when `stmt` is a publishing import
 *  (see `isZigPublishingImport`), else nothing — spread into an import group. */
function republishMarker(stmt: SyntaxNode): Record<string, Capture> {
  return isZigPublishingImport(stmt)
    ? { '@import.reexports': syntheticCapture('@import.reexports', stmt, 'true') }
    : {};
}

/** Every `const X = @This();` in the tree, keyed by the alias node id's owner:
 *  returns a map from the DECLARING container node id to `[aliasName,
 *  containerName]`. The file-level alias maps to the file-struct name (only
 *  when the file is a file-struct — a namespace-only file's `const js =
 *  @This();` stays a Const and is not a type to rewrite to). */
function collectZigThisAliases(
  root: SyntaxNode,
  fileStructName: string | undefined,
): Map<number, { readonly alias: string; readonly container: string }> {
  const out = new Map<number, { readonly alias: string; readonly container: string }>();
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'variable_declaration') {
      const named = node.namedChildren.filter((c): c is SyntaxNode => c !== null);
      const value = named[named.length - 1];
      if (
        named.length === 2 &&
        named[0]!.type === 'identifier' &&
        value?.type === 'builtin_function' &&
        value.namedChild(0)?.text === '@This' &&
        isZigKeywordDeclaration(node)
      ) {
        const owner = node.parent;
        if (owner?.type === 'source_file') {
          if (fileStructName !== undefined) {
            out.set(owner.id, { alias: named[0]!.text, container: fileStructName });
          }
        } else if (owner !== null && ZIG_CONTAINER_TYPES.has(owner.type)) {
          const containerName = zigContainerName(owner);
          if (containerName !== undefined) {
            out.set(owner.id, { alias: named[0]!.text, container: containerName });
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child !== null) visit(child);
    }
  };
  visit(root);
  return out;
}

/** If the nominal part of the type written at `typeNode` is a `@This()` alias
 *  of an enclosing container, the same text with the alias replaced by the
 *  container's name; undefined when nothing applies. Innermost container wins
 *  (a nested `Self` shadows the file's). */
function rewriteZigThisAlias(
  typeNode: SyntaxNode,
  aliases: ReadonlyMap<number, { readonly alias: string; readonly container: string }>,
  // The text to rewrite: the node's own, unless an earlier step (F6's value
  // inference) already replaced the capture text.
  text: string = typeNode.text,
): string | undefined {
  const nominal = /[A-Za-z_@][\w.]*(?:\([^)]*\))?\s*$/.exec(text)?.[0]?.trim();
  if (nominal === undefined || nominal.length === 0) return undefined;
  const bare = nominal.replace(/\(.*\)$/, '');
  let ancestor: SyntaxNode | null = typeNode.parent;
  while (ancestor !== null) {
    const entry = aliases.get(ancestor.id);
    if (entry !== undefined && entry.alias === bare) {
      if (entry.container === bare) return undefined;
      const idx = text.lastIndexOf(bare);
      return text.slice(0, idx) + entry.container + text.slice(idx + bare.length);
    }
    ancestor = ancestor.parent;
  }
  return undefined;
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
 * - Zig's receiver is an EXPLICIT first parameter named `self` (the same
 *   convention `interpretZigTypeBinding` keys receiver typing on), while a
 *   method call `x.f(cb)` passes `x` implicitly. Formals are therefore
 *   numbered without the leading `self`, so the actual at index 0 of
 *   `r.run(target)` joins `cb` and not `self` — hence
 *   `extractFunctionParameters`. The explicit-receiver spelling
 *   `Runner.run(&r, target)` is the one shape that no longer lines up.
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
  extractFunctionParameters: (fn: SyntaxNode) => {
    // `parameters` is a fieldless child of `function_declaration`.
    const list = fn.namedChildren.find((child) => child?.type === 'parameters');
    if (list === undefined || list === null) return undefined;
    const parameters = list.namedChildren.filter(
      (child): child is SyntaxNode => child !== null && child.type === 'parameter',
    );
    return parameters[0]?.childForFieldName('name')?.text === 'self'
      ? parameters.slice(1)
      : parameters;
  },
  extractCallArguments: (call: SyntaxNode) => {
    const callee = call.childForFieldName('function');
    return call.namedChildren.filter(
      (child): child is SyntaxNode =>
        child !== null && child.id !== callee?.id && child.type !== 'comment',
    );
  },
} as const;

// ─── F6: value-inferred and return-type bindings ─────────────────────────────

/** Strip the value wrappers Zig puts around a call — `try f()`, `f() catch
 *  …`, `f() orelse …`, `(f())` — down to the wrapped expression. Rust's
 *  `.await` unwrapping, one level richer. */
export function zigUnwrapValue(value: SyntaxNode): SyntaxNode {
  let cur = value;
  for (;;) {
    if (cur.type === 'try_expression' || cur.type === 'parenthesized_expression') {
      const inner = cur.namedChildren.find(
        (c): c is SyntaxNode => c !== null && c.type !== 'comment',
      );
      if (inner === undefined) return cur;
      cur = inner;
    } else if (cur.type === 'catch_expression') {
      // `<operand> catch [|err|] <handler>` — the operand is the first child.
      const inner = cur.namedChild(0);
      if (inner === null) return cur;
      cur = inner;
    } else if (cur.type === 'binary_expression') {
      if (cur.childForFieldName('operator')?.type !== 'orelse') return cur;
      const left = cur.childForFieldName('left');
      if (left === null) return cur;
      cur = left;
    } else {
      return cur;
    }
  }
}

/** Zig style: types are TitleCase, functions camelCase, namespaces
 *  snake_case. A TitleCase callee (`List(u8)`, `std.ArrayList(T)`) is a type
 *  constructor — its call yields a TYPE, not a value, and is a type alias
 *  (F7), not a call-return binding. */
function isZigTitleCase(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** The leftmost identifier of a `field_expression` chain (`self.parser` →
 *  `self`), the identifier itself, or null when the chain roots in anything
 *  else (a call, an index, a builtin). */
function zigChainHead(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  while (cur !== null && cur.type === 'field_expression') cur = cur.childForFieldName('object');
  return cur !== null && cur.type === 'identifier' ? cur : null;
}

/** Names bound INSIDE `fn` (parameters, `const`/`var` locals, payload
 *  captures), lazily computed once per function node. Zig forbids shadowing,
 *  so a name declared anywhere in the function is a value local everywhere in
 *  it, and a name NOT declared in it is a module-level (or imported) name.
 *  That is the whole distinction `zigCallReturnTypeOf` needs: a call on a
 *  local receiver (`node.asElement()`) yields the METHOD's return type, a
 *  call on a module-level receiver (`Counter.init()`, `mod.Counter.init()`)
 *  names the receiver's type. */
function zigFunctionLocalNames(fn: SyntaxNode, cache: Map<number, Set<string>>): Set<string> {
  const cached = cache.get(fn.id);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'parameter') {
      const name = node.childForFieldName('name');
      if (name !== null) names.add(name.text);
    } else if (node.type === 'variable_declaration' && isZigKeywordDeclaration(node)) {
      const first = node.namedChild(0);
      if (first?.type === 'identifier') names.add(first.text);
    } else if (node.type === 'payload') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c?.type === 'identifier') names.add(c.text);
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null) visit(c);
    }
  };
  visit(fn);
  cache.set(fn.id, names);
  return names;
}

/** The nearest enclosing `function_declaration` / `test_declaration`, or
 *  null at module (container) level. */
function zigEnclosingFunction(node: SyntaxNode): SyntaxNode | null {
  let cur = node.parent;
  while (cur !== null && cur !== undefined) {
    if (cur.type === 'function_declaration' || cur.type === 'test_declaration') return cur;
    cur = cur.parent;
  }
  return null;
}

/** For `const t = <value>;`, the type source the value names, or undefined
 *  when the value types nothing on its own:
 *    - `Counter.init()` / `mod.Counter.init()` / `List(u8).init()` (receiver
 *      is a module-level name) → `{ type: 'Counter' }` — the receiver names
 *      the type (Rust `Foo::new()`); a value receiver simply finds no
 *      container later and declines.
 *    - `node.asElement()` / `self.parser.next()` (receiver head is a fn-local
 *      param / local / payload) → `{ type: 'node.asElement()', memberCall:
 *      true }` — the compound shape the shared resolver walks through the
 *      receiver's class scope to the method's `@type-binding.return`.
 *    - `makeThing()` (free call) → `{ type: 'makeThing' }` — chains to the
 *      fn's return binding.
 *    - a `struct_initializer` under a wrapper (`try Thing{…}`) → its type,
 *      `structLiteral: true` (the direct shape has its own query rules).
 *    - `.init()` decl literals, TitleCase callees (type constructors —
 *      aliases, F7), identifiers, field chains, literals → undefined.
 *  Wrappers (`try`, `catch`, `orelse`, parens) are unwrapped first. */
export function zigCallReturnTypeOf(
  value: SyntaxNode,
  localNamesCache: Map<number, Set<string>>,
):
  | { readonly type: string; readonly memberCall?: true; readonly structLiteral?: true }
  | undefined {
  const inner = zigUnwrapValue(value);
  if (inner.type === 'struct_initializer') {
    if (inner.id === value.id) return undefined; // direct: the constructor rules own it
    const typeNode = inner.namedChild(0);
    if (
      typeNode === null ||
      !(
        typeNode.type === 'identifier' ||
        typeNode.type === 'field_expression' ||
        typeNode.type === 'call_expression'
      )
    ) {
      return undefined;
    }
    return { type: typeNode.text, structLiteral: true };
  }
  if (inner.type !== 'call_expression') return undefined;
  const callee = inner.childForFieldName('function');
  if (callee === null) return undefined;
  if (callee.type === 'identifier') {
    return isZigTitleCase(callee.text) ? undefined : { type: callee.text };
  }
  if (callee.type !== 'field_expression') return undefined;
  const object = callee.childForFieldName('object');
  const member = callee.childForFieldName('member');
  if (object === null || member === null) return undefined; // `.init()` decl literal
  if (isZigTitleCase(member.text)) return undefined;
  const head = zigChainHead(object);
  if (head !== null) {
    const fn = zigEnclosingFunction(value);
    // A fn-local name is a VALUE receiver — unless it is TitleCase: `const R
    // = generic.List(u8); var l = R.init();` binds a type alias inside the fn
    // (F7), and `R.init()` names the type `R` exactly like `Counter.init()`
    // does at module level. Zig's naming convention (types TitleCase, values
    // snake_case) is the same signal `isZigTypeConstructorCall` relies on.
    if (
      fn !== null &&
      zigFunctionLocalNames(fn, localNamesCache).has(head.text) &&
      !isZigTitleCase(head.text)
    ) {
      return { type: `${object.text}.${member.text}()`, memberCall: true };
    }
  }
  return { type: object.text };
}

/** Return-type node → the nominal type node under its sigils (`!*Thing` →
 *  `Thing`), following error-union `ok`, pointer / nullable / slice / array
 *  wrappers. Undefined when it bottoms out in nothing nominal. */
function zigNominalTypeNode(typeNode: SyntaxNode): SyntaxNode | undefined {
  let cur: SyntaxNode | null | undefined = typeNode;
  for (let guard = 0; cur !== null && cur !== undefined && guard < 16; guard++) {
    switch (cur.type) {
      case 'error_union_type':
        cur = cur.childForFieldName('ok');
        continue;
      case 'pointer_type':
      case 'nullable_type':
      case 'slice_type':
      case 'array_type':
        // The element type is the LAST named child (arrays carry the length
        // first, pointers/slices may carry a sentinel or `const`).
        cur = cur.namedChildren
          .filter((c): c is SyntaxNode => c !== null && c.type !== 'comment')
          .pop();
        continue;
      default:
        return cur;
    }
  }
  return undefined;
}

/** Should `fn name() <type>` bind `name ↦ <type>`? Only when the return
 *  type is nominal: a container name, a qualified name, a generic
 *  instantiation, or `@This()`. Builtins (`void`, `u8`, `bool`, `anyerror`),
 *  `type` (a generic type constructor — its container binding is the type),
 *  and `@TypeOf(…)` bind nothing: `List ↦ type` would hijack the
 *  `List(u8){}` constructor chain, and `f ↦ void` is noise. */
export function zigReturnTypeIsNominal(typeNode: SyntaxNode): boolean {
  const nominal = zigNominalTypeNode(typeNode);
  if (nominal === undefined) return false;
  switch (nominal.type) {
    case 'identifier':
      // `fn is(self: *Node, comptime T: type) ?*T` — `T` is the CALLER's
      // choice, not a type; binding `is ↦ T` would type every `node.is(X)`
      // as whatever class happens to be named `T`.
      return !zigIsComptimeTypeParameter(typeNode, nominal.text);
    case 'field_expression':
    case 'call_expression':
      return true;
    case 'builtin_function':
      return nominal.namedChild(0)?.text === '@This';
    default:
      return false;
  }
}

/** Is `name` a `comptime <name>: type` parameter of the function whose
 *  return type `returnTypeNode` is, or of any function enclosing it (the
 *  `T` of a generic type constructor is visible to every method of the
 *  returned container: `fn get(self) T`)? */
function zigIsComptimeTypeParameter(returnTypeNode: SyntaxNode, name: string): boolean {
  let fn: SyntaxNode | null | undefined = returnTypeNode.parent;
  while (fn !== null && fn !== undefined) {
    if (fn.type === 'function_declaration') {
      const params = fn.namedChildren.find((c) => c?.type === 'parameters');
      for (let i = 0; params !== undefined && params !== null && i < params.namedChildCount; i++) {
        const p = params.namedChild(i);
        if (p?.type !== 'parameter') continue;
        if (
          p.childForFieldName('name')?.text === name &&
          p.childForFieldName('type')?.text === 'type'
        ) {
          return true;
        }
      }
    }
    fn = fn.parent;
  }
  return false;
}

/** The container a `@This()` in `typeNode`'s position names: the innermost
 *  enclosing container's binding name, or the file-struct's name at file
 *  level. Undefined outside any named container. */
function zigThisTargetFor(
  typeNode: SyntaxNode,
  fileStructName: string | undefined,
): string | undefined {
  let cur = typeNode.parent;
  while (cur !== null && cur !== undefined) {
    if (ZIG_CONTAINER_TYPES.has(cur.type)) return zigContainerName(cur);
    if (cur.type === 'source_file') return fileStructName;
    cur = cur.parent;
  }
  return undefined;
}

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

  // File-struct (top-level fields): the file IS a type named after the file.
  // Emit a Class scope over the whole file (nested under the Module scope —
  // the equal-range Module/Class pair is the C# `namespace`-only-file shape
  // `canParentScope` admits) and a Struct def anchored on the same node, so
  // top-level fns/fields become its owned members (`populateClassOwnedMembers`)
  // and `self: *Page` / `page: *Page` resolve to a class-like def. Name
  // bindings of those members are hoisted back to the Module scope by
  // `zigBindingScopeFor` so `Page.init()` (namespace member) keeps working.
  const root = tree.rootNode;
  const fileStruct = isZigFileStruct(root);
  const fileStructName = fileStruct ? zigFileStructName(_filePath) : undefined;
  if (fileStruct && fileStructName !== undefined) {
    out.push({ '@scope.class': nodeToCapture('@scope.class', root) });
    out.push({
      '@declaration.struct': nodeToCapture('@declaration.struct', root),
      '@declaration.name': syntheticCapture('@declaration.name', root, fileStructName),
    });
  }
  // `@This()` aliases: alias name ↦ the container it names (file stem for the
  // file-struct, binding name for `const Self = @This();` inside a container).
  const thisAliases = collectZigThisAliases(root, fileStructName);
  // F6: fn-local names per function node, for `zigCallReturnTypeOf`.
  const fnLocalNames = new Map<number, Set<string>>();

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
        ...republishMarker(aliasStmt),
      });
      continue;
    }

    // F7 — type aliases (`@type-binding.alias`, see the query): keep the group
    // only for a value that is a TYPE expression. An identifier / member chain
    // is kept as written (a value alias such as `const log = lp.log` binds a
    // type name that resolves to nothing, exactly like Rust's `let x = y`); a
    // call is kept only when its callee's last identifier is TitleCase —
    // Zig's naming convention for types, hence for type constructors
    // (`util.List(u8)`, `js.Bridge(T)`, `GenericIterator(K, V)`). That is a
    // heuristic and the only one here: the grammar cannot tell a type
    // constructor call from a value call, and a value call (`const t =
    // util.makeThing()`) is typed by the call-return rules — a second binding
    // for the same name would race on match order. A promoted namespace-
    // member alias (`const Counter = counter.Counter;`) is skipped: it is a
    // named import already, and the import binding carries the type.
    const aliasAnchor = nodeMap['@type-binding.alias'];
    if (aliasAnchor !== undefined) {
      // An @import binding (`const Stack = @import("counter.zig").Stack;`) is
      // an import, and a promoted member alias a named import: both already
      // carry the type through the import binding.
      if (aliasDeclIds.has(aliasAnchor.id) || isZigContainerOrImportBinding(aliasAnchor)) continue;
      const value = nodeMap['@type-binding.type'];
      if (value === undefined) continue;
      // `var b: Counter = undefined;` — `undefined` / `null` are anonymous
      // nodes, so the last NAMED child the query anchored on is the `type:`
      // annotation, not a value. The annotation rule owns that binding.
      if (value.id === aliasAnchor.childForFieldName('type')?.id) continue;
      if (value.type === 'call_expression' && !isZigTypeConstructorCall(value)) continue;
      // `.foo` / `.init` (enum / decl literal) parses as a field_expression
      // without an object — a value, never a type name.
      if (value.type === 'field_expression' && value.childForFieldName('object') === null) continue;
    }
    // …and the converse: a call-return binding for `const B = util.List(u8)`
    // would type `B` as `util` (the call's receiver) and, at equal strength,
    // race the alias binding above on match order. A type-constructor
    // instantiation is the alias rule's; drop the call-return group for it.
    const callReturnAnchor = nodeMap['@type-binding.call-return'];
    if (callReturnAnchor !== undefined) {
      const named = callReturnAnchor.namedChildren.filter((c): c is SyntaxNode => c !== null);
      const value = named[named.length - 1];
      if (value?.type === 'call_expression' && isZigTypeConstructorCall(value)) continue;
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
        !isZigKeywordDeclaration(variableAnchor) ||
        // `const Page = @This();` in a file-struct names the file's own type,
        // which the synthetic `@declaration.struct` below already binds.
        (fileStruct && isZigFileThisAlias(variableAnchor)))
    ) {
      continue;
    }

    // F5 — `const page = self.page;` value aliases (`@type-binding.alias`)
    // share the query shape with `const Counter = counter.Counter;`, which is
    // a NAMED IMPORT of `Counter` (promoted above) — a type binding beside it
    // would make `Counter` look like an instance of the class it names. Drop
    // the alias binding for those declarations.
    const aliasBinding = nodeMap['@type-binding.alias'];
    if (aliasBinding !== undefined && aliasDeclIds.has(aliasBinding.id)) continue;

    // F6 — value-inferred bindings: `const t = [try] <call>` (see
    // `zigCallReturnTypeOf`). The query pins every keyword declaration; here
    // the value decides whether it types anything, and how. The value capture
    // is scaffolding and never leaves this function.
    const valueNode = nodeMap['@type-binding.value'];
    if (valueNode !== undefined && nodeMap['@type-binding.call-return'] !== undefined) {
      delete grouped['@type-binding.value'];
      // `const x: T;` (extern) — the trailing child is the type, not a value.
      if (valueNode.id === nodeMap['@type-binding.call-return'].childForFieldName('type')?.id) {
        continue;
      }
      const inferred = zigCallReturnTypeOf(valueNode, fnLocalNames);
      if (inferred === undefined) continue;
      grouped['@type-binding.type'] = syntheticCapture(
        '@type-binding.type',
        valueNode,
        inferred.type,
      );
      nodeMap['@type-binding.type'] = valueNode;
      if (inferred.structLiteral === true) {
        const anchor = grouped['@type-binding.call-return']!;
        delete grouped['@type-binding.call-return'];
        grouped['@type-binding.constructor'] = { ...anchor, name: '@type-binding.constructor' };
      } else if (inferred.memberCall === true) {
        grouped['@type-binding.member-call-return'] = syntheticCapture(
          '@type-binding.member-call-return',
          nodeMap['@type-binding.name']!,
          'true',
        );
      }
    }

    // F6 — return-type bindings: `fn make() !*Thing` binds `make ↦ Thing`.
    // Only nominal returns bind (see `zigReturnTypeIsNominal`); a bare
    // `@This()` return names the enclosing container by name (the alias
    // rewrite below handles the `Self` spelling of the same thing).
    const returnAnchor = nodeMap['@type-binding.return'];
    if (returnAnchor !== undefined) {
      const retType = nodeMap['@type-binding.type'];
      if (retType === undefined || !zigReturnTypeIsNominal(retType)) continue;
      if (retType.text.includes('@This()')) {
        const target = zigThisTargetFor(retType, fileStructName);
        if (target === undefined) continue;
        grouped['@type-binding.type'] = syntheticCapture(
          '@type-binding.type',
          retType,
          retType.text.replace('@This()', target),
        );
      }
    }

    // `@This()` aliases in type position — `self: *Self` in a container that
    // declares `const Self = @This();`, or `self: *SigHandler` in
    // `Sighandler.zig` (`const SigHandler = @This();`) — name the enclosing
    // container. Rewrite the type text to that container's name so the
    // receiver binding resolves to the Struct (Rust does the same for `Self`,
    // rust/captures.ts). Only the nominal part is rewritten; sigils stay.
    const typeNode = nodeMap['@type-binding.type'];
    if (typeNode !== undefined && thisAliases.size > 0) {
      const rewritten = rewriteZigThisAlias(
        typeNode,
        thisAliases,
        grouped['@type-binding.type']?.text,
      );
      if (rewritten !== undefined) {
        grouped['@type-binding.type'] = syntheticCapture('@type-binding.type', typeNode, rewritten);
      }
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

    // `pub const X = @import("x.zig").X;` at file scope republishes `X`.
    if (
      nodeMap['@import.statement'] !== undefined &&
      nodeMap['@import.imported'] !== undefined &&
      isZigPublishingImport(nodeMap['@import.statement'])
    ) {
      Object.assign(grouped, republishMarker(nodeMap['@import.statement']));
    }
    out.push(grouped);

    // F5 — field types. `session: *Session,` declares the TYPE of the member
    // `session`; the compound resolver reads member types from the owning
    // container's Class scope (`typeOfMemberOnClass` →
    // `classScope.typeBindings.get('session')`), so without a binding there
    // `self.session.name()` / `self.counter.incr()` never resolve (Lightpanda:
    // 9 of 2803 such calls, 0.3 %). Synthesize a `@type-binding.field` group
    // per typed field (Go does the same in go/captures.ts; Rust/C++ capture it
    // in the query). Enum variants carry no type and get no binding. The
    // group's anchor is the type node — inside the container, never equal to
    // its range — so the extractor hosts it in the container's Class scope
    // (the file's Class scope for a file-struct); `zigBindingScopeFor` hoists
    // only declaration NAMES, never `@type-binding.*`. `?*Self` /
    // `?*Page` (a `@This()` alias) is rewritten to the container name exactly
    // like a parameter type; `normalizeZigTypeName` reduces `?*Session`,
    // `[]const Counter` to the nominal name and the extractor keeps the
    // written spelling as `declaredSpelling`.
    const fieldAnchor = nodeMap['@declaration.field'];
    const fieldType = nodeMap['@declaration.field-type'];
    const fieldName = nodeMap['@declaration.name'];
    if (
      fieldAnchor !== undefined &&
      fieldType !== undefined &&
      fieldName !== undefined &&
      // An inline anonymous container (`opts: struct { a: u32 },`) names no
      // type; its own Class scope already owns its members.
      !ZIG_CONTAINER_TYPES.has(fieldType.type)
    ) {
      const rewritten =
        thisAliases.size > 0 ? rewriteZigThisAlias(fieldType, thisAliases) : undefined;
      out.push({
        '@type-binding.field': nodeToCapture('@type-binding.field', fieldType),
        '@type-binding.name': nodeToCapture('@type-binding.name', fieldName),
        '@type-binding.type':
          rewritten === undefined
            ? nodeToCapture('@type-binding.type', fieldType)
            : syntheticCapture('@type-binding.type', fieldType, rewritten),
      });
    }

    // `const Page = @import("Page.zig")` binds BOTH the module (namespace:
    // `Page.init()`) and, when the target is a file-struct, the type it
    // declares (`page: *Page`, `var p: Page`). The type is exported from the
    // target under its file stem, so emit a second, NAMED import of that stem
    // beside the namespace import. For a target that is only a namespace the
    // named import finds no such export and binds nothing.
    const importStmt = nodeMap['@import.statement'];
    if (
      importStmt !== undefined &&
      isZigKeywordDeclaration(importStmt) &&
      nodeMap['@import.imported'] === undefined &&
      nodeMap['@import.name'] !== undefined &&
      nodeMap['@import.source'] !== undefined
    ) {
      const source = nodeMap['@import.source'].text.replace(/^["']|["']$/g, '');
      if (source.endsWith('.zig')) {
        out.push({
          '@import.statement': grouped['@import.statement']!,
          '@import.name': grouped['@import.name']!,
          '@import.source': grouped['@import.source']!,
          '@import.imported': syntheticCapture(
            '@import.imported',
            nodeMap['@import.name'],
            zigFileStructName(source),
          ),
          // `pub const Arena = @import("Arena.zig");` republishes the TYPE too:
          // `lp.Arena` in a third file is the Struct `Arena.zig` declares.
          ...republishMarker(importStmt),
        });
      }
    }
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
