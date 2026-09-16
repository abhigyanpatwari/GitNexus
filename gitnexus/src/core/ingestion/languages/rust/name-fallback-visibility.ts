/**
 * Rust's veto on the global-name fallback — see
 * `ScopeResolver.isGlobalNameFallbackPlausible`.
 *
 * Rust has NO ambient namespace. A bare `helper()` resolves only against names
 * in scope, and for an item declared in another module the only way in is a
 * `use` path (or a fully-qualified `crate::a::b::helper()` call, which is not a
 * bare free call and never reaches this tier — it carries a qualified name and
 * is resolved earlier by `resolveQualifiedFreeCall`).
 *
 * This hook checks import evidence, not Rust item visibility. A child module
 * can use private ancestor items, and visibility restrictions such as
 * `pub(crate)` require more context than `SymbolDefinition` carries. A matching
 * import therefore keeps a labeled guess rather than proving accessibility.
 *
 * Module paths are matched against the candidate's FILE path (extension
 * stripped, and `mod`/`lib`/`main` stem dropped, since `a/b/mod.rs` IS module
 * `a::b`). `crate::` names the root; `self::` and `super::` resolve relative
 * to the caller's module before comparison.
 */

import type { ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import {
  rustFilesShareCargoTarget,
  rustImportNamesCargoRoot,
  rustIsExclusiveCargoRoot,
  rustImportReachesCargoTarget,
  rustCargoPubliclyReexports,
} from './cargo-targets.js';
import {
  modulePathReaches,
  stripExtension,
} from '../../scope-resolution/utils/name-fallback-visibility.js';

/** File-stems that name their PARENT directory as the module, not themselves. */
const RUST_DIRECTORY_MODULE_STEMS: ReadonlySet<string> = new Set(['mod', 'lib', 'main']);

/** Directories that hold a crate's root and contribute no module segment, so
 *  `src/net/http.rs` is module `net::http` and not `src::net::http`. */
const RUST_CRATE_ROOT_DIRS: ReadonlySet<string> = new Set(['src', 'tests', 'benches', 'examples']);

/** Path prefixes of a `use` that name a root rather than a module segment. */
const RUST_USE_ROOT_PREFIXES: ReadonlySet<string> = new Set(['crate', '$crate']);
const RUST_TYPE_NAMESPACE_KINDS: ReadonlySet<string> = new Set([
  'Namespace',
  'Class',
  'Struct',
  'Enum',
  'Trait',
  'Interface',
  'TypeAlias',
  'Union',
]);

// One scope lookup per immutable parsed-file snapshot, not per fallback site.
// Weak keys release both the snapshot and its index at the end of ingestion.
const scopeLookupByFile = new WeakMap<ParsedFile, ReadonlyMap<ScopeId, Scope>>();

/**
 * The module path a Rust file provides, as a `/`-joined path.
 *
 * Two normalizations, both needed for a file path and a `use` path to line up
 * on their trailing segments: the `mod`/`lib`/`main` stem names its parent
 * directory, and a leading crate-root directory (`src/`) is not a module.
 */
function rustModulePathOf(filePath: string): string {
  const withoutExtension = stripExtension(filePath);
  const segments = withoutExtension.split('/').filter((s) => s !== '');
  const stem = segments[segments.length - 1];
  if (stem !== undefined && RUST_DIRECTORY_MODULE_STEMS.has(stem)) segments.pop();
  // Only the crate-root folder is non-semantic. A nested `src/` is module
  // `src` (`src/src/helper.rs` → `crate::src::helper`), not another root.
  if (segments.length > 0 && RUST_CRATE_ROOT_DIRS.has(segments[0]!)) segments.shift();
  return segments.join('/');
}

/**
 * Directory that owns the crate-root folder (`src`/`tests`/…). Empty when the
 * file sits at the analyzed root (`src/lib.rs`) so a single-crate tree is not
 * refused on a missing workspace prefix.
 */
function rustCrateRootOf(filePath: string): string {
  const segments = stripExtension(filePath)
    .split('/')
    .filter((s) => s !== '');
  const stem = segments[segments.length - 1];
  if (stem !== undefined && RUST_DIRECTORY_MODULE_STEMS.has(stem)) segments.pop();
  const rootIdx = segments.findIndex((s) => RUST_CRATE_ROOT_DIRS.has(s));
  if (rootIdx <= 0) return '';
  return segments.slice(0, rootIdx).join('/');
}

/** Resolve explicit relative prefixes against the caller's module path. */
function rustUsePathOf(targetRaw: string, callerFilePath: string): string {
  const segments = targetRaw.split('::').filter((s) => s !== '');
  if (segments[0] === 'self' || segments[0] === 'super') {
    const base = rustModulePathOf(callerFilePath).split('/').filter(Boolean);
    if (segments[0] === 'self') segments.shift();
    while (segments[0] === 'super') {
      base.pop();
      segments.shift();
    }
    return [...base, ...segments].join('::');
  }
  while (segments.length > 0 && RUST_USE_ROOT_PREFIXES.has(segments[0]!)) segments.shift();
  return segments.join('::');
}

export function rustIsGlobalNameFallbackPlausible(ctx: {
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
  readonly resolutionConfig?: unknown;
  readonly parsedFileOf?: (filePath: string) => ParsedFile | undefined;
  readonly site: {
    readonly name: string;
    readonly rawQualifiedName?: string;
    readonly inScope?: ScopeId;
  };
}): boolean {
  if (ctx.candidate.filePath === ctx.callerParsed.filePath) return true;
  // A PATH-QUALIFIED call (`User::new(...)`, `crate::a::helper()`) reaches this
  // tier when the qualifier could not be followed, carrying only its tail name.
  // It is not a bare-name guess: the source named the path, so the module rule
  // below would refuse an edge the code spells out.
  if (ctx.site.rawQualifiedName !== undefined) return true;

  const candidateModule = rustModulePathOf(ctx.candidate.filePath);
  const sharesTarget = rustFilesShareCargoTarget(
    ctx.resolutionConfig,
    ctx.callerParsed.filePath,
    ctx.candidate.filePath,
  );
  const separateRoot =
    sharesTarget === false &&
    rustIsExclusiveCargoRoot(ctx.resolutionConfig, ctx.candidate.filePath);
  // Cargo membership does not establish cross-file lexical visibility.
  // Root candidates must also pass the import checks below; same-file and
  // explicitly qualified calls have already been handled above.

  const candidateName = rustSimpleNameOf(ctx.candidate);
  const exportModules = new Set([(ctx.candidate.namespacePrefix ?? '').replaceAll('.', '::')]);
  const candidateParsed =
    sharesTarget === false ? ctx.parsedFileOf?.(ctx.candidate.filePath) : undefined;
  if (candidateParsed !== undefined) {
    const moduleByScope = new Map<ScopeId, string>();
    const moduleScopes = new Set<ScopeId>();
    for (const scope of candidateParsed.scopes) {
      const parent = scope.parent === null ? '' : (moduleByScope.get(scope.parent) ?? '');
      const own =
        scope.kind === 'Namespace'
          ? scope.ownedDefs.find((def) => def.type === 'Namespace')?.qualifiedName
          : undefined;
      moduleByScope.set(scope.id, [parent, own].filter(Boolean).join('::'));
      if (scope.kind === 'Namespace' || scope.kind === 'Module') moduleScopes.add(scope.id);
    }
    // Follow same-file re-exports without confusing the defining module with
    // the module an importer sees. Each iteration adds a known module scope,
    // so cycles terminate. Cargo's AST snapshot supplies public visibility,
    // which the coarse parsed reexport/wildcard kind does not preserve.
    let changed = true;
    while (changed) {
      changed = false;
      for (const imp of candidateParsed.parsedImports) {
        if (imp.declaredAtScope === undefined || !moduleScopes.has(imp.declaredAtScope)) continue;
        if (
          imp.kind !== 'wildcard' &&
          (imp.kind !== 'reexport' ||
            imp.localName !== candidateName ||
            imp.importedName !== candidateName)
        )
          continue;
        if (imp.targetRaw.startsWith('::')) continue;
        const owner = moduleByScope.get(imp.declaredAtScope)!;
        if (
          !rustCargoPubliclyReexports(
            ctx.resolutionConfig,
            ctx.candidate.filePath,
            owner,
            imp.targetRaw,
            imp.kind,
            imp.kind === 'wildcard' ? '*' : imp.localName,
          )
        )
          continue;
        const parts = imp.targetRaw.split('::').filter(Boolean);
        if (imp.kind !== 'wildcard') parts.pop();
        const base =
          parts[0] === 'self' || parts[0] === 'super' ? owner.split('::').filter(Boolean) : [];
        if (parts[0] === 'crate' || parts[0] === 'self') parts.shift();
        while (parts[0] === 'super') {
          base.pop();
          parts.shift();
        }
        if (exportModules.has([...base, ...parts].join('::')) && !exportModules.has(owner)) {
          exportModules.add(owner);
          changed = true;
        }
      }
    }
  }
  // Imports are lexical evidence, not a file-wide allowlist. Legacy/synthetic
  // imports without a scope receipt retain the previous conservative behavior.
  let visibleScopes: Set<ScopeId> | undefined;
  if (ctx.site.inScope !== undefined) {
    let scopes = scopeLookupByFile.get(ctx.callerParsed);
    if (scopes === undefined) {
      scopes = new Map(ctx.callerParsed.scopes.map((scope) => [scope.id, scope]));
      scopeLookupByFile.set(ctx.callerParsed, scopes);
    }
    visibleScopes = new Set();
    let current: ScopeId | null = ctx.site.inScope;
    while (current !== null && !visibleScopes.has(current)) {
      visibleScopes.add(current);
      const scope = scopes.get(current);
      if (scope === undefined || scope.kind === 'Namespace') break;
      current = scope.parent;
    }
  }
  const visibleImports = ctx.callerParsed.parsedImports.filter(
    (imp) =>
      imp.declaredAtScope === undefined ||
      visibleScopes === undefined ||
      visibleScopes.has(imp.declaredAtScope),
  );
  const scopeRanks = new Map([...(visibleScopes ?? [])].map((scope, rank) => [scope, rank]));
  const namesCandidateRoot = (module: string, entryOnly: boolean): 'root' | 'module' | false => {
    const pending = [module];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const name = pending.pop()!;
      const parts = name.split('::').filter(Boolean);
      const head = parts[0];
      const bindingName = name.startsWith('::') ? name : head;
      if (!bindingName || seen.has(bindingName)) continue;
      seen.add(bindingName);
      const aliases = visibleImports.filter(
        (imported) => 'localName' in imported && imported.localName === bindingName,
      );
      const rank = (imported: (typeof visibleImports)[number]) =>
        imported.declaredAtScope === undefined
          ? Infinity
          : (scopeRanks.get(imported.declaredAtScope) ?? Infinity);
      const nearest = aliases.length > 0 ? Math.min(...aliases.map(rank)) : Infinity;
      let localTypeRank = Infinity;
      for (const [scopeId, depth] of scopeRanks) {
        const bindings = scopeLookupByFile
          .get(ctx.callerParsed)
          ?.get(scopeId)
          ?.bindings.get(bindingName);
        if (
          bindings?.some(
            (binding) =>
              binding.origin === 'local' && RUST_TYPE_NAMESPACE_KINDS.has(binding.def.type),
          )
        ) {
          localTypeRank = depth;
          break;
        }
      }
      // A local module/type shadows the extern prelude, but a nearer import
      // can shadow that declaration. Value-namespace functions do not block it.
      if (localTypeRank !== Infinity && localTypeRank <= nearest) continue;
      if (aliases.length > 0) {
        const destinations = new Set(
          aliases
            .filter((imported) => rank(imported) === nearest)
            .map((imported) => imported.targetRaw),
        );
        if (destinations.size !== 1) continue;
        const destination = [...destinations][0]!;
        if (destination !== bindingName) {
          pending.push([destination, ...parts.slice(1)].join('::'));
          continue;
        }
      }
      // A root FILE can also contain inline modules. Its Cargo identity names
      // the crate, while the scope model supplies the member's module suffix.
      if (
        rustImportNamesCargoRoot(
          ctx.resolutionConfig,
          ctx.callerParsed.filePath,
          ctx.candidate.filePath,
          head!,
        )
      ) {
        if (exportModules.has(parts.slice(1).join('::'))) return 'root';
        continue;
      }
      if (
        !entryOnly &&
        rustImportReachesCargoTarget(
          ctx.resolutionConfig,
          ctx.callerParsed.filePath,
          ctx.candidate.filePath,
          name,
        )
      )
        return 'module';
    }
    return false;
  };
  for (const imp of visibleImports) {
    let importedRoot = false;
    // `crate::` is the caller's crate. A same trailing module in another
    // workspace crate is a different item and cannot authorize the guess.
    if (imp.targetRaw === 'crate' || imp.targetRaw.startsWith('crate::')) {
      if (sharesTarget === false) continue;
      const callerRoot = rustCrateRootOf(ctx.callerParsed.filePath);
      const candidateRoot = rustCrateRootOf(ctx.candidate.filePath);
      if (
        sharesTarget === undefined &&
        callerRoot !== '' &&
        candidateRoot !== '' &&
        callerRoot !== candidateRoot
      )
        continue;
    }
    if (sharesTarget === false) {
      const module =
        imp.kind === 'wildcard'
          ? imp.targetRaw
          : imp.targetRaw.slice(0, Math.max(0, imp.targetRaw.lastIndexOf('::')));
      const reached = namesCandidateRoot(module, separateRoot);
      if (!reached) continue;
      importedRoot = reached === 'root';
    }
    const usePath = rustUsePathOf(imp.targetRaw, ctx.callerParsed.filePath);
    // Only a glob introduces every bare item of a module. A named import must
    // match both the candidate's original name and the call's local spelling.
    if (imp.kind === 'wildcard') {
      if (importedRoot || candidateModule === '' || modulePathReaches(usePath, candidateModule))
        return true;
      continue;
    }
    if (!('localName' in imp) || imp.localName !== ctx.site.name) continue;
    // Otherwise the path names ONE item inside a module (`use crate::a::other`).
    // Its PARENT is the candidate's module only if that item IS the candidate:
    // importing `other` says nothing about a `helper` in `a`, and the bare
    // parent-path match used to accept every item of `a` on its strength.
    // An alias authorizes only the local spelling checked above.
    if (importedNameOf(imp) !== candidateName) continue;
    // A different target may import the library crate's root exports. Even
    // when that root has no path segment to compare, a named import must name
    // THIS callable: `use std::fmt` cannot revive a rejected `crate::helper`.
    const parent = usePath.slice(0, Math.max(0, usePath.lastIndexOf('::')));
    if (importedRoot || candidateModule === '') return true;
    if (modulePathReaches(usePath, candidateModule)) return true;
    if (parent !== '' && modulePathReaches(parent, candidateModule)) return true;
  }
  return false;
}

/** The identifier a `use` binds, as written at its source (`importedName`). */
function importedNameOf(imp: ParsedFile['parsedImports'][number]): string | undefined {
  return 'importedName' in imp ? imp.importedName : undefined;
}

/**
 * The identifier a Rust declaration contributes to its module: the FIRST
 * segment of `qualifiedName` after any module prefix — `User` for `User.new`
 * (an associated function is reached through its type, so it is the type the
 * `use` must name), the bare name for a free function.
 */
function rustSimpleNameOf(candidate: SymbolDefinition): string {
  const qualified = candidate.qualifiedName ?? '';
  const segments = qualified.split(/::|\./).filter((s) => s !== '');
  return segments[0] ?? '';
}
