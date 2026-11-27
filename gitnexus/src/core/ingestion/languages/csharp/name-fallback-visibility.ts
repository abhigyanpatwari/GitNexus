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
 * A type in namespace `N` is visible by its bare name from a call site when:
 *
 *  1. the call site is lexically inside `N` or a namespace nested in it (C#
 *     lookup walks the enclosing namespaces outward);
 *  2. the caller's file has `using N;`. A using directive is resolved against
 *     the call site's enclosing namespaces (`namespace A { using B; }` may name
 *     `A.B`), and a namespace import reaches only that namespace — not its
 *     parent. `using static T;` may expose types nested under `T`, and an
 *     alias `using X = N.X;` names the type only when it points at it;
 *  3. the caller's compilation imports `N` globally: `global using N;` in a
 *     file of the same project, `<Using Include="N" />` in that project's
 *     `.csproj`, or in a `Directory.Build.props` / `.targets` above it
 *     (aliased global usings name only the alias and do not count);
 *  4. `N` is one of the namespaces SDK `ImplicitUsings` imports, which leaves
 *     no source evidence.
 *
 * Everything this hook cannot decide is allowed: a qualified call (the source
 * spells the namespace), a candidate with no recorded namespace (global
 * namespace or a non-type member), and a workspace scan that was truncated or
 * never ran (global usings unknown). Only a provably invisible type is refused.
 */

import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { CSharpNamespaceEvidence } from '../../language-config.js';
import type { CsharpResolutionConfig } from './resolution-config.js';

/**
 * Namespaces .NET SDK `ImplicitUsings` adds as global usings, with no source
 * trace. Union over the SDKs (Microsoft.NET.Sdk, .Web, .Worker,
 * .WindowsDesktop); whether a project enables it is not modelled, so the
 * union is allowed everywhere (fail open).
 */
const IMPLICIT_USING_NAMESPACES: ReadonlySet<string> = new Set([
  'System',
  'System.Collections.Generic',
  'System.IO',
  'System.Linq',
  'System.Net.Http',
  'System.Net.Http.Json',
  'System.Threading',
  'System.Threading.Tasks',
  'System.Drawing',
  'System.Windows.Forms',
  'Microsoft.AspNetCore.Builder',
  'Microsoft.AspNetCore.Hosting',
  'Microsoft.AspNetCore.Http',
  'Microsoft.AspNetCore.Routing',
  'Microsoft.Extensions.Configuration',
  'Microsoft.Extensions.DependencyInjection',
  'Microsoft.Extensions.Hosting',
  'Microsoft.Extensions.Logging',
]);

type CsharpScope = ParsedFile['scopes'][number];

function normalizeNamespace(raw: string): string {
  return raw
    .trim()
    .replace(/^global::/, '')
    .replace(/@/g, '');
}

/** `A.B.C` → `['A.B.C', 'A.B', 'A']`: the namespaces C# searches, innermost first. */
function enclosingChain(ns: string | undefined): string[] {
  if (ns === undefined || ns === '') return [];
  const chain: string[] = [];
  let current = ns;
  for (;;) {
    chain.push(current);
    const dot = current.lastIndexOf('.');
    if (dot === -1) return chain;
    current = current.slice(0, dot);
  }
}

function namespaceDeclaredBy(scope: CsharpScope): string | undefined {
  const q = scope.ownedDefs.find((d) => d.type === 'Namespace')?.qualifiedName;
  return q !== undefined && q.length > 0 ? normalizeNamespace(q) : undefined;
}

/**
 * The innermost namespace lexically enclosing the call site, mirroring
 * `populateCsharpNamespacePrefixes`: the nearest ancestor Namespace scope,
 * else a file-scoped `namespace X;` (whose scope spans only its own line, so
 * the file's types hang off the Module scope). A block namespace that does not
 * contain the call site does not apply — the site is in the global namespace.
 *
 * Returns `null` when the site's scope is unknown, so the caller can fall back
 * to the file-wide (permissive) view.
 */
function callSiteNamespace(
  callerParsed: ParsedFile,
  inScope: ScopeId | undefined,
): string | undefined | null {
  if (inScope === undefined) return null;
  const scopesById = new Map<ScopeId, CsharpScope>();
  for (const scope of callerParsed.scopes) scopesById.set(scope.id, scope);
  if (!scopesById.has(inScope)) return null;

  const visited = new Set<ScopeId>();
  let current: ScopeId | null = inScope;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const scope = scopesById.get(current);
    if (scope === undefined) break;
    if (scope.kind === 'Namespace') {
      const ns = namespaceDeclaredBy(scope);
      if (ns !== undefined) return ns;
    }
    current = scope.parent;
  }

  const namespaceScopes = callerParsed.scopes.filter((s) => s.kind === 'Namespace');
  const fileScoped =
    namespaceScopes.length === 1 &&
    namespaceScopes[0]!.range.startLine === namespaceScopes[0]!.range.endLine
      ? namespaceScopes[0]
      : undefined;
  return fileScoped !== undefined ? namespaceDeclaredBy(fileScoped) : undefined;
}

/** Every namespace any declaration in the file sits in — the permissive fallback. */
function fileNamespaces(callerParsed: ParsedFile): string[] {
  const namespaces = new Set<string>();
  for (const def of callerParsed.localDefs) {
    if (def.type === 'Namespace' && def.qualifiedName) {
      namespaces.add(normalizeNamespace(def.qualifiedName));
    }
    if (def.namespacePrefix) namespaces.add(normalizeNamespace(def.namespacePrefix));
  }
  return [...namespaces];
}

/** Nearest `.csproj` directory at or above `filePath` (`''` = repo root / none). */
function owningProjectDir(filePath: string, projectDirs: ReadonlySet<string>): string {
  let dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  for (;;) {
    if (projectDirs.has(dir)) return dir;
    if (dir === '') return '';
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  }
}

function isUnderDir(filePath: string, dir: string): boolean {
  return dir === '' || filePath.startsWith(dir + '/');
}

/** Whether the caller's compilation imports `ns` with a `global using` / MSBuild item. */
function importedGlobally(
  ns: string,
  callerPath: string,
  evidence: CSharpNamespaceEvidence,
): boolean {
  const projectDirs = evidence.projectDirs ?? new Set<string>();
  const callerProject = owningProjectDir(callerPath, projectDirs);
  return (evidence.globalUsings ?? []).some((g) => {
    const target = normalizeNamespace(g.namespace);
    // A static import names a type whose nested types may live under `ns`.
    const reaches = g.static === true ? target.startsWith(ns + '.') : target === ns;
    return (
      reaches &&
      (g.reach === 'tree' ? isUnderDir(callerPath, g.scopeDir) : g.scopeDir === callerProject)
    );
  });
}

/**
 * Whether one of the caller's using directives brings the candidate into
 * scope. `using X;` binds `X` relative to the site's enclosing namespaces
 * first, then as written.
 */
function importedByUsing(
  ns: string,
  candidateName: string,
  callerParsed: ParsedFile,
  enclosing: readonly string[],
  declaredNamespaces: ReadonlySet<string> | undefined,
): boolean {
  for (const imported of callerParsed.parsedImports) {
    if (!('targetRaw' in imported) || typeof imported.targetRaw !== 'string') continue;
    const written = normalizeNamespace(imported.targetRaw);
    const resolutions = [...enclosing.map((outer) => `${outer}.${written}`), written];
    for (const target of resolutions) {
      if (imported.kind === 'alias') {
        // `using Color = N.Color;` names the candidate only when it points at
        // exactly that type; `using Color = N.Other;` binds `Color` elsewhere.
        if (imported.localName === candidateName && target === `${ns}.${candidateName}`) {
          return true;
        }
        continue;
      }
      if (target === ns) return true;
      // C# decomposes `using static T;` to the same shape as `using N;`. A path
      // the repo declares as a namespace is a namespace import and reaches
      // only that namespace; any other path may be a type whose nested types
      // `using static` exposes, so it may reach under its namespace.
      if (declaredNamespaces?.has(target) !== true && target.startsWith(ns + '.')) return true;
    }
  }
  return false;
}

export function csharpIsGlobalNameFallbackPlausible(ctx: {
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
  readonly resolutionConfig?: unknown;
  readonly site?: { readonly rawQualifiedName?: string; readonly inScope?: ScopeId };
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

  if (IMPLICIT_USING_NAMESPACES.has(ns)) return true;
  if (importedGlobally(ns, ctx.callerParsed.filePath, evidence)) return true;

  const siteNamespace = callSiteNamespace(ctx.callerParsed, ctx.site?.inScope);
  const enclosing =
    siteNamespace === null
      ? [...new Set(fileNamespaces(ctx.callerParsed).flatMap((n) => enclosingChain(n)))]
      : enclosingChain(siteNamespace);
  if (enclosing.includes(ns)) return true;

  const candidateName = (ctx.candidate.qualifiedName ?? '').split('.').pop() ?? '';
  return importedByUsing(
    ns,
    candidateName,
    ctx.callerParsed,
    enclosing,
    evidence.declaredNamespaces,
  );
}
