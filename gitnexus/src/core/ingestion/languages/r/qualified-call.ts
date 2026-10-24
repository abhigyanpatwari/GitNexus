/**
 * R `pkg::name()` / `pkg:::name()` qualified calls.
 *
 * The scope query captures the whole `namespace_operator` as
 * `@reference.qualified-name`, so a call site carries `rawQualifiedName`
 * (`pkg::f`). Without it every tier discards the qualifier and guesses by
 * name: `dplyr::filter()` binds to an unrelated local `filter`, and
 * `mypkg::tidy()` inside a wrapper named `tidy` binds to the wrapper itself.
 *
 * {@link populateRQualifiedCalls} runs at `populateWorkspaceReferences` time
 * (before `finalizeScopeModel`, on cold and warm-cache runs alike, with the
 * workspace's `RPackageConfig`) and decides each qualified site by the
 * {@link rQualifierLocality} of its package:
 *
 *  - `external` (not local, and package discovery completed): the site is
 *    dropped from `referenceSites`, so no tier can guess an edge for it;
 *  - `local` with exactly one top-level definition of the name in the
 *    package's `R/` files: that definition is recorded per call site and
 *    returned by {@link resolveRQualifiedFreeCall}, which the free-call
 *    fallback consults before the lexical tiers (a precise 0.85 edge), when
 *    the operator is `:::`, or `::` and the name is public (the package has no
 *    NAMESPACE, or exports the name) or the caller is inside the package's
 *    directory tree ({@link rEnclosingPackageDir}). A `::` site naming a
 *    private or not-provably-exported name from outside is dropped (R errors
 *    there). The fallback's earlier same-name check still wins when the caller has a
 *    non-callable binding of that name (a parameter or `for` variable named
 *    like the target): that site gets no edge (see the limits in
 *    docs/languages/r-provider.md);
 *  - `local` with two or more such definitions (same file or across files):
 *    the site is dropped (every valid target is inside the named package, so
 *    any edge would be provably wrong);
 *  - `local` with no definition: a re-export is the one case that resolves. When
 *    the package's NAMESPACE exports the name and has `importFrom(origin, name)` for
 *    a local `origin` that defines the name exactly once, the site is recorded against
 *    that definition (one hop). Anything else drops the site: a name not exported,
 *    no `importFrom`, an external or multiply-defining origin, or `:::`;
 *  - `unknown` locality (discovery truncated, or no config): the site is dropped.
 *
 * Invariant: after this pass no qualified call site survives without a recorded
 * precise target. The free-call fallback never reads `rawQualifiedName` between its
 * explicit-path hook and the scope-chain walk, so a kept site without a target would
 * walk the lexical scope on the bare tail and bind a caller-local decoy
 * (`pkg::missing()` to the caller's own `missing`).
 *
 * The per-package definition counts are also recorded for the
 * global-name-fallback veto (`isRGlobalNameFallbackPlausible`).
 *
 * Import direction: this file imports `namespace-imports.ts`, never the other
 * way round, so `parseRQualifier` and the definition-count registry live there
 * and are re-exported here.
 */

import type { ParsedFile, ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import { rBuildSymbolVisibilityMemo, type RPackageConfig } from './package-config.js';
import { rBareName } from './bare-name.js';
import {
  parseRQualifier,
  parseRQualifierOperator,
  rEnclosingPackageDir,
  rFileBelongsToDiscoveredPackage,
  rOwningPackageDir,
  rPackageDirForFile,
  rPackageSymbolVisibility,
  rRecordQualifiedDefinitionCounts,
  rReexportOrigin,
  rSymbolVisibility,
  TOP_LEVEL_BINDABLE_TYPES,
} from './namespace-imports.js';

export { parseRQualifier } from './namespace-imports.js';

/** Whether a qualifier's package is a package of the analysed repo. */
export type RQualifierLocality = 'local' | 'external' | 'unknown';

/**
 * True when `filePath` sits under a `<pkg>/R/` directory: a `/`-delimited path
 * segment equal to `pkg` immediately followed by `R/` (`pkg/R/a.R`,
 * `deep/x/pkg/R/a.R`; not `mypkg/R/a.R`, not `pkg/scripts/a.R`).
 *
 * The directory name stands in for the package name only for a file that no discovered
 * package owns (the fallback for a package whose `DESCRIPTION` discovery missed or that has
 * none). A file under a discovered package's `R/` belongs to the package its `DESCRIPTION`
 * names, whatever its directory is called, so it is never evidence for another name.
 */
function isUnderPackageRDir(
  pkg: string,
  filePath: string,
  cfg: RPackageConfig | null | undefined,
): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized.startsWith(`${pkg}/R/`) && !normalized.includes(`/${pkg}/R/`)) return false;
  return !rFileBelongsToDiscoveredPackage(normalized, cfg);
}

/**
 * The directory names `<name>` of the `.../<name>/R/<file>` paths in `filePaths` that no
 * discovered package owns: the names {@link isUnderPackageRDir} would accept, read from all the
 * paths once. {@link rQualifierLocality} asks about every qualifier of a run; answering each from
 * this set instead of a scan of every path makes the work linear in the paths plus the
 * qualifiers instead of their product.
 */
export function rUnownedPackageDirNames(
  filePaths: Iterable<string>,
  cfg: RPackageConfig | null | undefined,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const filePath of filePaths) {
    const parts = filePath.replace(/\\/g, '/').split('/');
    let owned: boolean | undefined;
    // `R` must be a directory (not the last segment), with the package directory before it.
    for (let i = 0; i + 2 < parts.length; i++) {
      if (parts[i + 1] !== 'R' || names.has(parts[i])) continue;
      owned ??= rFileBelongsToDiscoveredPackage(parts.join('/'), cfg);
      if (owned) break;
      names.add(parts[i]);
    }
  }
  return names;
}

/**
 * Locality of the package named by a qualifier.
 *
 *  - `local`: `pkg` is in `cfg.packages`, or a parsed file sits under a
 *    `<pkg>/R/` directory (a package whose `DESCRIPTION` discovery missed or
 *    that has none; root-level packages are found through `cfg` only);
 *  - `external`: not local, and `cfg` exists and its discovery was complete
 *    (`!cfg.truncated`), so `pkg` provably is not part of the repo. This
 *    includes a complete scan that found no package at all (no `DESCRIPTION`
 *    anywhere): the config is then empty, not absent;
 *  - `unknown`: not found, but discovery was truncated or there is no config
 *    (hand-built callers), so `pkg` may still be a local package that was not seen.
 *
 * One predicate, so the populate step and the veto cannot disagree on "local".
 */
export function rQualifierLocality(
  pkg: string,
  cfg: RPackageConfig | null | undefined,
  parsedFilePaths: ReadonlySet<string>,
  /** {@link rUnownedPackageDirNames} of `parsedFilePaths`, when the caller asks many times. */
  unownedPackageDirNames?: ReadonlySet<string>,
): RQualifierLocality {
  if (cfg?.packages.has(pkg) === true) return 'local';
  if (unownedPackageDirNames !== undefined) {
    if (unownedPackageDirNames.has(pkg)) return 'local';
  } else {
    for (const filePath of parsedFilePaths) {
      if (isUnderPackageRDir(pkg, filePath, cfg)) return 'local';
    }
  }
  if (cfg === null || cfg === undefined) return 'unknown';
  return cfg.truncated === true ? 'unknown' : 'external';
}

/**
 * Call site → the single definition its `pkg::name()` qualifier names, for the
 * current run. Module state, replaced wholesale by every
 * {@link populateRQualifiedCalls} call. Keyed by file path and start position
 * (the key `free-call-fallback.ts` uses for its handled sites), not by object
 * identity, so it survives the frozen `ParsedFile` copies made after populate.
 */
let preciseBySite: Map<string, SymbolDefinition> = new Map();

const siteKey = (filePath: string, atRange: { startLine: number; startCol: number }): string =>
  `${filePath}:${atRange.startLine}:${atRange.startCol}`;

function isQualifiedCall(site: ReferenceSite): site is ReferenceSite & {
  readonly rawQualifiedName: string;
} {
  return site.kind === 'call' && site.rawQualifiedName !== undefined;
}

/**
 * Per symbol, every top-level function/class definition (one entry per binding
 * ref, so a same-file redefinition counts twice) of the given package files.
 * Read from Module-scope `local` bindings at extraction time, like
 * `rFileTopLevel`, but keeping the definitions rather than the names. The symbol
 * is the name without the backticks it may be written in, so `pkg::f()` finds
 * `` `f` <- `` and the reverse; definitions spelled both ways count together.
 */
function collectTopLevelDefinitions(files: readonly ParsedFile[]): Map<string, SymbolDefinition[]> {
  const byName = new Map<string, SymbolDefinition[]>();
  for (const parsed of files) {
    const moduleScope = parsed.scopes.find((s) => s.id === parsed.moduleScope);
    if (moduleScope === undefined) continue;
    for (const [name, refs] of moduleScope.bindings) {
      for (const ref of refs) {
        if (ref.origin !== 'local' || !TOP_LEVEL_BINDABLE_TYPES.has(ref.def.type)) continue;
        const symbol = rBareName(name);
        const list = byName.get(symbol);
        if (list === undefined) byName.set(symbol, [ref.def]);
        else list.push(ref.def);
      }
    }
  }
  return byName;
}

/**
 * Decide every qualified call site of `parsedFiles` as described in the file
 * header: drop external, unknown-locality, duplicate-definition and not-reachable sites (in
 * place, through frozen `ParsedFile` copies), record the precise target of every other site.
 * Resets all module state first, so a run never sees the previous run's answers, and builds
 * the pass's export-visibility memo (`rBuildSymbolVisibilityMemo`) before judging any site.
 */
export function populateRQualifiedCalls(
  parsedFiles: ParsedFile[],
  ctx: { readonly resolutionConfig?: unknown },
): void {
  preciseBySite = new Map();
  const cfg = (ctx.resolutionConfig as RPackageConfig | null | undefined) ?? null;
  if (cfg !== null) {
    rRecordQualifiedDefinitionCounts(cfg, new Map());
    rBuildSymbolVisibilityMemo(parsedFiles, cfg);
  }

  // Packages named by some qualified call, and how local each one is.
  let filePaths: Set<string> | undefined;
  let unownedDirNames: ReadonlySet<string> | undefined;
  const localityByPackage = new Map<string, RQualifierLocality>();
  const localityOf = (pkg: string): RQualifierLocality => {
    let locality = localityByPackage.get(pkg);
    if (locality === undefined) {
      filePaths ??= new Set(parsedFiles.map((p) => p.filePath));
      unownedDirNames ??= rUnownedPackageDirNames(filePaths, cfg);
      locality = rQualifierLocality(pkg, cfg, filePaths, unownedDirNames);
      localityByPackage.set(pkg, locality);
    }
    return locality;
  };
  let hasQualifiedSite = false;
  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (!isQualifiedCall(site)) continue;
      hasQualifiedSite = true;
      const pkg = parseRQualifier(site.rawQualifiedName);
      if (pkg !== undefined) localityOf(pkg);
    }
  }
  if (!hasQualifiedSite) return;

  // Top-level definitions of a local package, by name (computed on first use, once per package).
  const definitionsByPackage = new Map<string, Map<string, SymbolDefinition[]>>();
  const definitionsOf = (pkg: string): Map<string, SymbolDefinition[]> => {
    let byName = definitionsByPackage.get(pkg);
    if (byName === undefined) {
      const files: ParsedFile[] = [];
      for (const parsed of parsedFiles) {
        // In the config a package owns its `R/` files (longest-dir wins); otherwise
        // it is local only through the `<pkg>/R/` path, as `rQualifierLocality` decided.
        const inPackage =
          cfg?.packages.has(pkg) === true
            ? rPackageDirForFile(parsed.filePath, cfg)?.name === pkg
            : isUnderPackageRDir(pkg, parsed.filePath, cfg);
        if (inPackage) files.push(parsed);
      }
      byName = collectTopLevelDefinitions(files);
      definitionsByPackage.set(pkg, byName);
    }
    return byName;
  };

  // Decide each site.
  for (let i = 0; i < parsedFiles.length; i++) {
    const parsed = parsedFiles[i];
    const kept: ReferenceSite[] = [];
    for (const site of parsed.referenceSites) {
      if (!isQualifiedCall(site)) {
        kept.push(site);
        continue;
      }
      const pkg = parseRQualifier(site.rawQualifiedName);
      const target =
        pkg === undefined || localityOf(pkg) !== 'local'
          ? undefined
          : resolveLocalQualifiedSite(
              pkg,
              rBareName(site.name),
              parseRQualifierOperator(site.rawQualifiedName) === ':::',
              parsed.filePath,
            );
      if (target === undefined) continue;
      preciseBySite.set(siteKey(parsed.filePath, site.atRange), target);
      kept.push(site);
    }
    if (kept.length !== parsed.referenceSites.length) {
      parsedFiles[i] = Object.freeze({ ...parsed, referenceSites: Object.freeze(kept) });
    }
  }

  if (cfg !== null) {
    rRecordQualifiedDefinitionCounts(
      cfg,
      new Map(
        [...definitionsByPackage].map(([pkg, byName]) => [
          pkg,
          new Map([...byName].map(([name, defs]) => [name, defs.length])),
        ]),
      ),
    );
  }

  /**
   * The definition `pkg::symbol` (or `pkg:::symbol`) reaches from `callerPath`, or `undefined`
   * when the site must be dropped: no definition and no resolvable re-export, several
   * definitions, or a `::` to a name the package does not make public that the caller, outside
   * the package's tree, cannot reach.
   */
  function resolveLocalQualifiedSite(
    pkg: string,
    symbol: string,
    internal: boolean,
    callerPath: string,
  ): SymbolDefinition | undefined {
    const found = definitionsOf(pkg).get(symbol) ?? [];
    if (found.length >= 2) return undefined;
    if (found.length === 1) {
      if (internal) return found[0];
      const visibility = rSymbolVisibility(cfg, found[0].filePath, symbol);
      if (visibility === 'public') return found[0];
      const owner = rOwningPackageDir(found[0].filePath, cfg);
      return owner !== undefined && rEnclosingPackageDir(callerPath, cfg) === owner
        ? found[0]
        : undefined;
    }
    // No definition: only a `::` re-export (`export(name)` + `importFrom(origin, name)`) resolves.
    const pkgDir = cfg?.packages.get(pkg);
    if (internal || cfg === null || pkgDir === undefined) return undefined;
    if (rPackageSymbolVisibility(cfg, pkgDir, symbol) !== 'public') return undefined;
    if (cfg.namespaceInfoByPackageDir.get(pkgDir)?.hasNamespaceFile !== true) return undefined;
    const origin = rReexportOrigin(cfg, pkgDir, pkg, symbol);
    if (origin === undefined || localityOf(origin) !== 'local') return undefined;
    const originDefs = definitionsOf(origin).get(symbol) ?? [];
    return originDefs.length === 1 ? originDefs[0] : undefined;
  }
}

/**
 * `ScopeResolver.resolveQualifiedFreeCall` for R: the definition
 * {@link populateRQualifiedCalls} recorded for this call site, if any.
 *
 * The contract types `site` without its position; the runtime object is the
 * `ReferenceSite`, which has `atRange`. That is read through a narrow cast
 * here instead of widening the shared contract.
 */
export function resolveRQualifiedFreeCall(
  site: object,
  callerParsed: ParsedFile,
): SymbolDefinition | undefined {
  const atRange = (site as { readonly atRange?: { startLine: number; startCol: number } }).atRange;
  return atRange === undefined
    ? undefined
    : preciseBySite.get(siteKey(callerParsed.filePath, atRange));
}
