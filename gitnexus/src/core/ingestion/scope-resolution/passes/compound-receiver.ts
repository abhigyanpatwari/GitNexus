/**
 * Resolve a compound-receiver expression's TYPE — `user.address.save()`,
 * `svc.get_user().save()`, `c.greet().save()` — to the class def of
 * the value the receiver expression produces.
 *
 * Three shapes (parsed C-family-style):
 *   - bare identifier `name` — look up via typeBinding chain
 *   - dotted `obj.field[.field]…` — walk fields via class-scope typeBindings
 *   - call `expr.method()` — recurse into expr, find method's return-type
 *     typeBinding on its class, resolve to a class
 *
 * **Field-fallback heuristic** (Phase-9C "unified fixpoint"): when the
 * receiver class has no `methodName`, walk its fields and try the
 * lookup on each field's type. Useful for dynamically-typed languages
 * (Python). Strictly-typed languages should pass
 * `fieldFallbackOnMethodLookup: false` via `ScopeResolver`.
 *
 * Generic for any C-family language (`.` member access, `()` call
 * syntax). Languages with non-C-family syntax (Ruby blocks, COBOL)
 * either don't trigger the call branch or skip this pass entirely.
 */

import type { ScopeId, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';
import {
  findClassBindingInScope,
  findEnclosingClassDef,
  findExportedDefByName,
  findReceiverTypeBinding,
} from '../scope/walkers.js';

/** Max depth for compound-receiver chain resolution (`a().b().c().d()`).
 *  Practical code rarely exceeds 3-4 _syntactic_ hops, but languages
 *  with type-binding-mediated chains (Ruby's `x = obj.method()` binds
 *  `x → obj.method()` and recurses through the compound resolver) can
 *  triple the depth count because each intermediate step contributes
 *  two recursions (bare-ident → compound rawName → call-expr parse).
 *  8 covers 3-level chains with headroom while still capping
 *  pathological recursion. */
const COMPOUND_RECEIVER_MAX_DEPTH = 8;

const MAP_TUPLE_SENTINEL_RE = /^__MAP_TUPLE_(\d+)__:(.+)$/;

/** Cast type the resolver can look up directly: a simple identifier. */
const SIMPLE_CAST_TYPE_RE = /^[a-zA-Z_]\w*$/;

/** Classification-only shape for a cast type that is recognizable but
 *  NOT resolvable here: dotted qualifier (`com.example.Foo`), generic
 *  (`List<String>`), array (`Foo[]`), or combinations
 *  (`com.example.List<Foo>[]`) — shape `Ident(.Ident)*(<…>)?([])*`,
 *  whitespace-tolerant. No attempt is made to parse generic contents;
 *  `[^()]*` merely keeps expression-like paren content from matching.
 *  Matching this shape (when the simple-identifier shape doesn't)
 *  means the paren group IS a C-style cast whose target type we cannot
 *  look up — the only safe outcome is to resolve nothing, never to
 *  fall through to the pre-cast expression's own declared type. */
const UNPARSEABLE_CAST_TYPE_RE =
  /^[a-zA-Z_]\w*(?:\s*\.\s*[a-zA-Z_]\w*)*(?:\s*<[^()]*>)?(?:\s*\[\s*\])*$/;

function parseMapTupleSentinel(text: string): { tupleIdx: number; rhs: string } | null {
  const match = MAP_TUPLE_SENTINEL_RE.exec(text);
  if (match === null) return null;
  const [, idxStr, rhs] = match;
  if (idxStr === undefined || rhs === undefined) return null;
  return { tupleIdx: Number(idxStr), rhs };
}

interface ResolveCompoundReceiverOptions {
  /** When true (default), if method lookup fails on the receiver's
   *  class, walk its fields and try the lookup on each field's class.
   *  Phase-9C "unified fixpoint" — Python-shaped heuristic. */
  readonly fieldFallback?: boolean;
  /** Language-specific accessor unwrap — `data.Values` on a
   *  Dictionary<K,V>-typed receiver yields V (C#), etc. Returns the
   *  element type's simple name, or `undefined` to let the regular
   *  field-walk handle the access. */
  readonly unwrapCollectionAccessor?: (
    receiverType: string,
    accessor: string,
  ) => string | undefined;
  /** Walk up from the class scope to ancestor (Module) scopes when
   *  looking up a method's return-type typeBinding. Only enable for
   *  languages that hoist return-type bindings to Module scope (C#);
   *  otherwise we risk picking up unrelated module-level bindings. */
  readonly hoistTypeBindingsToModule?: boolean;
  /** Strip C-style cast expressions from the receiver text before
   *  resolving it (`stripCastWrappers`). Default `false` — the text
   *  reaches the resolver untouched and no cast logic runs. See the
   *  `ScopeResolver` contract toggle of the same name for the
   *  classifier grammar and per-language opt-in rules. */
  readonly stripReceiverCastExpressions?: boolean;
}

export function resolveCompoundReceiverClass(
  receiverText: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
  options: ResolveCompoundReceiverOptions = {},
  depth = 0,
): SymbolDefinition | undefined {
  const classScopeByDefId = index.classScopeByDefId;
  if (depth > COMPOUND_RECEIVER_MAX_DEPTH) return undefined;
  const text = receiverText.trim();
  if (text.length === 0) return undefined;
  const fieldFallback = options.fieldFallback ?? true;

  // ── Pre-processing: strip C-style cast expressions (opt-in) ──────
  // Cast-wrapped receivers like ((Type)((Object)this.field)).method()
  // produce parenthesized-expression receiver text. For languages that
  // opt in via `stripReceiverCastExpressions`, peel outer (Type)
  // layers so the resolver sees the actual receiver (e.g. this.field)
  // — `stripCastWrappers` documents the classification rules. When
  // the toggle is off, the text reaches the resolver untouched and no
  // cast logic runs.
  let workingText = text;
  if (options.stripReceiverCastExpressions === true && text.startsWith('(')) {
    const stripped = stripCastWrappers(text);
    // A recognized cast whose target type cannot be looked up here:
    // the only safe outcome is to resolve nothing — falling through
    // to the pre-cast expression's own declared type would emit a
    // confident wrong edge.
    if (stripped.unresolvableCast) return undefined;
    workingText = stripped.workingText;
    // A captured cast type names the exact receiver type for method
    // resolution — the cast narrows the receiver's declared type, so
    // resolve to the CAST type, not the underlying expression's type.
    if (stripped.castType !== undefined) {
      const cls = findClassBindingInScope(inScope, stripped.castType, scopes);
      if (cls !== undefined) return cls;
    }
  }

  // ── End pre-processing ─────────────────────────────────────────

  // Bare identifier — resolve via typeBinding first, then fall back to
  // a direct class-name lookup. The class-name fallback handles
  // "static receiver" shapes like `UserService.findUser()` where
  // `UserService` isn't a variable but a class imported into scope.
  if (!workingText.includes('.') && !workingText.includes('(')) {
    const mapTuple = parseMapTupleSentinel(workingText);
    if (mapTuple !== null) {
      const rhsTb = findReceiverTypeBinding(inScope, mapTuple.rhs, scopes);
      if (rhsTb === undefined) return undefined;
      const arg = extractShallowMapTypeArgByIndex(rhsTb.rawName, mapTuple.tupleIdx);
      if (arg === undefined) return undefined;
      return findClassBindingInScope(rhsTb.declaredAtScope, arg, scopes);
    }

    const tb = findReceiverTypeBinding(inScope, workingText, scopes);
    if (tb !== undefined) {
      // Map for-of: binding name is `user` but rawType is
      // `__MAP_TUPLE_i__:entries` (see captures.ts) — same extraction as
      // the literal-sentinel branch above.
      const boundMapTuple = parseMapTupleSentinel(tb.rawName);
      if (boundMapTuple !== null) {
        const rhsTb = findReceiverTypeBinding(inScope, boundMapTuple.rhs, scopes);
        if (rhsTb === undefined) return undefined;
        const arg = extractShallowMapTypeArgByIndex(rhsTb.rawName, boundMapTuple.tupleIdx);
        if (arg === undefined) return undefined;
        return findClassBindingInScope(rhsTb.declaredAtScope, arg, scopes);
      }

      const viaTb = findClassBindingInScope(tb.declaredAtScope, tb.rawName, scopes);
      if (viaTb !== undefined) return viaTb;

      // Member-alias / call-result shapes store the RHS path on rawName
      // (`user.address`, `addr.getCity`) — resolve as a compound chain.
      if (tb.rawName.includes('.') && !tb.rawName.includes('(')) {
        const dotted = resolveCompoundReceiverClass(
          tb.rawName,
          inScope,
          scopes,
          index,
          options,
          depth + 1,
        );
        if (dotted !== undefined) return dotted;
        const dottedCall = resolveCompoundReceiverClass(
          `${tb.rawName}()`,
          inScope,
          scopes,
          index,
          options,
          depth + 1,
        );
        if (dottedCall !== undefined) return dottedCall;
      }

      // Callable alias (`const user = getUser()` → type rawName `getUser`)
      if (!tb.rawName.includes('.') && !tb.rawName.includes('(')) {
        const callAlias = resolveCompoundReceiverClass(
          `${tb.rawName}()`,
          inScope,
          scopes,
          index,
          options,
          depth + 1,
        );
        if (callAlias !== undefined) return callAlias;
      }

      // Compound member-call alias: rawName has both `.` and `()`
      // (`user = Factory.get_user()` → rawName `Factory.get_user()`).
      // Recurse into the compound resolver with the raw compound
      // expression so the mixed-chain parser can split at top-level
      // `.` and resolve the receiver + method return type.
      if (tb.rawName.includes('.') && tb.rawName.includes('(')) {
        const compound = resolveCompoundReceiverClass(
          tb.rawName,
          inScope,
          scopes,
          index,
          options,
          depth + 1,
        );
        if (compound !== undefined) return compound;
      }
    }
    return findClassBindingInScope(inScope, workingText, scopes);
  }

  // Trailing `()` — call expression. Strip it and resolve the function
  // expression's return type. We only handle the canonical `f()` /
  // `obj.method()` shape; nested-arg expressions like `f(g())` are
  // out of scope for V1 (depth-capped recursion catches infinite loops).
  if (workingText.endsWith(')')) {
    const openIdx = matchingOpenParen(workingText);
    if (openIdx === -1) return undefined;
    const fnExpr = workingText.slice(0, openIdx).trim();
    if (fnExpr.length === 0) return undefined;

    const lastDot = fnExpr.lastIndexOf('.');
    if (lastDot === -1) {
      // Free call `name()`. Look up function in scope, then its
      // return-type typeBinding (which lives in the function's
      // enclosing scope per the language's return-type hoist rule).
      const fnDef = findExportedDefByName(fnExpr, inScope, scopes, index);
      if (fnDef === undefined) return undefined;
      const retType = findReceiverTypeBinding(inScope, fnExpr, scopes);
      if (retType === undefined) return undefined;
      return findClassBindingInScope(retType.declaredAtScope, retType.rawName, scopes);
    }

    // `obj.method()` — resolve obj's class, look up method's return
    // type on that class scope (or the MRO).
    const objExpr = fnExpr.slice(0, lastDot);
    const methodName = fnExpr.slice(lastDot + 1);
    const objClass = resolveCompoundReceiverClass(
      objExpr,
      inScope,
      scopes,
      index,
      options,
      depth + 1,
    );
    if (objClass === undefined) return undefined;

    let retType: TypeRef | undefined;
    const ownerChain = [objClass.nodeId, ...scopes.methodDispatch.mroFor(objClass.nodeId)];
    for (const ownerId of ownerChain) {
      const cs = classScopeByDefId.get(ownerId);
      const candidate = cs?.typeBindings.get(methodName);
      if (candidate !== undefined) {
        retType = candidate;
        break;
      }
      // Fallback: walk up from the class scope looking for a return-
      // type binding on an ancestor (Module) scope. Gated on
      // `hoistTypeBindingsToModule` because only languages that hoist
      // method return-type bindings to Module scope need this path;
      // enabling it unconditionally would let other languages pick up
      // unrelated module-level bindings. See contract doc for the
      // invariant and `propagateImportedReturnTypes` for how the
      // hoisted bindings originate.
      if (cs !== undefined && options.hoistTypeBindingsToModule === true) {
        let curId: ScopeId | null = cs.parent;
        while (curId !== null) {
          const curScope = scopes.scopeTree.getScope(curId);
          if (curScope === undefined) break;
          const cand = curScope.typeBindings.get(methodName);
          if (cand !== undefined) {
            retType = cand;
            break;
          }
          curId = curScope.parent;
        }
        if (retType !== undefined) break;
      }
    }

    if (retType === undefined && fieldFallback) {
      const objCs = classScopeByDefId.get(objClass.nodeId);
      if (objCs !== undefined) {
        for (const [, fieldType] of objCs.typeBindings) {
          const fieldClass = findClassBindingInScope(
            fieldType.declaredAtScope,
            fieldType.rawName,
            scopes,
          );
          if (fieldClass === undefined) continue;
          const fcs = classScopeByDefId.get(fieldClass.nodeId);
          const candidate = fcs?.typeBindings.get(methodName);
          if (candidate !== undefined) {
            retType = candidate;
            break;
          }
        }
      }
    }

    // `Map<K,V>.values()` / `this.repos.values()` — lib `Map` often has no
    // parsed return-type binding; infer `V` from the receiver field's
    // `Map<…>` annotation when the method is `values`.
    if (retType === undefined && methodName === 'values') {
      const mapVal = resolveMapValueTypeNameFromPrefix(objExpr, inScope, scopes, index, options);
      if (mapVal !== undefined) {
        retType = {
          rawName: mapVal,
          declaredAtScope: inScope,
          source: 'return-annotation',
        };
      }
    }

    if (retType === undefined) return undefined;
    return findClassBindingInScope(retType.declaredAtScope, retType.rawName, scopes);
  }

  // Mixed dotted + call chain: `obj.field.method().field.method()…`.
  // Split at top-level `.` (those NOT inside balanced `(...)`) so a
  // middle segment like `getUser()` stays intact. Each segment is
  // either a bare identifier `field` OR `method(...)` — the former
  // resolves via the current class's typeBindings (field → type),
  // the latter resolves via the current class's typeBindings
  // (method return-type). We accept both on each hop because class
  // scopes store both method return types and field types under
  // `typeBindings` keyed by the member name.
  const parts = splitChainAtTopLevel(workingText);

  // Language-specific collection-accessor suffix (C#'s `data.Values`
  // on Dictionary<K,V>, etc.). When the provider hook recognizes
  // the final segment and unwraps the receiver's generic, return
  // the element class directly. Resolved before the field-walk
  // because Dictionary-family types aren't local class defs.
  if (options.unwrapCollectionAccessor !== undefined && parts.length >= 2) {
    const last = parts[parts.length - 1];
    const headInner = parts[0];
    if (last === undefined || headInner === undefined) return undefined;
    const prefix = parts.slice(0, -1).join('.');
    let prefixType: TypeRef | undefined;
    if (parts.length === 2) {
      prefixType = findReceiverTypeBinding(inScope, prefix, scopes);
    } else {
      // Recursive resolution: walk the prefix as a dotted class chain
      // to find its typeRef. We need the TypeRef (not the class def)
      // because the hook inspects the raw generic args (e.g.
      // `Dictionary<string, User>`).
      let cur = findReceiverTypeBinding(inScope, headInner, scopes);
      for (let i = 1; i < parts.length - 1 && cur !== undefined; i++) {
        const segment = parts[i];
        if (segment === undefined) break;
        const cls = findClassBindingInScope(cur.declaredAtScope, cur.rawName, scopes);
        if (cls === undefined) {
          cur = undefined;
          break;
        }
        const cs = classScopeByDefId.get(cls.nodeId);
        cur = cs?.typeBindings.get(segment);
      }
      prefixType = cur;
    }
    if (prefixType !== undefined) {
      const elemName = options.unwrapCollectionAccessor(prefixType.rawName, last);
      if (elemName !== undefined) {
        return findClassBindingInScope(prefixType.declaredAtScope, elemName, scopes);
      }
    }
  }

  const head = parts[0];
  if (head === undefined) return undefined;
  const headMemberName = stripCallParens(head);
  const headType = findReceiverTypeBinding(inScope, headMemberName, scopes);
  let currentClass: SymbolDefinition | undefined = headType
    ? findClassBindingInScope(headType.declaredAtScope, headType.rawName, scopes)
    : findClassBindingInScope(inScope, headMemberName, scopes);
  // Head seed for a literal `this` head with no receiver typeBinding in
  // scope: languages synthesize `this` typeBindings per function scope,
  // so a chain site outside any function scope (a field initializer or
  // an instance initializer block) has none — there, the enclosing
  // class definition IS the receiver type. Restricted to initializer
  // contexts (no Function scope between the site and its class): a
  // Function scope WITHOUT a `this` typeBinding means the language
  // deliberately left `this` unbound there (object-literal methods,
  // nested plain functions, static contexts), and seeding the
  // lexically enclosing class would fabricate edges. Head resolution
  // only; the per-segment walk below is shared with every other
  // chain shape.
  if (
    currentClass === undefined &&
    headType === undefined &&
    headMemberName === 'this' &&
    isInitializerContext(inScope, scopes)
  ) {
    currentClass = findEnclosingClassDef(inScope, scopes);
  }
  // `const user = getUser(); user.address` — the typeBinding for `user`
  // is an alias to the callee name (`getUser`), not a class. When
  // `findClassBinding` on that rawName fails, treat it as a zero-arg
  // call so return-type hoisting resolves to the class (`User`).
  if (
    currentClass === undefined &&
    headType !== undefined &&
    !headType.rawName.includes('.') &&
    !headType.rawName.includes('(')
  ) {
    currentClass = resolveCompoundReceiverClass(
      `${headType.rawName}()`,
      inScope,
      scopes,
      index,
      options,
      depth + 1,
    );
  }
  for (let i = 1; i < parts.length && currentClass !== undefined; i++) {
    const segment = parts[i];
    if (segment === undefined) break;
    const memberName = stripCallParens(segment);
    const cs = classScopeByDefId.get(currentClass.nodeId);
    let memberType = cs?.typeBindings.get(memberName);
    if (
      memberType === undefined &&
      options.hoistTypeBindingsToModule === true &&
      cs !== undefined
    ) {
      let curId: ScopeId | null = cs.parent;
      while (curId !== null) {
        const curScope = scopes.scopeTree.getScope(curId);
        if (curScope === undefined) break;
        const cand = curScope.typeBindings.get(memberName);
        if (cand !== undefined) {
          memberType = cand;
          break;
        }
        curId = curScope.parent;
      }
    }
    if (memberType === undefined) {
      // Trailing segment may be a method name without `()` — e.g.
      // `this.repos.values` from a for-of iterable capture. Try the
      // call-shaped resolver before giving up.
      if (!segment.includes('(')) {
        const prefix = parts.slice(0, i).join('.');
        const asCall = resolveCompoundReceiverClass(
          `${prefix}.${memberName}()`,
          inScope,
          scopes,
          index,
          options,
          depth + 1,
        );
        if (asCall !== undefined) return asCall;
      }
      return undefined;
    }
    let nextClass = findClassBindingInScope(memberType.declaredAtScope, memberType.rawName, scopes);
    if (nextClass === undefined) {
      const fromMap = unwrapMapValueToClass(memberType, scopes);
      if (fromMap !== undefined) nextClass = fromMap;
    }
    currentClass = nextClass;
  }
  return currentClass;
}

/**
 * Split a chain expression like `a.b().c.d()` at top-level `.`
 * separators — i.e. `.` characters NOT nested inside balanced
 * `(...)`, `[...]`, or `<...>` delimiters. Returns the segments in
 * order: `['a', 'b()', 'c', 'd()']`. Malformed input falls back to
 * a plain `split('.')`.
 */
function splitChainAtTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '>') depth = Math.max(0, depth - 1);
    else if (ch === '.' && depth === 0) {
      out.push(text.slice(last, i));
      last = i + 1;
    }
  }
  out.push(text.slice(last));
  // Guard against pathological input (`a.` / `.a`) — drop empties.
  return out.filter((s) => s.length > 0);
}

/**
 * Strip a trailing `(...)` from a chain segment so typeBinding lookup
 * uses the member name: `'getUser()'` → `'getUser'`. Leaves bare
 * identifiers (`'address'`) unchanged. Arguments inside the parens
 * are discarded — the compound resolver is return-type only.
 */
function stripCallParens(segment: string): string {
  if (!segment.endsWith(')')) return segment;
  const open = segment.indexOf('(');
  if (open === -1) return segment;
  return segment.slice(0, open);
}

/** True when `startScope` sits under a Class scope with no Function
 *  scope in between — a field-initializer or instance-initializer
 *  context, the only place a literal `this` chain head may be seeded
 *  from the lexically enclosing class. Function bodies are excluded
 *  on purpose: a Function scope carrying no `this` typeBinding means
 *  the language deliberately left `this` unbound there. */
function isInitializerContext(startScope: ScopeId, scopes: ScopeResolutionIndexes): boolean {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return false;
    if (scope.kind === 'Class') return true;
    if (scope.kind === 'Function') return false;
    currentId = scope.parent;
  }
  return false;
}

/** Find the index of the `(` that matches the trailing `)` of a
 *  call-expression text. Returns -1 if unbalanced. */
function matchingOpenParen(text: string): number {
  if (!text.endsWith(')')) return -1;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Max peel iterations for `stripCastWrappers`. Real cast nesting —
 *  including decompiler output like `((Target)((Object)expr))` —
 *  is a handful of levels, and each cast level costs at most two
 *  peels (a redundant-paren unwrap plus the cast group itself), so
 *  16 covers 8-level nesting with headroom. Each peel rescans the
 *  working text for its matching close paren, so pathological input
 *  like `((((…))))` would otherwise cost O(N²); the cap bounds it at
 *  O(N · MAX_CAST_PEEL). Exceeding the cap bails with the not-a-cast
 *  outcome and the ORIGINAL text — all-or-nothing, never a
 *  partially-peeled result. */
const MAX_CAST_PEEL = 16;

/**
 * Peel C-style cast layers off a receiver-position expression:
 * `((Target)((Other)expr))` → `workingText` `expr`, `castType`
 * `Target`. Pure text scan — no scope or index access — consumed by
 * `resolveCompoundReceiverClass` when a language opts in via
 * `stripReceiverCastExpressions`. Track the outermost meaningful cast
 * type: the cast narrows the receiver's declared type, so the caller
 * resolves the CAST type, not the underlying expression's type.
 *
 * Each peeled paren group with a non-empty trailing expression (a
 * cast candidate) is classified three ways:
 *   (a) simple identifier (`SIMPLE_CAST_TYPE_RE`) → cast type
 *       captured (outermost capture wins; later simple groups are
 *       noise casts, as in decompiler output like
 *       `((Target)((Object)expr))`);
 *   (b) type-shaped but unparseable here — dotted / generic / array
 *       (`UNPARSEABLE_CAST_TYPE_RE`) → this IS a cast, but its type
 *       cannot be looked up: report `unresolvableCast: true` so the
 *       caller resolves nothing rather than falling through to the
 *       pre-cast expression's own declared type (the pre-#2353 safe
 *       no-op for these shapes);
 *   (c) anything else → not a cast: stop scanning and return the
 *       text peeled so far for the normal resolver.
 * A paren group with an EMPTY remainder is never a cast candidate —
 * `((…))` / `(foo)` is a redundant-paren unwrap: unwrap and re-scan
 * without capturing anything.
 *
 * Known limitation: the paren scan is not string-literal-aware — a
 * `)` inside a quoted call argument (e.g. `((T)f(")")).g`) mis-scans
 * the group boundary. Such shapes classify as not-a-cast and fall
 * through safely to the normal resolver.
 */
export function stripCastWrappers(text: string): {
  workingText: string;
  castType: string | undefined;
  unresolvableCast: boolean;
} {
  let castType: string | undefined;
  let workingText = text;
  let peels = 0;
  while (true) {
    if (!workingText.startsWith('(')) break;
    peels++;
    if (peels > MAX_CAST_PEEL) {
      return { workingText: text, castType: undefined, unresolvableCast: false };
    }
    let d = 1;
    let closeIdx = -1;
    for (let i = 1; i < workingText.length; i++) {
      if (workingText[i] === '(') d++;
      else if (workingText[i] === ')') {
        d--;
        if (d === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    if (closeIdx === -1) break;
    const insideParens = workingText.slice(1, closeIdx).trim();
    const remainder = workingText.slice(closeIdx + 1).trim();
    // Empty remainder: redundant outer parens — `((…))`, or a plain
    // parenthesized expression like `(foo)`. Unwrap and re-scan.
    // Never a cast candidate: a cast needs a trailing expression, so
    // nothing is captured from this group.
    if (remainder.length === 0) {
      workingText = insideParens;
      continue;
    }
    // A cast operand starts with `(`, an identifier, or `this`. Any
    // other remainder shape (e.g. `.member` access on the paren
    // group) means this group is not a cast — leave the text for the
    // normal resolver.
    if (!remainder.startsWith('(') && !/^[a-zA-Z_]/.test(remainder)) break;
    if (SIMPLE_CAST_TYPE_RE.test(insideParens)) {
      // (a) Resolvable cast type — capture the FIRST (outermost) one.
      if (castType === undefined) castType = insideParens;
    } else if (UNPARSEABLE_CAST_TYPE_RE.test(insideParens)) {
      // (b) Type-shaped but unparseable cast. Once a simple cast type
      // has been captured, later unparseable groups are noise casts
      // and the captured type wins; otherwise report the whole
      // expression as an unresolvable cast so the caller bails out.
      if (castType === undefined) {
        return { workingText, castType: undefined, unresolvableCast: true };
      }
    } else {
      // (c) Not a cast.
      break;
    }
    workingText = remainder;
  }
  return { workingText, castType, unresolvableCast: false };
}

/** Type arguments of a shallow `Map<K,V>` / `ReadonlyMap<K,V>` (depth-aware). */
function extractShallowMapTypeArgByIndex(mapText: string, wantIndex: number): string | undefined {
  const t = mapText.trim();
  const m = /^(?:ReadonlyMap|Map)\s*</.exec(t);
  if (m === null || m.index !== 0) return undefined;
  const openIdx = m[0].length - 1;
  if (t[openIdx] !== '<') return undefined;
  let depth = 1;
  const args: string[] = [];
  let segStart = openIdx + 1;
  for (let i = openIdx + 1; i < t.length; i++) {
    const ch = t[i];
    if (ch === '<') depth++;
    else if (ch === '>') {
      depth--;
      if (depth === 0) {
        const tail = t.slice(segStart, i).trim();
        if (tail.length > 0) args.push(tail);
        break;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(t.slice(segStart, i).trim());
      segStart = i + 1;
    }
  }
  const picked = args[wantIndex]?.trim();
  return picked !== undefined && picked.length > 0 ? picked : undefined;
}

function unwrapMapValueToClass(
  memberType: TypeRef,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  const v = extractShallowMapTypeArgByIndex(memberType.rawName, 1);
  if (v === undefined) return undefined;
  return findClassBindingInScope(memberType.declaredAtScope, v, scopes);
}

/**
 * Walk `objExpr` as a field chain (`this.repos`) and return the `V`
 * type name from a terminal `Map<K,V>` field binding — used when
 * resolving `.values()` without a parsed stdlib return type.
 */
function resolveMapValueTypeNameFromPrefix(
  objExpr: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
  options: ResolveCompoundReceiverOptions,
): string | undefined {
  const classScopeByDefId = index.classScopeByDefId;
  const parts = splitChainAtTopLevel(objExpr);
  const head = parts[0];
  if (head === undefined) return undefined;
  const headMemberName = stripCallParens(head);
  const headType = findReceiverTypeBinding(inScope, headMemberName, scopes);
  let currentClass: SymbolDefinition | undefined = headType
    ? findClassBindingInScope(headType.declaredAtScope, headType.rawName, scopes)
    : findClassBindingInScope(inScope, headMemberName, scopes);
  if (
    currentClass === undefined &&
    headType !== undefined &&
    !headType.rawName.includes('.') &&
    !headType.rawName.includes('(')
  ) {
    currentClass = resolveCompoundReceiverClass(
      `${headType.rawName}()`,
      inScope,
      scopes,
      index,
      options,
      1,
    );
  }
  let lastMemberType: TypeRef | undefined;
  for (let i = 1; i < parts.length && currentClass !== undefined; i++) {
    const segment = parts[i];
    if (segment === undefined) break;
    const memberName = stripCallParens(segment);
    const cs = classScopeByDefId.get(currentClass.nodeId);
    if (cs === undefined) return undefined;
    let memberType = cs.typeBindings.get(memberName);
    if (memberType === undefined && options.hoistTypeBindingsToModule === true) {
      let curId: ScopeId | null = cs.parent;
      while (curId !== null) {
        const curScope = scopes.scopeTree.getScope(curId);
        if (curScope === undefined) break;
        const cand = curScope.typeBindings.get(memberName);
        if (cand !== undefined) {
          memberType = cand;
          break;
        }
        curId = curScope.parent;
      }
    }
    if (memberType === undefined) return undefined;
    lastMemberType = memberType;
    let nextClass = findClassBindingInScope(memberType.declaredAtScope, memberType.rawName, scopes);
    if (nextClass === undefined) {
      const fromMap = unwrapMapValueToClass(memberType, scopes);
      if (fromMap !== undefined) nextClass = fromMap;
    }
    currentClass = nextClass;
  }
  if (lastMemberType === undefined) return undefined;
  return extractShallowMapTypeArgByIndex(lastMemberType.rawName, 1);
}
