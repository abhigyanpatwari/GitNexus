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
  findExportedDefByName,
  findReceiverTypeBinding,
} from '../scope/walkers.js';

/** Max depth for compound-receiver chain resolution (`a().b().c().d()`).
 *  Practical code rarely exceeds 3-4 hops; the cap prevents
 *  pathological recursion if the receiver text is malformed. */
const COMPOUND_RECEIVER_MAX_DEPTH = 4;

const MAP_TUPLE_SENTINEL_RE = /^__MAP_TUPLE_(\d+)__:(.+)$/;

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

  // Bare identifier — resolve via typeBinding first, then fall back to
  // a direct class-name lookup. The class-name fallback handles
  // "static receiver" shapes like `UserService.findUser()` where
  // `UserService` isn't a variable but a class imported into scope.
  if (!text.includes('.') && !text.includes('(')) {
    const mapTuple = parseMapTupleSentinel(text);
    if (mapTuple !== null) {
      const rhsTb = findReceiverTypeBinding(inScope, mapTuple.rhs, scopes);
      if (rhsTb === undefined) return undefined;
      const arg = extractShallowMapTypeArgByIndex(rhsTb.rawName, mapTuple.tupleIdx);
      if (arg === undefined) return undefined;
      return findClassBindingInScope(rhsTb.declaredAtScope, arg, scopes);
    }

    const tb = findReceiverTypeBinding(inScope, text, scopes);
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
    }
    return findClassBindingInScope(inScope, text, scopes);
  }

  // Trailing `()` — call expression. Strip it and resolve the function
  // expression's return type. We only handle the canonical `f()` /
  // `obj.method()` shape; nested-arg expressions like `f(g())` are
  // out of scope for V1 (depth-capped recursion catches infinite loops).
  if (text.endsWith(')')) {
    const openIdx = matchingOpenParen(text);
    if (openIdx === -1) return undefined;
    const fnExpr = text.slice(0, openIdx).trim();
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
  const parts = splitChainAtTopLevel(text);

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
