/**
 * C#'s veto on the global-name fallback — see
 * `ScopeResolver.isGlobalNameFallbackPlausible`.
 *
 * The fallback picks a type because its SIMPLE NAME is unique in the
 * workspace. In C# a bare type name is only nameable when the type's
 * namespace is in scope, so a guess into a namespace the caller cannot see is
 * not unlikely but impossible. The classic victim is a Unity project that
 * vendors a protobuf/plugin package: `new Color(1f, 0.5f, 0f)` in a file with
 * only `using UnityEngine;` names `UnityEngine.Color` (external, not indexed),
 * yet used to receive a CALLS edge to the vendored `Vendor.Proto.Color`.
 *
 * A type in namespace `N` is visible by its bare name from a caller when:
 *
 *  1. the caller is declared in `N` or a namespace nested in it (C# lookup
 *     walks the enclosing namespaces outward);
 *  2. the caller's file has `using N;` (or a `using static` / alias whose
 *     target lives under `N`) — a using inside a namespace block may be
 *     written relative to that namespace, so a suffix match also counts;
 *  3. any file in the project has `global using N;`, or an MSBuild
 *     `<Using Include="N" />` item imports it;
 *  4. `N` is under `System` / `Microsoft`, which SDK `ImplicitUsings`
 *     may import without any source evidence.
 *
 * Everything this hook cannot decide is allowed: a qualified call (the source
 * spells the namespace), a candidate with no recorded namespace (global
 * namespace or a non-type member), and a workspace scan that was truncated or
 * never ran (global usings unknown). Only a provably invisible type is refused.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { CsharpResolutionConfig } from './resolution-config.js';

/** Namespace roots SDK `ImplicitUsings` can bring in with no source trace. */
const IMPLICIT_USING_ROOTS: ReadonlySet<string> = new Set(['System', 'Microsoft']);

function normalizeNamespace(raw: string): string {
  return raw
    .trim()
    .replace(/^global::/, '')
    .replace(/@/g, '');
}

function topSegment(ns: string): string {
  const dot = ns.indexOf('.');
  return dot === -1 ? ns : ns.slice(0, dot);
}

/** Namespaces the caller's file declares (block-scoped or file-scoped). */
function callerNamespaces(callerParsed: ParsedFile): Set<string> {
  const namespaces = new Set<string>();
  for (const def of callerParsed.localDefs) {
    if (def.type === 'Namespace' && def.qualifiedName) {
      namespaces.add(normalizeNamespace(def.qualifiedName));
    }
    if (def.namespacePrefix) namespaces.add(normalizeNamespace(def.namespacePrefix));
  }
  return namespaces;
}

/** Whether a using target `target` brings namespace `ns` (or a type in it) into scope. */
function importReaches(target: string, ns: string): boolean {
  return (
    target === ns ||
    // `using static N.Type;` / `using Alias = N.Type;`
    target.startsWith(ns + '.') ||
    // `namespace A { using B; }` may mean `A.B`.
    ns.endsWith('.' + target)
  );
}

export function csharpIsGlobalNameFallbackPlausible(ctx: {
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
  readonly resolutionConfig?: unknown;
  readonly site?: { readonly rawQualifiedName?: string };
}): boolean {
  // `new N.Type()` names its namespace in source; not a bare-name guess.
  if (ctx.site?.rawQualifiedName !== undefined) return true;

  const rawNamespace = ctx.candidate.namespacePrefix;
  // Global namespace, or a symbol whose namespace was not recorded.
  if (rawNamespace === undefined || rawNamespace === '') return true;
  const ns = normalizeNamespace(rawNamespace);

  // Without a complete workspace scan a `global using` may be hiding anywhere.
  const evidence = (ctx.resolutionConfig as CsharpResolutionConfig | undefined)?.namespaces;
  if (evidence?.globalUsings === undefined || evidence.truncated === true) return true;

  if (IMPLICIT_USING_ROOTS.has(topSegment(ns))) return true;
  if (evidence.globalUsings.has(ns)) return true;

  for (const callerNs of callerNamespaces(ctx.callerParsed)) {
    if (callerNs === ns || callerNs.startsWith(ns + '.')) return true;
  }

  for (const imported of ctx.callerParsed.parsedImports) {
    if (!('targetRaw' in imported) || typeof imported.targetRaw !== 'string') continue;
    if (importReaches(normalizeNamespace(imported.targetRaw), ns)) return true;
  }

  return false;
}
