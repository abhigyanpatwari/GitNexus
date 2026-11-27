/**
 * C#'s veto on the global-name fallback — see
 * `ScopeResolver.isGlobalNameFallbackPlausible`.
 *
 * C# has explicit namespace visibility: a bare `Color(...)` resolves only when
 * the type's namespace is reachable from the caller. Reachable means one of:
 *
 *  1. Same file — always visible.
 *  2. No namespace on the candidate — the global namespace is visible everywhere.
 *  3. The call site used a qualified name (`Vendor.Proto.Color(...)`) — the
 *     caller explicitly named the type, so refusing it on "no using" would
 *     delete an edge the source spells out.
 *  4. The caller declares the same namespace (or an enclosing one) — C# makes
 *     all types in a namespace visible to files that also declare it, without
 *     any `using` directive.
 *  5. The caller has a `using` for the candidate's namespace or a prefix of it
 *     (e.g. `using Vendor.Proto;` reaches `Vendor.Proto.Color`).
 *
 * Everything else is a spurious global-name match — a type that C# cannot bind
 * from this caller. The issue's real-world shape: Unity projects that vendor a
 * protobuf plugin generating `Color`, `Rect`, etc., and the fallback links
 * `new Color(1f, 0.5f, 0f)` (which is `UnityEngine.Color`) to the vendored
 * `Vendor.Proto.Color` because the name is unique in the repo.
 *
 * `global using` directives are captured as ordinary imports by the C# grammar
 * and appear in `parsedImports` — no special handling needed.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';

/**
 * Extract the namespace a candidate type belongs to.
 *
 * Sources, in priority order:
 *  1. `namespacePrefix` — set by `populateCsharpNamespacePrefixes` during the
 *     owner-population pass. This is the authoritative namespace identity.
 *  2. `qualifiedName` minus the last segment — when a type's qualified name is
 *     `Vendor.Proto.Color`, its namespace is `Vendor.Proto`. Only used when
 *     `namespacePrefix` is absent AND the qualified name has a dot.
 *
 * Returns `undefined` for a type in the global namespace (no namespace).
 */
function candidateNamespace(candidate: SymbolDefinition): string | undefined {
  if (candidate.namespacePrefix) return candidate.namespacePrefix;
  const qualified = candidate.qualifiedName;
  if (qualified === undefined) return undefined;
  const lastDot = qualified.lastIndexOf('.');
  if (lastDot <= 0) return undefined;
  return qualified.slice(0, lastDot);
}

/**
 * The namespace(s) the caller's file declares. Read from `localDefs` —
 * any `Namespace`-typed def whose `qualifiedName` is the namespace string.
 * Also reads `namespacePrefix` on class-like defs as a secondary source (for
 * file-scoped namespaces where the Namespace def may be absent).
 */
function callerNamespaces(callerParsed: ParsedFile): ReadonlySet<string> {
  const result = new Set<string>();
  for (const def of callerParsed.localDefs) {
    if (def.type === 'Namespace' && def.qualifiedName) {
      result.add(def.qualifiedName);
    }
    if (def.namespacePrefix) {
      result.add(def.namespacePrefix);
    }
  }
  return result;
}

/**
 * Whether `candidateNs` is the same as or a child of `callerNs`.
 * `Vendor.Proto` is reachable from a `using Vendor.Proto;`, and
 * `Vendor.Proto.Internal` is reachable from `using Vendor.Proto;` only
 * via a qualified reference — but a file declaring `namespace Vendor.Proto`
 * sees `Vendor.Proto.Internal` types by nesting.
 */
function namespaceMatches(candidateNs: string, callerNs: string): boolean {
  return candidateNs === callerNs || candidateNs.startsWith(callerNs + '.');
}

export function csharpIsGlobalNameFallbackPlausible(ctx: {
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
  readonly site?: { readonly rawQualifiedName?: string };
}): boolean {
  // Rule 1: same file — always visible.
  if (ctx.candidate.filePath === ctx.callerParsed.filePath) return true;

  const candidateNs = candidateNamespace(ctx.candidate);
  // Rule 2: no namespace — global namespace, visible everywhere.
  if (candidateNs === undefined) return true;

  // Rule 3: qualified call site — the caller named the type explicitly.
  if (ctx.site?.rawQualifiedName !== undefined) return true;

  // Rule 4: caller declares the same namespace (or an enclosing one).
  const callerNs = callerNamespaces(ctx.callerParsed);
  for (const ns of callerNs) {
    if (namespaceMatches(candidateNs, ns)) return true;
  }

  // Rule 5: caller has a `using` for the candidate's namespace.
  for (const imp of ctx.callerParsed.parsedImports) {
    if (imp.targetRaw !== undefined && namespaceMatches(candidateNs, imp.targetRaw)) return true;
  }

  return false;
}
