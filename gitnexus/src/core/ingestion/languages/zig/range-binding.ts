/**
 * Zig payload captures (F6): `for (items) |it|`, `if (opt) |v|`,
 * `while (it.next()) |x|`. The captured name has no annotation anywhere — its
 * type is the SUBJECT's type minus one layer (slice/array element, optional
 * payload) — so the tree-sitter query cannot bind it; this post-finalize hook
 * reads the subject's binding from the finished scope model and injects the
 * payload's. Rust/Go do the same (`rust/range-binding.ts`,
 * `go/range-binding.ts`).
 *
 * Deliberately narrow and honest: a payload binds only when the subject's
 * WRITTEN type visibly has the layer the construct removes — `[]T` / `[N]T` /
 * `[*]T` / `*[N]T` for `for`, `?T` (after any `E!`) for `if` / `while`. A
 * subject typed `std.ArrayList(T)`, `anytype`, or anything unresolved binds
 * nothing rather than guessing. `catch |err|` (an error, never a container
 * receiver) and `switch` prongs are skipped. The same one-layer projection
 * types `const t = items[i];` / `opt.?` / `ptr.*` (`bindProjectedLocal`).
 *
 * Runs after `propagateImportedReturnTypes`, so return bindings hoisted from
 * other files are visible when a subject is a call.
 */

import type { ParsedFile, Scope, ScopeId, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { getZigParser } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe, ParseTimeoutError } from '../../../tree-sitter/safe-parse.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { logger } from '../../../logger.js';
import {
  findClassBindingInScope,
  findReceiverTypeBinding,
  isClassLike,
} from '../../scope-resolution/scope/walkers.js';
import { isZigKeywordDeclaration, zigUnwrapValue } from './captures.js';
import { normalizeZigTypeName } from './interpret.js';

type ZigTree = ReturnType<ReturnType<typeof getZigParser>['parse']>;

const PAYLOAD_HOSTS: ReadonlySet<string> = new Set([
  'for_statement',
  'for_expression',
  'if_statement',
  'if_expression',
  'while_statement',
  'while_expression',
]);

export function populateZigRangeBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly treeCache?: { get(filePath: string): unknown };
  },
): void {
  const parser = getZigParser();

  // Class def nodeId → its Class scope (whose typeBindings hold the members'
  // field types and the methods' return types). Same derivation as
  // `buildWorkspaceResolutionIndex`, which this hook does not receive.
  const classScopeByDefId = new Map<string, Scope>();
  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      const cd = scope.ownedDefs.find((d) => isClassLike(d.type));
      if (cd !== undefined) classScopeByDefId.set(cd.nodeId, scope);
    }
  }

  for (const parsed of parsedFiles) {
    const sourceText = ctx.fileContents.get(parsed.filePath);
    if (sourceText === undefined) continue;
    let tree = ctx.treeCache?.get(parsed.filePath) as ZigTree | undefined;
    if (tree === undefined) {
      try {
        tree = parseSourceSafe(parser, sourceText, undefined, {
          bufferSize: getTreeSitterBufferSize(sourceText),
        });
      } catch (err) {
        if (err instanceof ParseTimeoutError) {
          logger.warn(
            { file: parsed.filePath },
            'zig range-binding: parse timed out, skipping file',
          );
          continue;
        }
        throw err;
      }
    }
    const scopes = parsed.scopes;
    if (scopes.length === 0) continue;
    const resolver = new ZigSubjectTypeResolver(scopes, indexes, classScopeByDefId);

    // Pre-order: an outer payload is bound before an inner construct reads it
    // (`for (pages) |p| { if (p.frame) |f| … }`).
    const visit = (node: SyntaxNode): void => {
      if (PAYLOAD_HOSTS.has(node.type)) bindPayloads(node, resolver);
      else if (node.type === 'variable_declaration') bindProjectedLocal(node, resolver);
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c !== null) visit(c);
      }
    };
    visit(tree.rootNode);
  }
}

/** Bind the payload identifiers of one `for` / `if` / `while` node. */
function bindPayloads(node: SyntaxNode, resolver: ZigSubjectTypeResolver): void {
  const named = node.namedChildren.filter(
    (c): c is SyntaxNode => c !== null && c.type !== 'comment',
  );
  // The payload right after the subject(s); a trailing `else |err|` payload
  // belongs to the else_clause and is not a child here.
  const payload = named.find((c) => c.type === 'payload');
  if (payload === undefined) return;
  const isFor = node.type === 'for_statement' || node.type === 'for_expression';
  // A `for` lists its subjects BEFORE the payload; the body follows it.
  const subjects: SyntaxNode[] = isFor
    ? named.slice(0, named.indexOf(payload)).filter((c) => c.type !== 'block_label')
    : [node.childForFieldName('condition')].filter((c): c is SyntaxNode => c !== null);
  if (subjects.length === 0) return;
  // For a `for` the payload names pair positionally with the subjects
  // (`for (items, 0..) |it, i|`); `if` / `while` capture one value.
  const captured = payload.namedChildren.filter(
    (c): c is SyntaxNode => c !== null && c.type === 'identifier',
  );
  const host = payloadHostScope(node, resolver);
  if (host === undefined) return;
  for (let i = 0; i < captured.length && i < subjects.length; i++) {
    const name = captured[i]!.text;
    if (name === '_') continue;
    const subject = subjects[i]!;
    if (subject.type === 'range_expression') continue; // `0..` — an index
    const spelling = resolver.spellingOf(subject);
    if (spelling === undefined) continue;
    const element = isFor ? zigElementSpelling(spelling) : zigOptionalPayloadSpelling(spelling);
    if (element === undefined) continue;
    const rawName = normalizeZigTypeName(element);
    if (rawName.length === 0 || rawName.startsWith('@')) continue;
    const existing = host.typeBindings.get(name);
    // Zig forbids shadowing, so an existing binding of this name in the host
    // can only be a sibling construct's payload (bare-expression bodies share
    // the enclosing scope). Two different types for one name: decline both
    // rather than let the last one type the first one's body.
    if (existing !== undefined) {
      if (existing.rawName !== rawName) {
        (host.typeBindings as Map<string, TypeRef>).delete(name);
      }
      continue;
    }
    const ref: TypeRef =
      element === rawName
        ? { rawName, declaredAtScope: host.id, source: 'annotation' }
        : { rawName, declaredSpelling: element, declaredAtScope: host.id, source: 'annotation' };
    (host.typeBindings as Map<string, TypeRef>).set(name, ref);
  }
}

/** `const t = items[i];` / `const t = opt.?;` / `const t = ptr.*;` — a local
 *  bound to ONE LAYER under a typed subject: the element of a slice/array
 *  (not a `[a..b]` re-slice), the payload of an optional, the pointee of a
 *  pointer. Same honesty rule as the payloads: the subject's WRITTEN type
 *  must show the layer. Skipped when the name is already typed (an
 *  annotation, or a capture-time inference). */
function bindProjectedLocal(decl: SyntaxNode, resolver: ZigSubjectTypeResolver): void {
  if (!isZigKeywordDeclaration(decl)) return;
  const named = decl.namedChildren.filter(
    (c): c is SyntaxNode => c !== null && c.type !== 'comment',
  );
  if (named.length < 2 || named[0]!.type !== 'identifier') return;
  const value = named[named.length - 1]!;
  if (value.id === decl.childForFieldName('type')?.id) return; // `const x: T;`
  const inner = zigUnwrapValue(value);
  let subject: SyntaxNode | null;
  let project: (spelling: string) => string | undefined;
  switch (inner.type) {
    case 'index_expression':
      if (inner.childForFieldName('index')?.type === 'range_expression') return; // `a[0..n]`
      subject = inner.childForFieldName('object');
      project = zigElementSpelling;
      break;
    case 'null_coercion_expression':
      subject = inner.namedChild(0);
      project = zigOptionalPayloadSpelling;
      break;
    case 'dereference_expression':
      subject = inner.namedChild(0);
      project = zigPointeeSpelling;
      break;
    default:
      return;
  }
  if (subject === null) return;
  const name = named[0]!.text;
  const host = resolver.scopeAt(decl.startPosition.row + 1, decl.startPosition.column, false);
  if (host === undefined || host.typeBindings.has(name)) return;
  const spelling = resolver.spellingOf(subject);
  if (spelling === undefined) return;
  const projected = project(spelling);
  if (projected === undefined) return;
  const rawName = normalizeZigTypeName(projected);
  if (rawName.length === 0 || rawName.startsWith('@')) return;
  const ref: TypeRef =
    projected === rawName
      ? { rawName, declaredAtScope: host.id, source: 'assignment-inferred' }
      : {
          rawName,
          declaredSpelling: projected,
          declaredAtScope: host.id,
          source: 'assignment-inferred',
        };
  (host.typeBindings as Map<string, TypeRef>).set(name, ref);
}

/** `*T` / `*const T` / `E!*T` → `T`; undefined when not visibly a pointer. */
export function zigPointeeSpelling(spelling: string): string | undefined {
  let t = spelling.trim();
  const bang = t.lastIndexOf('!');
  if (bang !== -1) t = t.slice(bang + 1).trim();
  const m = /^\*(const\s+)?/.exec(t);
  if (m === null) return undefined;
  const rest = t.slice(m[0].length).trim();
  return rest.length > 0 ? rest : undefined;
}

function body(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName('body');
}

/** The scope the payload name lives in: the body block's own scope when the
 *  body is a block (`|t| { … }`), otherwise the innermost scope enclosing the
 *  construct (a bare-expression body: `for (items) |t| t.run();`). */
function payloadHostScope(node: SyntaxNode, resolver: ZigSubjectTypeResolver): Scope | undefined {
  // for/if/while_statement carry `body:`; in the *_expression forms the
  // body is the named child right after the payload.
  let bodyNode = body(node);
  if (bodyNode === null) {
    const named = node.namedChildren.filter((c): c is SyntaxNode => c !== null);
    const at = named.findIndex((c) => c.type === 'payload');
    bodyNode = at === -1 ? null : (named[at + 1] ?? null);
  }
  let block: SyntaxNode | null = bodyNode;
  if (block?.type === 'block_expression')
    block = block.namedChildren.find((c) => c?.type === 'block') ?? null;
  if (block?.type === 'labeled_statement')
    block = block.namedChildren.find((c) => c?.type === 'block') ?? null;
  if (block?.type === 'block') {
    const exact = resolver.scopeAt(block.startPosition.row + 1, block.startPosition.column, true);
    if (exact !== undefined) return exact;
  }
  return resolver.scopeAt(node.startPosition.row + 1, node.startPosition.column, false);
}

/** `[]T` / `[]const T` / `[N]T` / `[*]T` / `[*:0]T` / `*[N]T` / `*const []T`
 *  → `T` (with `T`'s own sigils kept: `[]*Thing` → `*Thing`). Undefined when
 *  the written type has no slice/array layer to remove. */
export function zigElementSpelling(spelling: string): string | undefined {
  let t = spelling.trim();
  const bang = t.lastIndexOf('!');
  if (bang !== -1) t = t.slice(bang + 1).trim();
  // A pointer TO an array/slice iterates the pointee.
  t = t.replace(/^\*(const\s+)?(?=\[)/, '');
  const m = /^\[[^\]]*\]\s*(const\s+)?/.exec(t);
  if (m === null) return undefined;
  const rest = t.slice(m[0].length).trim();
  return rest.length > 0 ? rest : undefined;
}

/** `?T` / `?*T` / `E!?T` → `T` (sigils of `T` kept). Undefined when the
 *  written type is not visibly optional. */
export function zigOptionalPayloadSpelling(spelling: string): string | undefined {
  let t = spelling.trim();
  const bang = t.lastIndexOf('!');
  if (bang !== -1) t = t.slice(bang + 1).trim();
  if (!t.startsWith('?')) return undefined;
  const rest = t.slice(1).trim();
  return rest.length > 0 ? rest : undefined;
}

/** Resolves a subject expression to the WRITTEN type spelling of its binding
 *  (`declaredSpelling` when the capture layer reduced it, else `rawName`),
 *  through the finished scope model of one file. */
class ZigSubjectTypeResolver {
  constructor(
    private readonly scopes: readonly Scope[],
    private readonly indexes: ScopeResolutionIndexes,
    private readonly classScopeByDefId: ReadonlyMap<string, Scope>,
  ) {}

  /** Innermost scope containing (line, col); with `exact`, only a scope
   *  STARTING there (a block's own scope). */
  scopeAt(line: number, col: number, exact: boolean): Scope | undefined {
    let best: Scope | undefined;
    for (const s of this.scopes) {
      const r = s.range;
      if (exact) {
        if (r.startLine === line && r.startCol === col && s.kind === 'Block') return s;
        continue;
      }
      const startsBefore = r.startLine < line || (r.startLine === line && r.startCol <= col);
      const endsAfter = r.endLine > line || (r.endLine === line && r.endCol >= col);
      if (!startsBefore || !endsAfter) continue;
      if (best === undefined || contains(best.range, r)) best = s;
    }
    return best;
  }

  spellingOf(subject: SyntaxNode): string | undefined {
    const ref = this.typeRefOf(subject);
    return ref === undefined ? undefined : (ref.declaredSpelling ?? ref.rawName);
  }

  private typeRefOf(subjectRaw: SyntaxNode): TypeRef | undefined {
    const subject = zigUnwrapValue(subjectRaw);
    const scope = this.scopeAt(subject.startPosition.row + 1, subject.startPosition.column, false);
    if (scope === undefined) return undefined;
    switch (subject.type) {
      case 'identifier':
        return findReceiverTypeBinding(scope.id, subject.text, this.indexes);
      case 'field_expression': {
        // `self.items` / `page.session` — the member's binding on the
        // object's class scope (field type, or a method's return type).
        const object = subject.childForFieldName('object');
        const member = subject.childForFieldName('member');
        if (object === null || member === null) return undefined;
        return this.memberRefOf(object, member.text, scope.id);
      }
      case 'call_expression': {
        const callee = subject.childForFieldName('function');
        if (callee === null) return undefined;
        if (callee.type === 'identifier') {
          // A free call: the fn's return binding, in the scope chain.
          return findReceiverTypeBinding(scope.id, callee.text, this.indexes);
        }
        if (callee.type !== 'field_expression') return undefined;
        const object = callee.childForFieldName('object');
        const member = callee.childForFieldName('member');
        if (object === null || member === null) return undefined;
        return this.memberRefOf(object, member.text, scope.id);
      }
      default:
        return undefined;
    }
  }

  /** The binding of `member` on the class the `object` expression is typed
   *  by — recursively through field chains (`self.a.b`). */
  private memberRefOf(object: SyntaxNode, member: string, scopeId: ScopeId): TypeRef | undefined {
    const objectRef = this.typeRefOf(object);
    if (objectRef === undefined) return undefined;
    // A compound rawName (`node.asElement()`, F6's member-call shape) needs
    // the shared compound resolver; not walked here.
    if (objectRef.rawName.includes('(')) return undefined;
    const classDef = findClassBindingInScope(scopeId, objectRef.rawName, this.indexes);
    if (classDef === undefined) return undefined;
    const classScope = this.classScopeByDefId.get(classDef.nodeId);
    return classScope?.typeBindings.get(member);
  }
}

function contains(outer: Scope['range'], inner: Scope['range']): boolean {
  const startsBefore =
    outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startCol <= inner.startCol);
  const endsAfter =
    outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endCol >= inner.endCol);
  return startsBefore && endsAfter;
}
