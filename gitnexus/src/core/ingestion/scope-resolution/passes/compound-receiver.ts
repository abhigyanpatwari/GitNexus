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

  // Bare identifier — resolve via typeBinding then class lookup.
  if (!text.includes('.') && !text.includes('(')) {
    const tb = findReceiverTypeBinding(inScope, text, scopes);
    if (tb === undefined) return undefined;
    return findClassBindingInScope(tb.declaredAtScope, tb.rawName, scopes);
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

    if (retType === undefined) return undefined;
    return findClassBindingInScope(retType.declaredAtScope, retType.rawName, scopes);
  }

  // Pure dotted access `obj.field[.field]…` — walk fields.
  const parts = text.split('.');

  // Language-specific collection-accessor suffix (C#'s `data.Values`
  // on Dictionary<K,V>, etc.). When the provider hook recognizes
  // the final segment and unwraps the receiver's generic, return
  // the element class directly. Resolved before the field-walk
  // because Dictionary-family types aren't local class defs.
  if (options.unwrapCollectionAccessor !== undefined && parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    const prefix = parts.slice(0, -1).join('.');
    let prefixType: TypeRef | undefined;
    if (parts.length === 2) {
      prefixType = findReceiverTypeBinding(inScope, prefix, scopes);
    } else {
      // Recursive resolution: walk the prefix as a dotted class chain
      // to find its typeRef. We need the TypeRef (not the class def)
      // because the hook inspects the raw generic args (e.g.
      // `Dictionary<string, User>`).
      const headInner = parts[0]!;
      let cur = findReceiverTypeBinding(inScope, headInner, scopes);
      for (let i = 1; i < parts.length - 1 && cur !== undefined; i++) {
        const cls = findClassBindingInScope(cur.declaredAtScope, cur.rawName, scopes);
        if (cls === undefined) {
          cur = undefined;
          break;
        }
        const cs = classScopeByDefId.get(cls.nodeId);
        cur = cs?.typeBindings.get(parts[i]!);
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

  const head = parts[0]!;
  const headType = findReceiverTypeBinding(inScope, head, scopes);
  let currentClass: SymbolDefinition | undefined = headType
    ? findClassBindingInScope(headType.declaredAtScope, headType.rawName, scopes)
    : undefined;
  for (let i = 1; i < parts.length && currentClass !== undefined; i++) {
    const fieldName = parts[i]!;
    const cs = classScopeByDefId.get(currentClass.nodeId);
    const fieldType = cs?.typeBindings.get(fieldName);
    if (fieldType === undefined) return undefined;
    currentClass = findClassBindingInScope(fieldType.declaredAtScope, fieldType.rawName, scopes);
  }
  return currentClass;
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
