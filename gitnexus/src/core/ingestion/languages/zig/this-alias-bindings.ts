/**
 * Bind a Zig `const X = @This();` alias to the container it names (#3219
 * review round 8).
 *
 * `@This()` IS the enclosing container, and Zig code says so constantly: the
 * single most common spelling is `const Self = @This();`, followed by
 * `Alias.member` wherever the explicit form is wanted (`Self.width(self)`, a
 * registration `bridge.accessor(Self.width, …)`, a nested type `Self.Node`).
 * A compiler resolves `Self` and the container's own name to the same type.
 * This index did not, for one specific reason:
 *
 *   - A container-level alias (`const Self = @This();` inside `struct {…}`)
 *     mints a `Variable` beside the `Struct`, so `Self` binds to a VALUE. Every
 *     class-like lookup filters on `isClassLike` and walks straight past it.
 *   - A FILE-level alias in a file-as-struct mints nothing at all —
 *     `isZigFileThisAlias` suppresses the Const deliberately, so it cannot
 *     shadow the type for `x: *Page`. The name is then bound to nothing, while
 *     the container itself is bound under the FILE STEM.
 *
 * So `Self.width` resolved only when the alias happened to be spelled like its
 * container. Measured on the three Zig corpora on hand: 73 of ghostty's 185
 * `@This()` files, 93 of tigerbeetle's 94 and 8 of mach's 42 spell it
 * differently, carrying 302 `Alias.member` references between them, 96 of those
 * calls. Those were not wrong edges — they were no edges, and a caller list
 * missing them is exactly the false confidence #3399 is about.
 *
 * WHAT THIS ADDS, precisely: one binding of the alias NAME to the container's
 * own definition, appended to `indexes.bindingAugmentations` (the sanctioned
 * post-finalize channel, invariant I8 — `indexes.bindings` is frozen). The
 * augmentation channel is consulted by `lookupBindingsAt` only AFTER a scope's
 * own `Scope.bindings`, so this can never outrank a real local declaration: the
 * `Variable` the container-level alias already mints still answers first for
 * anything that wants a value, and the container answers for anything that
 * wants a type. Nothing is replaced and nothing is removed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Only aliases declared DIRECTLY in a
 * container body or at file level are bound, which is the same set
 * `collectZigThisAliases` recognizes for the type-rewrite path. A function-local
 * `const Self = @This();` also names the enclosing container, but it belongs in
 * that function's scope, not the container's, and binding it here would make it
 * visible to sibling functions that never declared it.
 */

import type { ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { BindingRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { isZigKeywordDeclaration, ZIG_CONTAINER_TYPES } from './captures.js';

/** `const X = @This();` — the declaration shape, wherever it sits. */
function thisAliasName(node: SyntaxNode): string | undefined {
  if (node.type !== 'variable_declaration' || !isZigKeywordDeclaration(node)) return undefined;
  const named = node.namedChildren.filter((c): c is SyntaxNode => c !== null);
  if (named.length !== 2 || named[0]!.type !== 'identifier') return undefined;
  const value = named[1]!;
  if (value.type !== 'builtin_function' || value.namedChild(0)?.text !== '@This') return undefined;
  return named[0]!.text;
}

/** The class-like definition a Class scope is the body of. */
function containerDefOf(scope: Scope): SymbolDefinition | undefined {
  return scope.ownedDefs.find((d) => isClassLike(d.type));
}

/**
 * The Class scope of the FILE-AS-STRUCT, if this file is one.
 *
 * Identified by range rather than by name: it is the only Class scope that both
 * hangs directly off the module scope AND spans the same lines as it. A
 * namespace-only file with a top-level `pub const Counter = struct {…}` also
 * produces a Class scope under the module scope, and it also carries the file
 * stem when the file is `Counter.zig` — matching on the name would bind that
 * file's `@This()` alias to `Counter`, which is not what `@This()` means there.
 */
function fileStructScope(scopes: readonly Scope[], moduleScope: Scope): Scope | undefined {
  return scopes.find(
    (s) =>
      s.kind === 'Class' &&
      s.parent === moduleScope.id &&
      s.range.startLine === moduleScope.range.startLine &&
      s.range.endLine === moduleScope.range.endLine,
  );
}

/**
 * Innermost Class scope containing `node`.
 *
 * Compared on (line, column) rather than line alone, because a Zig container
 * can nest inside another on ONE line — `const A = struct { const S = @This();
 * const B = struct { const T = @This(); }; };` gives both scopes the same start
 * line, and picking between them by line would be a coin toss that binds an
 * alias to the wrong container. A wrong edge is the one outcome this whole
 * change set treats as worse than no edge.
 */
function enclosingClassScope(scopes: readonly Scope[], node: SyntaxNode): Scope | undefined {
  const line = node.startPosition.row + 1;
  const column = node.startPosition.column;
  const startsAtOrBefore = (l: number, c: number): boolean =>
    l < line || (l === line && c <= column);
  const endsAtOrAfter = (l: number, c: number): boolean => l > line || (l === line && c >= column);
  let best: Scope | undefined;
  for (const s of scopes) {
    if (s.kind !== 'Class') continue;
    if (!startsAtOrBefore(s.range.startLine, s.range.startCol)) continue;
    if (!endsAtOrAfter(s.range.endLine, s.range.endCol)) continue;
    if (
      best === undefined ||
      s.range.startLine > best.range.startLine ||
      (s.range.startLine === best.range.startLine && s.range.startCol > best.range.startCol)
    ) {
      best = s;
    }
  }
  return best;
}

/**
 * Append `alias -> def` at `scopeId`, skipping the append when THIS def is
 * already bound there. Idempotence, not precedence: a duplicate would be
 * harmless for lookup (`lookupBindingsAt` dedupes by `def.nodeId`) but would
 * make the channel's contents depend on how many times the hook ran. Other
 * bindings under the same name are left alone — the channel is append-only per
 * I8, and the whole point of the augmentation tier is that a scope's own
 * `Scope.bindings` are consulted first and still win.
 */
function appendBinding(
  indexes: ScopeResolutionIndexes,
  scopeId: ScopeId,
  alias: string,
  def: SymbolDefinition,
): void {
  const channel = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;
  let byName = channel.get(scopeId);
  if (byName === undefined) {
    byName = new Map<string, BindingRef[]>();
    channel.set(scopeId, byName);
  }
  const bucket = byName.get(alias);
  if (bucket === undefined) {
    byName.set(alias, [{ def, origin: 'local' }]);
    return;
  }
  if (bucket.some((ref) => ref.def.nodeId === def.nodeId)) return;
  bucket.push({ def, origin: 'local' });
}

/**
 * Bind every `@This()` alias declared in `parsed` at container or file level.
 *
 * Called per file from `populateZigRangeBindings`, which already holds the
 * parsed tree — a second pass over `parsedFiles` would re-parse every file when
 * the tree cache is cold. That is the only thing the two share. Ordering
 * against the payload bindings that follow does not matter, twice over: the
 * payload walk types its subjects through `findReceiverTypeBinding`, which
 * never reads the channel written here, and a `@This()` alias is a
 * container-private name no other file can import, so nothing outside this file
 * reads it either.
 */
export function bindZigThisAliases(
  parsed: ParsedFile,
  root: SyntaxNode,
  indexes: ScopeResolutionIndexes,
): void {
  const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
  if (moduleScope === undefined) return;
  const fileStruct = fileStructScope(parsed.scopes, moduleScope);

  const visit = (node: SyntaxNode): void => {
    const alias = thisAliasName(node);
    if (alias !== undefined) {
      const parent = node.parent;
      if (parent?.type === 'source_file') {
        // The file-as-struct's own name. Bound at the MODULE scope, which is
        // where the container is already bound under the file stem, so the
        // alias and the stem are visible to exactly the same sites.
        const def = fileStruct === undefined ? undefined : containerDefOf(fileStruct);
        if (def !== undefined) appendBinding(indexes, moduleScope.id, alias, def);
      } else if (parent !== null && ZIG_CONTAINER_TYPES.has(parent.type)) {
        const scope = enclosingClassScope(parsed.scopes, node);
        const def = scope === undefined ? undefined : containerDefOf(scope);
        if (scope !== undefined && def !== undefined) appendBinding(indexes, scope.id, alias, def);
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child !== null) visit(child);
    }
  };
  visit(root);
}
