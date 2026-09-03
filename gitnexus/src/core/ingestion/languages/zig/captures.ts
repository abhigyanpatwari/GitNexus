import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getZigParser, getZigScopeQuery } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { synthesizeCallableFlowCaptures } from '../../utils/callable-flow-captures.js';
import { hasZigPubKeyword } from '../../export-detection.js';
import { normalizeZigTypeName } from './interpret.js';
import {
  buildZigBoolConstMap,
  collectZigStaticGatedRanges,
  isPositionStaticGated,
  type ZigImportAliasMap,
} from '../../call-extractors/zig-static-gating.js';

/**
 * A call capture inside an `if (CONST_FALSE)` body (or the `else` of an
 * `if (CONST_TRUE)`) gets this extra key; `scope-extractor` turns it into
 * `ReferenceSite.staticGated`
 * and the emitters copy it onto the CALLS edge. Same idiom as Go's
 * `@reference.callee-position`: a zero-range marker, present or absent, so
 * every ungated site's capture set stays byte-identical.
 */
const ZERO_RANGE = Object.freeze({ startLine: 0, startCol: 0, endLine: 0, endCol: 0 });
const STATIC_GATED_MARKER: Capture = Object.freeze({
  name: '@reference.static-gated',
  range: ZERO_RANGE,
  text: '',
});
const NO_IMPORT_ALIASES: ZigImportAliasMap = new Map();

/** Stamp `@reference.static-gated` onto every call capture whose anchor sits
 *  in a statically dead range. File-local constants only for now (v1): the
 *  cross-file alias walk in `zig-static-gating.ts` needs the repo file list,
 *  which the capture layer does not see. */
function stampZigStaticGating(
  out: readonly CaptureMatch[],
  root: SyntaxNode,
): readonly CaptureMatch[] {
  // No early return on an empty constant table: `collectZigStaticGatedRanges`
  // also folds bare literals (`if (false) { ... }`), which need no constants.
  const bools = buildZigBoolConstMap(root);
  const ranges = collectZigStaticGatedRanges(root, bools, NO_IMPORT_ALIASES, () => undefined);
  if (ranges.length === 0) return out;
  return out.map((m) => {
    const key = Object.keys(m).find((k) => k.startsWith('@reference.call.'));
    if (key === undefined) return m;
    const anchor = m[key];
    if (anchor === undefined) return m;
    return isPositionStaticGated(anchor.range.startLine, anchor.range.startCol, ranges)
      ? { ...m, '@reference.static-gated': STATIC_GATED_MARKER }
      : m;
  });
}

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
 *  `@import("dump.zig").root(...)` — or of a qualified construction —
 *  `@import("a.zig").Thing{…}` — i.e. the `object` of a `field_expression`
 *  that is the `function` of a `call_expression` or the type of a
 *  `struct_initializer`? A deeper chain (`@import("x.zig").Foo.init()`) is
 *  not: its receiver is `….Foo`, and the builtin is only the module the chain
 *  starts from (the namespace chain walk resolves it from there). */
export function isZigInlineImportReceiver(importNode: SyntaxNode): boolean {
  const field = importNode.parent;
  if (field?.type !== 'field_expression') return false;
  if (field.childForFieldName('object')?.id !== importNode.id) return false;
  const use = field.parent;
  if (use === null || use === undefined) return false;
  if (use.type === 'call_expression') return use.childForFieldName('function')?.id === field.id;
  // `@import("a.zig").Thing{…}` — the module is the receiver of a qualified
  // CONSTRUCTION (the `@reference.call.constructor` rule with a receiver, see
  // the query), exactly as it is of a member call. Without the namespace
  // binding the site had a receiver nothing was bound to, so the aggregate
  // event had no target (PR #1432 review, 8.11).
  return use.type === 'struct_initializer' && use.namedChild(0)?.id === field.id;
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
  const typeNode = declNode.childForFieldName('type');
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (child === null) continue;
    if (ZIG_CONTAINER_TYPES.has(child.type)) return true;
    // Only the VALUE binds an import: `var x: @import("foo.zig").T =
    // undefined;` types a plain variable by an imported type, it imports
    // nothing under `x` (see `isZigTypePositionImport`).
    if (child.id === typeNode?.id) continue;
    if (zigImportRootOf(child) !== null) return true;
  }
  return false;
}

/** Does the `@import(…)` a binding rule matched sit in the TYPE annotation of
 *  its declaration (`var x: @import("foo.zig").T = undefined;`) rather than
 *  in its value? `variable_declaration` is fieldless except for `type:`, so
 *  the query cannot tell the two positions apart; such a match must not bind
 *  `x` as an import — `x` is a variable, and the `@import` is only a file
 *  dependency (the `@import.inline` rule records it as a side-effect import
 *  once this match releases the source node). */
export function isZigTypePositionImport(stmt: SyntaxNode, source: SyntaxNode): boolean {
  const typeNode = stmt.childForFieldName('type');
  return (
    typeNode !== null &&
    typeNode.startIndex <= source.startIndex &&
    source.endIndex <= typeNode.endIndex
  );
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

/** Is `root` a FILE-STRUCT — a `.zig` file that IS a type? In Zig every file
 *  is a struct; the ones that matter as types are named after the file stem
 *  (`Page.zig` declares `Page`, `@typeName(Page)` is `"Page"`) and their
 *  top-level `fn`s taking a receiver are its methods. Two signals, either one
 *  suffices:
 *    - the top level declares at least one container field (an instantiable
 *      type with state); the MISSING-identifier placeholder tree-sitter-zig
 *      recovers for an empty body is not a field (see
 *      `zigFieldConfig.extractName`);
 *    - a top-level `fn` takes the file's OWN type as its first parameter —
 *      `self: *@This()`, or `self: *Self` with `const Self = @This();` at
 *      file level. A zero-sized file type (`Empty.zig`: no field, a `Self`
 *      alias and `pub fn ping(self: *Self)`) is still constructed (`Empty{}`)
 *      and dispatched on by importers; keyed on fields alone it lost its
 *      `Struct`, its `HAS_METHOD`s and every `e.ping()` edge (PR #1432
 *      review, 8.12).
 *  A file with neither is a namespace and stays a Module: its fns keep their
 *  `Function` ids, and a `const js = @This();` there stays a Const. Only the
 *  receiver TYPE decides, never the parameter name: `fn f(self: Foo)` in a
 *  utility file is a free function that happens to call its argument `self`. */
export function isZigFileStruct(root: SyntaxNode | null | undefined): boolean {
  if (root?.type !== 'source_file') return false;
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child?.type !== 'container_field') continue;
    const name = child.childForFieldName('name');
    if (name !== null && name.text.length > 0) return true;
  }
  let aliases: Set<string> | undefined;
  for (let i = 0; i < root.namedChildCount; i++) {
    const fn = root.namedChild(i);
    if (fn?.type !== 'function_declaration') continue;
    const first = fn.namedChildren
      .find((c): c is SyntaxNode => c?.type === 'parameters')
      ?.namedChild(0);
    const typeNode = first?.type === 'parameter' ? first.childForFieldName('type') : null;
    if (typeNode === null || typeNode === undefined) continue;
    const nominal = zigParameterNominalType(typeNode.text);
    if (nominal === '@This()') return true;
    aliases ??= zigThisAliasNamesIn(root);
    if (aliases.has(nominal)) return true;
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

/** The BINDING name of a Zig container node — the spelling code uses to
 *  refer to it — or undefined for a truly anonymous one. Three shapes carry
 *  one:
 *    - a file-struct: the file stem (`Page.zig` → `Page`);
 *    - `const Point = struct {…}` — the first identifier of the wrapping
 *      `variable_declaration`;
 *    - `pub fn List(comptime T: type) type { return struct {…}; }` — the
 *      generic type constructor. Zig has no other spelling for a generic
 *      type, and every reader calls the returned container `List`, so the
 *      enclosing function's name IS the type name (`ArrayList(u8)`).
 *  This is what scope-side NAME BINDINGS use (`R.get()`, `self: *R`, a
 *  `const Self = @This();` rewrite). The graph IDENTITY of a container is
 *  `zigContainerName`, which equals the binding name except for the
 *  function-local and anonymous shapes (F8). */
export function zigContainerBindingName(
  containerNode: SyntaxNode,
  filePath?: string,
): string | undefined {
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

/** The nominal type spelled at a parameter with its sigils stripped:
 *  `*const Self` → `Self`, `?*T` → `T`, `Pool(Node)` → `Pool`; `@This()` is
 *  kept whole (a builtin, not a constructor name). */
function zigParameterNominalType(typeText: string): string {
  let t = typeText.trim();
  let previous: string;
  do {
    previous = t;
    t = t.replace(/^(?:\*|\?|const\s+|\s+)/, '');
  } while (t !== previous);
  if (!t.startsWith('@')) {
    const paren = t.indexOf('(');
    if (paren > 0) t = t.slice(0, paren).trim();
  }
  return t;
}

/** The `const X = @This();` alias names declared DIRECTLY in `container` (a
 *  container node, or the root of a file-struct). */
function zigThisAliasNamesIn(container: SyntaxNode): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < container.namedChildCount; i++) {
    const decl = container.namedChild(i);
    if (decl === null || decl.type !== 'variable_declaration') continue;
    const named = decl.namedChildren.filter((c): c is SyntaxNode => c !== null);
    const value = named[named.length - 1];
    if (
      named.length === 2 &&
      named[0]!.type === 'identifier' &&
      value?.type === 'builtin_function' &&
      value.namedChild(0)?.text === '@This' &&
      isZigKeywordDeclaration(decl)
    ) {
      out.add(named[0]!.text);
    }
  }
  return out;
}

/** The RECEIVER parameter of a container method, or null for a static fn.
 *
 *  Zig has no receiver keyword: `self` is a convention, not a rule, and real
 *  code names the receiver after its type as often as not — tigerbeetle
 *  (`replica: *Replica`, 777 of 1127 methods), mach (`pool: *@This()`, 764 of
 *  833). Treating only `self` as the receiver labelled those methods static,
 *  counted the receiver in their arity (`Counter.incr#1`) and left the
 *  scope-side binding sourced as a plain parameter. The rule, applied to the
 *  FIRST parameter only:
 *    - named `self`, whatever its type; or
 *    - typed as the enclosing container: `@This()`, the container's binding
 *      name (`Counter`, the generic constructor `Pool` for `Pool(Node)`, the
 *      file stem for a file-struct when `filePath` is known), or a
 *      `const X = @This();` alias declared in that container (`Self`, `PRNG`
 *      in `prng.zig`) — pointers, `const` and optionals stripped.
 *  `fn` must be a direct child of a container (or the file root); a fn nested
 *  in a body is never a method. Single source for the method extractor
 *  (parameters / receiver type / `isStatic`) and `emitZigScopeCaptures`
 *  (`@type-binding.receiver`), so the structure and scope phases agree. */
export function zigReceiverParameter(fn: SyntaxNode, filePath?: string): SyntaxNode | null {
  const container = fn.parent;
  if (container === null || container === undefined) return null;
  const inContainer = ZIG_CONTAINER_TYPES.has(container.type);
  const inFileStruct = container.type === 'source_file' && isZigFileStruct(container);
  if (!inContainer && !inFileStruct) return null;
  const paramList = fn.namedChildren.find(
    (child): child is SyntaxNode => child?.type === 'parameters',
  );
  const first = paramList?.namedChild(0);
  if (first === null || first === undefined || first.type !== 'parameter') return null;
  if (first.childForFieldName('name')?.text === 'self') return first;
  const typeNode = first.childForFieldName('type');
  if (typeNode === null) return null;
  const nominal = zigParameterNominalType(typeNode.text);
  if (nominal.length === 0) return null;
  if (nominal === '@This()') return first;
  if (zigThisAliasNamesIn(container).has(nominal)) return first;
  const binding = zigContainerBindingName(container, filePath);
  return binding !== undefined && nominal === binding ? first : null;
}

/** The graph IDENTITY of a Zig container node — the name its class-like
 *  node, its members' owner segment (`Method:<file>:<name>.<fn>`) and the
 *  scope-side def all carry. Single source for the class/field/method
 *  extractor configs, the provider's `resolveContainerTypeOwner` hook (the
 *  structure phase's owner walk) and `emitZigScopeCaptures`, so the two
 *  phases agree by construction.
 *
 *    - file-struct / `const T = struct {…}` at file level / generic type
 *      constructor: the binding name (`zigContainerBindingName`).
 *    - CONTAINER-HOSTED named container — `pub const Item = struct {…}`
 *      inside `const A = struct {…}`: owner-qualified, `A.Item` (recursively:
 *      `A.B.Item`). By binding name alone `A.Item` and `B.Item` — two
 *      distinct types, each with its own `run` — shared ONE `Struct:<file>:
 *      Item` node and one `Item.run` (PR #1432 review, 8.5). The scope side
 *      still binds the lexical spelling `Item` inside `A` (the
 *      `@declaration.binding-name` split in `emitZigScopeCaptures`), and the
 *      shared `populateClassOwnedMembers` leaves a dotted qualified name
 *      alone, so the def and the graph node agree on `A.Item` and its members
 *      qualify as `A.Item.run` — the same shape Java's `Outer.Inner` takes.
 *    - FUNCTION-LOCAL named container (F8) — `const R = struct {…}` inside a
 *      `fn` or `test` body: `<enclosing callable>$<name>`, e.g. `string$R`,
 *      `Reflect.string$R`. Zig code declares such helper containers per
 *      builder function (Lightpanda's `reflection.zig` has ~20 `const R =
 *      struct { fn get… fn set… }`), and by binding name alone they all
 *      collapsed onto ONE `Struct:<file>:R` with one `R.get`. Java's local
 *      classes are keyed the same way (`Outer$1Local`); the `$` is what tells
 *      the shared `populateClassOwnedMembers` the name is already complete.
 *      Two same-named locals in sibling blocks of ONE callable still share
 *      an identity (Zig code does not do that; javac's ordinal would).
 *    - ANONYMOUS container (F8) — `struct { fn lessThan(…) … }.lessThan`
 *      passed to `std.sort.pdq`, `const cmp = struct {…}.lt;`, a field or
 *      parameter typed `struct { min: u32 }`: `<host>$<ordinal>` where the
 *      host is the enclosing callable (`build$1`), else the enclosing
 *      container (`Outer$1`), else the file stem (`util$1`), and the ordinal
 *      counts the anonymous containers of that host in source order —
 *      javac's `Outer$1` rule (`synthesizeJavaTypeIdentity`). Without an
 *      identity their fns were OWNERLESS Methods (`Method:<file>:lessThan`),
 *      and same-named ones in one file collided on a single node.
 *  Deterministic in the tree alone, so any two walks over one source agree. */
export function zigContainerName(containerNode: SyntaxNode, filePath?: string): string | undefined {
  const binding = zigContainerBindingName(containerNode, filePath);
  if (containerNode.type === 'source_file') return binding;
  if (!ZIG_CONTAINER_TYPES.has(containerNode.type)) return undefined;
  const host = zigIdentityHost(containerNode);
  if (binding !== undefined) {
    if (containerNode.parent?.type !== 'variable_declaration' || host === null) return binding;
    if (isZigCallableNode(host)) return `${zigCallableQualifiedName(host, filePath)}$${binding}`;
    if (ZIG_CONTAINER_TYPES.has(host.type)) {
      const hostName = zigContainerName(host, filePath);
      return hostName === undefined ? binding : `${hostName}.${binding}`;
    }
    return binding; // file level: the binding name is the identity
  }
  const ordinal = zigAnonymousContainerOrdinal(containerNode);
  const prefix = host === null ? undefined : zigAnonymousHostPrefix(host, filePath);
  return `${prefix ?? ''}$${ordinal}`;
}

/** The label the graph gives a container node (`opaque {}` is a fieldless
 *  container that may own methods — Struct, see ZIG_QUERIES). */
export function zigContainerLabel(
  containerNode: SyntaxNode,
): 'Struct' | 'Enum' | 'Union' | undefined {
  switch (containerNode.type) {
    case 'struct_declaration':
    case 'opaque_declaration':
      return 'Struct';
    case 'enum_declaration':
      return 'Enum';
    case 'union_declaration':
      return 'Union';
    default:
      return undefined;
  }
}

/** Which ZIG_QUERIES rule mints a container's graph node (F8):
 *    - 'wrapper': `const T = struct {…}` at FILE level — the
 *      `variable_declaration … @definition.struct` rule (name from `@name`);
 *    - 'constructor': the container a generic type constructor returns —
 *      the `fn … type { return struct {…}; }` rule;
 *    - 'container': everything the bare `(struct_declaration)
 *      @definition.struct` rule owns — FUNCTION-LOCAL and CONTAINER-HOSTED
 *      named containers (their identities `string$R` / `A.Item` are not
 *      captures, so the class extractor names them via `zigContainerName`)
 *      and ANONYMOUS containers.
 *  The provider's `shouldSkipClassCapture` drops the other rules' matches for
 *  the same node so each container is minted exactly once. */
export function zigContainerAnchor(
  containerNode: SyntaxNode,
): 'wrapper' | 'constructor' | 'container' | 'file' {
  if (containerNode.type === 'source_file') return 'file';
  if (zigTypeConstructorOf(containerNode) !== null) return 'constructor';
  if (
    containerNode.parent?.type === 'variable_declaration' &&
    zigContainerBindingName(containerNode) !== undefined
  ) {
    const host = zigIdentityHost(containerNode);
    return host === null || host.type === 'source_file' ? 'wrapper' : 'container';
  }
  return 'container';
}

/** Is this `@definition.<container>` match of ZIG_QUERIES REDUNDANT — i.e.
 *  minted by another rule for the same container (F8)? `definitionNode` is
 *  the match anchor (the wrapper `variable_declaration`, or the container
 *  node for the type-constructor and bare-container rules), `nameNode` its
 *  `@name` capture (the type-constructor rule captures the fn's name, the
 *  bare rule captures none). Wired through the provider's
 *  `shouldSkipDefinitionCapture`, which the definition phase consults for
 *  EVERY label — `shouldSkipClassCapture` would not see `Union`. */
export function isZigRedundantContainerCapture(
  definitionNode: SyntaxNode,
  nameNode: SyntaxNode | undefined,
): boolean {
  let container: SyntaxNode | undefined;
  if (ZIG_CONTAINER_TYPES.has(definitionNode.type)) {
    container = definitionNode;
  } else if (definitionNode.type === 'variable_declaration') {
    for (let i = 0; i < definitionNode.namedChildCount; i++) {
      const child = definitionNode.namedChild(i);
      if (child !== null && ZIG_CONTAINER_TYPES.has(child.type)) {
        container = child;
        break;
      }
    }
  }
  if (container === undefined) return false;
  const anchor = zigContainerAnchor(container);
  if (definitionNode.type === 'variable_declaration') return anchor !== 'wrapper';
  return nameNode !== undefined ? anchor !== 'constructor' : anchor !== 'container';
}

/** A callable body in Zig: a `fn` or a `test` block. */
function isZigCallableNode(node: SyntaxNode): boolean {
  return node.type === 'function_declaration' || node.type === 'test_declaration';
}

/** The nearest ancestor that hosts identities — a callable, a container or
 *  the file — starting from `node`'s parent. */
function zigIdentityHost(node: SyntaxNode): SyntaxNode | null {
  let cur = node.parent;
  while (cur !== null && cur !== undefined) {
    if (isZigCallableNode(cur) || ZIG_CONTAINER_TYPES.has(cur.type) || cur.type === 'source_file') {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

/** A callable's qualified name as the structure phase spells it: its owner
 *  container's identity, a dot, its own name (`Reflect.string`, `Page.init`,
 *  `helper` in a namespace file). A `test` block is keyed by its LINE
 *  (`test@L<line>`, 1-based; a test is a top-level declaration, so the line
 *  identifies it), not by its string: the class extractor's
 *  `buildQualifiedName` normalizes a graph node's `qualifiedName`
 *  (whitespace stripped, `::` → `.`), so an identity carrying `"Function:
 *  requested termination …"` would key the node under one spelling and the
 *  scope def under another, and `State{}` in that test would resolve to
 *  nothing. No `:` either (`row:col` would do), so an id keeps a single
 *  `label:file:name` colon structure for anything that splits on it. */
export function zigCallableQualifiedName(fnNode: SyntaxNode, filePath?: string): string {
  const own =
    fnNode.type === 'test_declaration'
      ? `test@L${fnNode.startPosition.row + 1}`
      : (fnNode.childForFieldName('name')?.text ?? `fn@L${fnNode.startPosition.row + 1}`);
  const host = zigIdentityHost(fnNode);
  if (host === null) return own;
  const hostName = ZIG_CONTAINER_TYPES.has(host.type)
    ? zigContainerName(host, filePath)
    : host.type === 'source_file'
      ? zigContainerBindingName(host, filePath) // file-struct stem; nothing for a namespace file
      : zigCallableQualifiedName(host, filePath);
  return hostName === undefined ? own : `${hostName}.${own}`;
}

/** The `<host>` part of an anonymous container's identity. */
function zigAnonymousHostPrefix(host: SyntaxNode, filePath?: string): string | undefined {
  if (isZigCallableNode(host)) return zigCallableQualifiedName(host, filePath);
  if (ZIG_CONTAINER_TYPES.has(host.type)) return zigContainerName(host, filePath);
  // File level: the file stem — a Zig file is itself a struct, so this is
  // javac's `Outer$1` with the file as `Outer` (`Page$1`, `util$1`).
  return filePath === undefined ? undefined : zigFileStructName(filePath);
}

/** 1-based ordinal of an anonymous container among the anonymous containers
 *  sharing its identity host, in source order. Computed once per tree and
 *  memoized on the tree object (a node without `.tree` recomputes from its
 *  root); position-derived, so two parses of one source agree. */
const zigAnonymousOrdinalMemo = new WeakMap<object, Map<number, number>>();
function zigAnonymousContainerOrdinal(containerNode: SyntaxNode): number {
  const tree = (containerNode as { tree?: object }).tree;
  let table = tree === undefined ? undefined : zigAnonymousOrdinalMemo.get(tree);
  if (table === undefined) {
    let root: SyntaxNode = containerNode;
    while (root.parent !== null && root.parent !== undefined) root = root.parent;
    const built = new Map<number, number>();
    const perHost = new Map<number, number>();
    const visit = (node: SyntaxNode): void => {
      if (ZIG_CONTAINER_TYPES.has(node.type) && zigContainerBindingName(node) === undefined) {
        const host = zigIdentityHost(node);
        const key = host === null ? -1 : host.id;
        const next = (perHost.get(key) ?? 0) + 1;
        perHost.set(key, next);
        built.set(node.id, next);
      }
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child !== null) visit(child);
      }
    };
    visit(root);
    if (tree !== undefined) zigAnonymousOrdinalMemo.set(tree, built);
    table = built;
  }
  return table.get(containerNode.id) ?? 0;
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
 *  @This();` stays a Const and is not a type to rewrite to). The container
 *  side is the name the SCOPE BINDS: the binding name (`R` for a function-
 *  local `const R = struct {…}`, whose identity `string$R` is not a binding),
 *  or the synthetic identity of an anonymous container, which is bound under
 *  that very name (F8). */
function collectZigThisAliases(
  root: SyntaxNode,
  fileStructName: string | undefined,
  filePath: string,
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
          const containerName = zigContainerBindingName(owner) ?? zigContainerName(owner, filePath);
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
 *   convention `interpretZigTypeBinding` keys receiver typing on), and a
 *   method has TWO call spellings: the implicit `r.run(target)` and the
 *   explicit `Runner.run(&r, target)`. The shared harness joins actuals to
 *   formals by index, and formals are numbered once per function — so the
 *   receiver must be re-added on the CALL side, never dropped on the formal
 *   side (slicing `self` off the formals fixed the implicit spelling and lost
 *   the explicit one — PR #1432 review). `extractCallArguments` therefore
 *   prepends the receiver as actual 0 when the callee is a member call on a
 *   VALUE receiver (`r.run(target)`, `self.slot.release()`, `node.child()`),
 *   so both spellings yield `target@1` and join formal `cb@1`. A namespace
 *   or type receiver (`Runner.init(cb)`, `std.sort.pdq(…)`, `List(u8).init`,
 *   `@import("x.zig").f(cb)`) passes nothing implicitly and gets no prepend.
 *   Value-vs-type is F6's rule: the chain head is a fn-local name (param /
 *   local / payload) that is not TitleCase, or a MODULE-level value — a
 *   file- or container-level `var` / `const` whose declaration shape says
 *   "value" (`zigHostValueNames`: annotated, a struct literal, a non-type
 *   call, a literal), so `global_runner.run(target)` prepends `global_runner`
 *   exactly like `r.run(target)` does and `target` joins formal `cb@1`
 *   instead of `self@0` (PR #1432 review, 8.3).
 *
 * `builtin_function` (`@import`, `@sizeOf`, …) is deliberately not a call node:
 * builtins never take user callables as flow arguments.
 */
/** Per file: the callable-flow options close over the file's fn-local and
 *  host-value name caches (shared with F6's `zigCallReturnTypeOf`). */
function zigCallableCaptureOptions(
  fnLocalNames: Map<number, Set<string>>,
  hostValueNames: Map<number, Set<string>>,
) {
  return {
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
      // `parameters` is a fieldless child of `function_declaration`. The
      // leading `self` is kept: it is formal 0, matched by the receiver that
      // `extractCallArguments` prepends (implicit spelling) or the explicit
      // first actual (`Runner.run(&r, target)`).
      const list = fn.namedChildren.find((child) => child?.type === 'parameters');
      if (list === undefined || list === null) return undefined;
      return list.namedChildren.filter(
        (child): child is SyntaxNode => child !== null && child.type === 'parameter',
      );
    },
    extractCallArguments: (call: SyntaxNode) => {
      const callee = call.childForFieldName('function');
      const explicit = call.namedChildren.filter(
        (child): child is SyntaxNode =>
          child !== null && child.id !== callee?.id && child.type !== 'comment',
      );
      const receiver = zigImplicitReceiver(call, fnLocalNames, hostValueNames);
      return receiver === undefined ? explicit : [receiver, ...explicit];
    },
  } as const;
}

/** The value receiver `x.f(…)` passes implicitly as `self`, or undefined for
 *  a free call, a decl literal (`.init(…)`), or a namespace / type receiver
 *  (`Runner.init(…)`, `std.mem.eql(…)`, `List(u8).init(…)`, `@import(…).f(…)`).
 *  Same value-vs-type rule as `zigCallReturnTypeOf` (F6): the chain head is a
 *  name declared in the enclosing fn and is not TitleCase (a fn-local
 *  TitleCase name is a type alias, F7), or a module-level value
 *  (`zigIsHostValueName`). */
function zigImplicitReceiver(
  call: SyntaxNode,
  fnLocalNames: Map<number, Set<string>>,
  hostValueNames: Map<number, Set<string>>,
): SyntaxNode | undefined {
  const callee = call.childForFieldName('function');
  if (callee === null || callee.type !== 'field_expression') return undefined;
  const object = callee.childForFieldName('object');
  if (object === null) return undefined; // `.init(…)` decl literal
  const head = zigChainHead(object);
  if (head === null || isZigTitleCase(head.text)) return undefined;
  return zigIsValueName(call, head.text, fnLocalNames, hostValueNames) ? object : undefined;
}

/** Is `name`, read at `at`, a VALUE — a fn-local (param / local / payload) of
 *  the enclosing fn, or a module-level value declared by the file or by a
 *  container enclosing `at`? Zig forbids shadowing, so the first declaration
 *  found walking outwards is the only one. Namespaces (`std`, an `@import`
 *  handle, `const mem = std.mem`) and types are not values. */
function zigIsValueName(
  at: SyntaxNode,
  name: string,
  fnLocalNames: Map<number, Set<string>>,
  hostValueNames: Map<number, Set<string>>,
): boolean {
  const fn = zigEnclosingFunction(at);
  if (fn !== null && zigFunctionLocalNames(fn, fnLocalNames).has(name)) return true;
  let host = zigIdentityHost(at);
  while (host !== null) {
    if (!isZigCallableNode(host) && zigHostValueNames(host, hostValueNames).has(name)) return true;
    host = zigIdentityHost(host);
  }
  return false;
}

/** The names a HOST (the file root or a container node) declares DIRECTLY as
 *  values — module-level state such as `var global_runner = Runner{};`,
 *  `var pool: Pool = undefined;`, `const default_config = Config.load();`,
 *  `const max = 16;`. Decided from the declaration's shape, the only evidence
 *  available before finalization:
 *    - annotated (`var x: T = …`, `const x: T;`) or initialized with a struct
 *      literal, a literal, or a call that is not a generic type instantiation
 *      (`isZigTypeConstructorCall`) → value;
 *    - container / `@import` bindings, TitleCase names (types, F7), and
 *      values that merely ALIAS another name (`const mem = std.mem;`,
 *      `var cur = orig;`) → not a value here: an alias is whatever it aliases,
 *      and a namespace alias prepended as a receiver would shift every
 *      callback index the other way.
 *  Lazily computed once per host node. */
function zigHostValueNames(host: SyntaxNode, cache: Map<number, Set<string>>): Set<string> {
  const cached = cache.get(host.id);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  for (let i = 0; i < host.namedChildCount; i++) {
    const decl = host.namedChild(i);
    if (decl === null || decl.type !== 'variable_declaration' || !isZigKeywordDeclaration(decl)) {
      continue;
    }
    const named = decl.namedChildren.filter((c): c is SyntaxNode => c !== null);
    const name = named[0];
    if (name === undefined || name.type !== 'identifier' || isZigTitleCase(name.text)) continue;
    if (named.length < 2 || isZigContainerOrImportBinding(decl)) continue;
    const last = named[named.length - 1]!;
    if (last.id !== decl.childForFieldName('type')?.id) {
      const value = zigUnwrapValue(last);
      if (
        value.type === 'identifier' ||
        value.type === 'field_expression' ||
        value.type === 'builtin_function' ||
        (value.type === 'call_expression' && isZigTypeConstructorCall(value))
      ) {
        continue;
      }
    }
    names.add(name.text);
  }
  cache.set(host.id, names);
  return names;
}

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
  hostValueNames: Map<number, Set<string>> = new Map(),
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
    // A fn-local or module-level value name is a VALUE receiver — unless it
    // is TitleCase: `const R = generic.List(u8); var l = R.init();` binds a
    // type alias inside the fn (F7), and `R.init()` names the type `R`
    // exactly like `Counter.init()` does at module level. Zig's naming
    // convention (types TitleCase, values snake_case) is the same signal
    // `isZigTypeConstructorCall` relies on.
    if (
      !isZigTitleCase(head.text) &&
      zigIsValueName(value, head.text, localNamesCache, hostValueNames)
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
    // A binding-rule match whose `@import` is the declaration's TYPE
    // annotation binds nothing: leave the source unclaimed so the
    // `@import.inline` rule keeps the file edge.
    if (
      importSource !== undefined &&
      importStmt !== undefined &&
      isZigTypePositionImport(importStmt, importSource)
    ) {
      continue;
    }
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
    // Only a ONE-level member (`const Counter = counter.Counter;`) is the
    // named-import fact. A deeper chain (`const chosen = lib.B.work;`) names a
    // member OF a member: promoting it to a named import of `work` from
    // `lib.zig` discarded the written owner `B`, and `findExportedDef` then
    // answered with the first `work` in the file — `A.work` (PR #1432 review,
    // 8.4). Those stay Consts and are rewritten at their use sites instead
    // (`collectZigDeepAliases`).
    if (
      stmt !== undefined &&
      ns !== undefined &&
      importSources.has(ns.text) &&
      zigMemberChainOf(stmt)?.members.length === 1
    ) {
      aliasDeclIds.add(stmt.id);
    }
  }
  // Function-local `@import` bindings, keyed per enclosing callable (PR #1432
  // review, 8.9). Finalization flattens every import of a file onto its
  // Module scope, so two sibling fns each binding `const m = @import(…)` to a
  // different file became ONE `m → [a.zig, b.zig]` namespace bucket and both
  // `m.Thing{}` sites took the first target. The binding and every use of the
  // name inside that fn are rewritten to `m$<fn>` — a spelling no Zig
  // identifier can take — so each fn's handle is its own bucket and resolves
  // through its own lexical import (`rewriteZigFunctionLocalImportNames`).
  const fnLocalImports = new Map<
    number,
    { readonly fn: SyntaxNode; readonly names: Map<string, string> }
  >();
  for (const m of rawMatches) {
    const byName = new Map(m.captures.map((c) => [c.name, c.node] as const));
    const importName = byName.get('import.name');
    const importStmt = byName.get('import.statement');
    const importSource = byName.get('import.source');
    if (importName === undefined || importStmt === undefined || importSource === undefined) {
      continue;
    }
    if (!isZigKeywordDeclaration(importStmt) || isZigTypePositionImport(importStmt, importSource)) {
      continue;
    }
    const fn = zigEnclosingFunction(importStmt);
    if (fn === null) continue;
    let entry = fnLocalImports.get(fn.id);
    if (entry === undefined) {
      entry = { fn, names: new Map() };
      fnLocalImports.set(fn.id, entry);
    }
    if (!entry.names.has(importName.text)) {
      entry.names.set(importName.text, zigFunctionLocalImportKey(importName.text, fn, _filePath));
    }
  }
  // Deep member aliases — `const chosen = @import("lib.zig").B.work;`,
  // `const chosen2 = lib.B.work;`, `const Inner = nested.Outer.Inner;` (PR
  // #1432 review, 8.4): the owner path is kept and the alias's use sites are
  // rewritten to qualified references (`chosen()` → `lib.B` . `work`), which
  // the namespace chain walk resolves segment by segment.
  const deepAliases = collectZigDeepAliases(tree.rootNode, importSources, fnLocalImports);

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
  const thisAliases = collectZigThisAliases(root, fileStructName, _filePath);
  // F6: fn-local names per function node, for `zigCallReturnTypeOf`; module-
  // level value names per host node (file / container), for the value-vs-
  // namespace receiver rule (`zigHostValueNames`).
  const fnLocalNames = new Map<number, Set<string>>();
  const hostValueNames = new Map<number, Set<string>>();

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
      if (isZigInlineImportReceiver(inlineImport) || deepAliases.inlineRoots.has(inlineImport.id)) {
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

    // `const chosen = @import("lib.zig").B.work;` — the two-member import
    // rule matched a DEEP chain. Binding `chosen` as a named import of the
    // innermost member `work` lost the owner `B` (8.4); bind the module under
    // the builtin's own text instead — the same namespace binding a member-
    // call receiver gets — and let the rewritten use sites walk `B.work`.
    const deepImportStmt = nodeMap['@import.statement'];
    if (
      deepImportStmt !== undefined &&
      nodeMap['@import.imported'] !== undefined &&
      deepAliases.declIds.has(deepImportStmt.id)
    ) {
      const importRoot = zigImportRootOf(
        deepImportStmt.namedChildren.filter((c): c is SyntaxNode => c !== null).pop() ?? null,
      );
      const source = nodeMap['@import.source'];
      if (importRoot !== null && source !== undefined) {
        const key = `receiver:${source.text}`;
        if (!importedSourceTexts.has(key)) {
          importedSourceTexts.add(key);
          out.push({
            '@import.statement': nodeToCapture('@import.statement', importRoot),
            '@import.name': nodeToCapture('@import.name', importRoot),
            '@import.source': grouped['@import.source']!,
          });
        }
      }
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
      // A deep alias off an inline import (`const Inner =
      // @import("n.zig").Outer.Inner;`) keeps its type binding: the written
      // path is the type (8.4).
      if (
        aliasDeclIds.has(aliasAnchor.id) ||
        (isZigContainerOrImportBinding(aliasAnchor) && !deepAliases.declIds.has(aliasAnchor.id))
      ) {
        continue;
      }
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

    // `var x: @import("foo.zig").T = undefined;` — the binding rules match
    // the type-position `@import` too; that group binds nothing (the
    // variable group for `x` and the inline file edge cover it).
    if (
      nodeMap['@import.statement'] !== undefined &&
      nodeMap['@import.source'] !== undefined &&
      isZigTypePositionImport(nodeMap['@import.statement'], nodeMap['@import.source'])
    ) {
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
      const inferred = zigCallReturnTypeOf(valueNode, fnLocalNames, hostValueNames);
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

    // The receiver is the FIRST parameter when it is named `self` or typed as
    // the enclosing container — `zigReceiverParameter` is the single rule,
    // shared with the method extractor so the two phases agree. Tag it so
    // `interpretZigTypeBinding` sources the binding as `self`; a later `self`
    // parameter (legal Zig) is an ordinary parameter, not a receiver. The
    // synthetic captures sit on the name node (smaller than the `parameter`
    // anchor), so they never displace the anchor.
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
      const fnNode = paramAnchor.parent?.parent;
      if (
        fnNode !== null &&
        fnNode !== undefined &&
        zigReceiverParameter(fnNode, _filePath)?.id === paramAnchor.id
      ) {
        grouped['@type-binding.receiver'] = syntheticCapture(
          '@type-binding.receiver',
          paramName,
          'true',
        );
      }
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
      // F8 — FUNCTION-LOCAL named container (`const R = struct {…}` inside a
      // fn body) and (8.5) CONTAINER-HOSTED named container (`pub const Item
      // = struct {…}` inside `A`): the def's qualified name is its identity
      // (`string$R`, `A.Item` — matching the graph node the structure phase
      // mints via `zigContainerName`), while the scope still binds the
      // spelling code uses (`R.get()`, `self: *R`, `Item{}`) — the Java
      // local / nested class split (`@declaration.binding-name`,
      // java/captures.ts).
      if (containerAnchor !== undefined && nameNode !== undefined) {
        const identity = zigContainerName(containerAnchor, _filePath);
        if (identity !== undefined && identity !== nameNode.text) {
          grouped['@declaration.binding-name'] = grouped['@declaration.name']!;
          grouped['@declaration.name'] = syntheticCapture('@declaration.name', nameNode, identity);
        }
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
    } else if (
      fieldAnchor !== undefined &&
      fieldType === undefined &&
      fieldName !== undefined &&
      fieldName.text !== '_' &&
      fieldAnchor.parent?.type === 'enum_declaration'
    ) {
      // An enum VARIANT has no written type, but it has one: the enum itself.
      // `Operation.create_accounts.event_max()` — a method called on a variant
      // reached through the type — needs `Operation.create_accounts` typed as
      // `Operation` for the compound resolver to walk the field like
      // `self.session.name()`. tigerbeetle writes this shape 147 times
      // (`Operation.<variant>.event_max(…)`, `TestOperation.create.event_size(`).
      const enumName =
        zigContainerBindingName(fieldAnchor.parent, _filePath) ??
        zigContainerName(fieldAnchor.parent, _filePath);
      if (enumName !== undefined) {
        out.push({
          '@type-binding.field': nodeToCapture('@type-binding.field', fieldName),
          '@type-binding.name': nodeToCapture('@type-binding.name', fieldName),
          '@type-binding.type': syntheticCapture('@type-binding.type', fieldName, enumName),
        });
      }
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

  // F8 — ANONYMOUS containers (`std.sort.pdq(…, struct { fn lessThan … }
  // .lessThan)`, `const cmp = struct { fn lt … }.lt;`, `clamp: ?struct { min:
  // u32 }`): no query rule binds them, so their Class scope owned no def and
  // their fns were ownerless, colliding Methods. Synthesize the def the
  // structure phase mints (`zigContainerName` → `build$1`), anchored on the
  // container node so it shares the `@scope.class` range: the def joins that
  // scope's ownedDefs (`populateClassOwnedMembers` then qualifies its members
  // `build$1.lessThan` and stamps their ownerId) and the name auto-hoists to
  // the enclosing scope, where a `const Self = @This();` rewrite can find it.
  out.push(...synthesizeZigAnonymousContainerDeclarations(root, _filePath));

  // Result-location sites — `const a: Counter = .init(1);`, `return .init(3);`,
  // `const b: Counter = .{ .n = 2 };` (8.6): the call / construction the query
  // cannot see because the type is written on the LEFT.
  out.push(...synthesizeZigResultLocationReferences(root, thisAliases, fileStructName));

  out.push(
    ...synthesizeCallableFlowCaptures(
      tree.rootNode,
      zigCallableCaptureOptions(fnLocalNames, hostValueNames),
    ),
  );

  // Use-site rewrites, in this order: a deep alias's receiver may itself name
  // a fn-local import (`const m = @import(…); const w = m.B.work;`), and the
  // second pass rewrites that name inside the receiver text it just minted.
  rewriteZigDeepAliasReferences(out, deepAliases.aliases);
  rewriteZigFunctionLocalImportNames(out, fnLocalImports);

  return stampZigStaticGating(out, tree.rootNode);
}

// ─── Use-site rewrites (8.4 / 8.9) and result-location sites (8.6) ────────────

/** The unique spelling a function-local import binding gets: `m$<callable>`
 *  — `m$f_sib_a`, `m$Reflect$string`, `m$test$L12`. `$` cannot appear in a
 *  Zig identifier, so the key collides with nothing the source declares;
 *  every non-word character of the callable's qualified name becomes `$` so
 *  the key stays a single receiver segment (a `.` would split it). */
function zigFunctionLocalImportKey(name: string, fn: SyntaxNode, filePath: string): string {
  return `${name}$${zigCallableQualifiedName(fn, filePath).replace(/[^\w]/g, '$')}`;
}

type ZigRange = Capture['range'];

/** The capture-side range of `node` (1-based lines, as `nodeToCapture`). */
function zigNodeRange(node: SyntaxNode): ZigRange {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

function zigRangeWithin(inner: ZigRange, outer: ZigRange): boolean {
  const startsAfter =
    inner.startLine > outer.startLine ||
    (inner.startLine === outer.startLine && inner.startCol >= outer.startCol);
  const endsBefore =
    inner.endLine < outer.endLine ||
    (inner.endLine === outer.endLine && inner.endCol <= outer.endCol);
  return startsAfter && endsBefore;
}

/** Replace every bare identifier token `name` in `text` — outside string
 *  literals, and not the member of a `.name` access or the tail of a
 *  `@builtin` — with `replacement`. Zig forbids shadowing, so inside the
 *  region a rewrite applies to, every such token is the same binding. */
function zigReplaceIdentifier(text: string, name: string, replacement: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /\w/.test(text[j]!)) j++;
      const word = text.slice(i, j);
      const prev = i > 0 ? text[i - 1] : '';
      out += word === name && prev !== '.' && prev !== '@' ? replacement : word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Every capture whose text can spell a receiver, a type, a bound name or a
 *  callable-flow cell — the ones a fn-local import name can appear in. */
const ZIG_NAME_BEARING_TAGS: readonly string[] = [
  '@import.name',
  '@reference.receiver',
  '@reference.name',
  '@type-binding.type',
  '@callable-flow.target-name',
  '@callable-flow.target-qualified-name',
  '@callable-flow.receiver',
  '@callable-flow.source',
  '@callable-flow.destination',
  '@callable-flow.callee',
  '@callable-flow.direct-callee-name',
];

/** 8.9 — rewrite a fn-local import's binding and its uses to its unique key
 *  (`zigFunctionLocalImportKey`), within that fn's range only. */
function rewriteZigFunctionLocalImportNames(
  out: CaptureMatch[],
  fnLocalImports: ReadonlyMap<
    number,
    { readonly fn: SyntaxNode; readonly names: Map<string, string> }
  >,
): void {
  if (fnLocalImports.size === 0) return;
  for (const { fn, names } of fnLocalImports.values()) {
    const fnRange = zigNodeRange(fn);
    for (let i = 0; i < out.length; i++) {
      const group = out[i]!;
      let next: Record<string, Capture> | undefined;
      for (const tag of ZIG_NAME_BEARING_TAGS) {
        const cap = group[tag];
        if (cap === undefined || !zigRangeWithin(cap.range, fnRange)) continue;
        let text = cap.text;
        for (const [name, key] of names) text = zigReplaceIdentifier(text, name, key);
        if (text === cap.text) continue;
        next ??= { ...group };
        next[tag] = { ...cap, text };
      }
      if (next !== undefined) out[i] = next;
    }
  }
}

/** A `const X = <root>.<m1>.<m2>…;` alias (8.4): `X` stands for member `<mN>`
 *  of the receiver `<root>.<m1>…<mN-1>`, inside `range` (null: the whole
 *  file). */
interface ZigDeepAlias {
  readonly name: string;
  readonly receiver: string;
  readonly member: string;
  readonly range: ZigRange | null;
}

/** The member chain a declaration's value spells — `lib.B.work` →
 *  `{ root: lib, members: [B, work] }`; undefined for anything but a
 *  `field_expression` chain rooted in an identifier or an `@import(…)`. */
function zigMemberChainOf(
  decl: SyntaxNode,
): { readonly root: SyntaxNode; readonly members: readonly SyntaxNode[] } | undefined {
  const named = decl.namedChildren.filter((c): c is SyntaxNode => c !== null);
  if (named.length !== 2 || named[0]!.type !== 'identifier') return undefined;
  let cur: SyntaxNode | null = named[1]!;
  const members: SyntaxNode[] = [];
  while (cur !== null && cur.type === 'field_expression') {
    const member = cur.childForFieldName('member');
    const object = cur.childForFieldName('object');
    if (member === null || object === null) return undefined; // `.init` literal
    members.unshift(member);
    cur = object;
  }
  if (cur === null || members.length === 0) return undefined;
  if (cur.type !== 'identifier' && !isZigImportBuiltin(cur)) return undefined;
  return { root: cur, members };
}

/** 8.4 — every deep member alias in the tree whose root is a module handle:
 *  a file-level `@import` binding of this file, a fn-local one (its key is
 *  applied by the later rewrite), or an inline `@import(…)`. Returns the
 *  aliases, the declaring nodes (so their import / alias groups are handled
 *  as deep aliases) and the inline-import roots (bound as namespaces). */
function collectZigDeepAliases(
  root: SyntaxNode,
  importSources: ReadonlyMap<string, SyntaxNode>,
  fnLocalImports: ReadonlyMap<
    number,
    { readonly fn: SyntaxNode; readonly names: Map<string, string> }
  >,
): {
  readonly aliases: readonly ZigDeepAlias[];
  readonly declIds: ReadonlySet<number>;
  readonly inlineRoots: ReadonlySet<number>;
} {
  const aliases: ZigDeepAlias[] = [];
  const declIds = new Set<number>();
  const inlineRoots = new Set<number>();
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'variable_declaration' && isZigKeywordDeclaration(node)) {
      const chain = zigMemberChainOf(node);
      if (chain !== undefined && chain.members.length >= 2) {
        const fn = zigEnclosingFunction(node);
        const isHandle =
          isZigImportBuiltin(chain.root) ||
          importSources.has(chain.root.text) ||
          (fn !== null && fnLocalImports.get(fn.id)?.names.has(chain.root.text) === true);
        if (isHandle) {
          const host = zigIdentityHost(node);
          const receiver = [chain.root.text, ...chain.members.slice(0, -1).map((m) => m.text)].join(
            '.',
          );
          aliases.push({
            name: node.namedChild(0)!.text,
            receiver,
            member: chain.members[chain.members.length - 1]!.text,
            range: host === null || host.type === 'source_file' ? null : zigNodeRange(host),
          });
          declIds.add(node.id);
          if (isZigImportBuiltin(chain.root)) inlineRoots.add(chain.root.id);
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child !== null) visit(child);
    }
  };
  visit(root);
  return { aliases, declIds, inlineRoots };
}

/** 8.4 — turn a free call / bare construction of a deep alias (`chosen()`,
 *  `Inner{}`) into the qualified reference it stands for (receiver `lib.B`,
 *  member `work`), so it resolves through the alias's written owner path and
 *  never through a same-named member elsewhere in the module. */
function rewriteZigDeepAliasReferences(
  out: CaptureMatch[],
  aliases: readonly ZigDeepAlias[],
): void {
  if (aliases.length === 0) return;
  for (let i = 0; i < out.length; i++) {
    const group = out[i]!;
    const free = group['@reference.call.free'];
    const ctor = group['@reference.call.constructor'];
    if ((free === undefined && ctor === undefined) || group['@reference.receiver'] !== undefined) {
      continue;
    }
    const nameCap = group['@reference.name'];
    if (nameCap === undefined) continue;
    const alias = aliases.find(
      (a) =>
        a.name === nameCap.text && (a.range === null || zigRangeWithin(nameCap.range, a.range)),
    );
    if (alias === undefined) continue;
    const next: Record<string, Capture> = { ...group };
    if (free !== undefined) {
      delete next['@reference.call.free'];
      next['@reference.call.member'] = { ...free, name: '@reference.call.member' };
    }
    next['@reference.receiver'] = {
      name: '@reference.receiver',
      range: nameCap.range,
      text: alias.receiver,
    };
    next['@reference.name'] = { ...nameCap, text: alias.member };
    out[i] = next;
  }
}

/** 8.6 — reference sites for RESULT-LOCATION expressions: a decl literal
 *  `.init(…)` or an anonymous literal `.{…}` whose type comes from where the
 *  value lands — a declared variable (`const a: Counter = .init(1);`), a
 *  function's return (`fn make() Counter { return .init(3); }`), a container
 *  field's default (`n: Counter = .init(0),`). The query cannot see these:
 *  its member-call rule needs an object and its constructor rule a type
 *  identifier, and the annotation only typed the VARIABLE — the `init` call
 *  and the `Counter{…}` construction event were absent from the graph. Each
 *  site is emitted with the expected type as its receiver (`Counter`,
 *  `stdx.Thing`, `@This()` and `Self` rewritten to the container), so it
 *  resolves exactly as `Counter.init(1)` / `Counter{…}` would — through the
 *  class binding or the namespace chain, never by simple name workspace-wide.
 *  Arguments (`f(.init(1))`) are out: the expected type is the callee's
 *  parameter, which needs the resolved callee. */
function synthesizeZigResultLocationReferences(
  root: SyntaxNode,
  thisAliases: ReadonlyMap<number, { readonly alias: string; readonly container: string }>,
  fileStructName: string | undefined,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const emit = (expected: SyntaxNode, value: SyntaxNode): void => {
    const inner = zigUnwrapValue(value);
    let isDeclLiteral = false;
    let member: SyntaxNode | null = null;
    if (inner.type === 'call_expression') {
      const callee = inner.childForFieldName('function');
      if (callee?.type !== 'field_expression' || callee.childForFieldName('object') !== null)
        return;
      member = callee.childForFieldName('member');
      if (member === null) return;
      isDeclLiteral = true;
    } else if (inner.type !== 'anonymous_struct_initializer') {
      return;
    }
    let text = expected.text;
    if (text.includes('@This()')) {
      const target = zigThisTargetFor(expected, fileStructName);
      if (target === undefined) return;
      text = text.replace('@This()', target);
    } else {
      text = rewriteZigThisAlias(expected, thisAliases) ?? text;
    }
    const nominal = normalizeZigTypeName(text);
    // A builtin / primitive (`u32`, `void`, `anyerror`) constructs nothing.
    if (!/^[A-Z@]/.test(nominal) && !nominal.includes('.')) return;
    if (isDeclLiteral) {
      out.push({
        '@reference.call.member': nodeToCapture('@reference.call.member', inner),
        '@reference.receiver': syntheticCapture('@reference.receiver', inner, nominal),
        '@reference.name': nodeToCapture('@reference.name', member!),
      });
      return;
    }
    const dot = zigLastTopLevelDot(nominal);
    out.push(
      dot === -1
        ? {
            '@reference.call.constructor': nodeToCapture('@reference.call.constructor', inner),
            '@reference.name': syntheticCapture('@reference.name', inner, nominal),
          }
        : {
            '@reference.call.constructor': nodeToCapture('@reference.call.constructor', inner),
            '@reference.receiver': syntheticCapture(
              '@reference.receiver',
              inner,
              nominal.slice(0, dot),
            ),
            '@reference.name': syntheticCapture('@reference.name', inner, nominal.slice(dot + 1)),
          },
    );
  };
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'variable_declaration' && isZigKeywordDeclaration(node)) {
      const typeNode = node.childForFieldName('type');
      const named = node.namedChildren.filter((c): c is SyntaxNode => c !== null);
      const last = named[named.length - 1];
      if (typeNode !== null && last !== undefined && last.id !== typeNode.id) emit(typeNode, last);
    } else if (node.type === 'return_expression') {
      const fn = zigEnclosingFunction(node);
      const ret = fn?.type === 'function_declaration' ? fn.childForFieldName('type') : null;
      const value = node.namedChild(0);
      if (ret !== null && ret !== undefined && value !== null && zigReturnTypeIsNominal(ret)) {
        emit(ret, value);
      }
    } else if (node.type === 'container_field') {
      const typeNode = node.childForFieldName('type');
      const nameNode = node.childForFieldName('name');
      const named = node.namedChildren.filter((c): c is SyntaxNode => c !== null);
      const last = named[named.length - 1];
      if (
        typeNode !== null &&
        last !== undefined &&
        last.id !== typeNode.id &&
        last.id !== nameNode?.id
      ) {
        emit(typeNode, last);
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

/** Index of the last `.` at nesting depth 0 and outside string literals —
 *  the one that separates `@import("a.zig").Thing` or `stdx.List(u8).Node`
 *  into receiver and member. -1 when there is none. */
function zigLastTopLevelDot(text: string): number {
  let depth = 0;
  let inString = false;
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '.' && depth === 0) last = i;
  }
  return last;
}

/** One `@declaration.<kind>` group per anonymous container in the tree —
 *  see the call site in `emitZigScopeCaptures` (F8). Named after
 *  `synthesizeJavaAnonymousClassDeclarations`, which does the same for
 *  `new Runnable() {…}` bodies. */
function synthesizeZigAnonymousContainerDeclarations(
  root: SyntaxNode,
  filePath: string,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const visit = (node: SyntaxNode): void => {
    if (ZIG_CONTAINER_TYPES.has(node.type) && zigContainerBindingName(node) === undefined) {
      const identity = zigContainerName(node, filePath);
      const label = zigContainerLabel(node);
      if (identity !== undefined && label !== undefined) {
        const tag = `@declaration.${label.toLowerCase()}`;
        out.push({
          [tag]: nodeToCapture(tag, node),
          '@declaration.name': syntheticCapture('@declaration.name', node, identity),
          '@declaration.is-synthetic': syntheticCapture('@declaration.is-synthetic', node, 'true'),
        });
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
