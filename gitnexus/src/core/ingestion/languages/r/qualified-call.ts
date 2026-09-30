/**
 * R `pkg::name()` / `pkg:::name()` qualified calls (fork #7).
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
 *    fallback consults before every lexical tier (a precise 0.85 edge);
 *  - `local` with two or more such definitions (same file or across files):
 *    the site is dropped (every valid target is inside the named package, so
 *    any edge would be provably wrong);
 *  - `local` with no definition (a re-export, or a name defined some other
 *    way) and `unknown` locality: the site is left untouched, i.e. today's
 *    behaviour.
 *
 * The per-package definition counts are also recorded for the
 * global-name-fallback veto (`isRGlobalNameFallbackPlausible`).
 *
 * Import direction: this file imports `namespace-imports.ts`, never the other
 * way round, so `parseRQualifier` and the definition-count registry live there
 * and are re-exported here.
 */

import type { ParsedFile, ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import type { RPackageConfig } from './package-config.js';
import {
  parseRQualifier,
  rPackageDirForFile,
  rRecordQualifiedDefinitionCounts,
  TOP_LEVEL_BINDABLE_TYPES,
} from './namespace-imports.js';

export { parseRQualifier } from './namespace-imports.js';

/** Whether a qualifier's package is a package of the analysed repo. */
export type RQualifierLocality = 'local' | 'external' | 'unknown';

/**
 * True when `filePath` sits under a `<pkg>/R/` directory: a `/`-delimited path
 * segment equal to `pkg` immediately followed by `R/` (`pkg/R/a.R`,
 * `deep/x/pkg/R/a.R`; not `mypkg/R/a.R`, not `pkg/scripts/a.R`).
 */
function isUnderPackageRDir(pkg: string, filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.startsWith(`${pkg}/R/`) || normalized.includes(`/${pkg}/R/`);
}

/**
 * Locality of the package named by a qualifier.
 *
 *  - `local`: `pkg` is in `cfg.packages`, or a parsed file sits under a
 *    `<pkg>/R/` directory (a package whose `DESCRIPTION` discovery missed or
 *    that has none; root-level packages are found through `cfg` only);
 *  - `external`: not local, and `cfg` exists and its discovery was complete
 *    (`!cfg.truncated`), so `pkg` provably is not part of the repo;
 *  - `unknown`: not found, but discovery was truncated or no config could be
 *    built, so `pkg` may still be a local package that was not seen.
 *
 * One predicate, so the populate step and the veto cannot disagree on "local".
 */
export function rQualifierLocality(
  pkg: string,
  cfg: RPackageConfig | null | undefined,
  parsedFilePaths: ReadonlySet<string>,
): RQualifierLocality {
  if (cfg?.packages.has(pkg) === true) return 'local';
  for (const filePath of parsedFilePaths) {
    if (isUnderPackageRDir(pkg, filePath)) return 'local';
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
 * Per name, every top-level function/class definition (one entry per binding
 * ref, so a same-file redefinition counts twice) of the given package files.
 * Read from Module-scope `local` bindings at extraction time, like
 * `rFileTopLevel`, but keeping the definitions rather than the names.
 */
function collectTopLevelDefinitions(files: readonly ParsedFile[]): Map<string, SymbolDefinition[]> {
  const byName = new Map<string, SymbolDefinition[]>();
  for (const parsed of files) {
    const moduleScope = parsed.scopes.find((s) => s.id === parsed.moduleScope);
    if (moduleScope === undefined) continue;
    for (const [name, refs] of moduleScope.bindings) {
      for (const ref of refs) {
        if (ref.origin !== 'local' || !TOP_LEVEL_BINDABLE_TYPES.has(ref.def.type)) continue;
        const list = byName.get(name);
        if (list === undefined) byName.set(name, [ref.def]);
        else list.push(ref.def);
      }
    }
  }
  return byName;
}

/**
 * Decide every qualified call site of `parsedFiles` as described in the file
 * header: drop external and duplicate-definition sites (in place, through
 * frozen `ParsedFile` copies), record the precise target of single-definition
 * sites, leave every other site untouched. Resets all module state first, so a
 * run never sees the previous run's answers.
 */
export function populateRQualifiedCalls(
  parsedFiles: ParsedFile[],
  ctx: { readonly resolutionConfig?: unknown },
): void {
  preciseBySite = new Map();
  const cfg = (ctx.resolutionConfig as RPackageConfig | null | undefined) ?? null;
  if (cfg !== null) rRecordQualifiedDefinitionCounts(cfg, new Map());

  // Packages named by some qualified call, and how local each one is.
  let filePaths: Set<string> | undefined;
  const localityByPackage = new Map<string, RQualifierLocality>();
  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (!isQualifiedCall(site)) continue;
      const pkg = parseRQualifier(site.rawQualifiedName);
      if (pkg === undefined || localityByPackage.has(pkg)) continue;
      filePaths ??= new Set(parsedFiles.map((p) => p.filePath));
      localityByPackage.set(pkg, rQualifierLocality(pkg, cfg, filePaths));
    }
  }
  if (localityByPackage.size === 0) return;

  // Top-level definitions of each named local package, by name.
  const localPackages = [...localityByPackage].filter(([, l]) => l === 'local').map(([p]) => p);
  const definitions = new Map<string, Map<string, SymbolDefinition[]>>();
  if (localPackages.length > 0) {
    const filesByPackage = localPackages.map((pkg) => ({ pkg, files: [] as ParsedFile[] }));
    for (const parsed of parsedFiles) {
      const owner = rPackageDirForFile(parsed.filePath, cfg)?.name;
      for (const { pkg, files } of filesByPackage) {
        // In the config a package owns its `R/` files (longest-dir wins); otherwise
        // it is local only through the `<pkg>/R/` path, as `rQualifierLocality` decided.
        const inPackage =
          cfg?.packages.has(pkg) === true
            ? owner === pkg
            : isUnderPackageRDir(pkg, parsed.filePath);
        if (inPackage) files.push(parsed);
      }
    }
    for (const { pkg, files } of filesByPackage) {
      definitions.set(pkg, collectTopLevelDefinitions(files));
    }
    if (cfg !== null) {
      rRecordQualifiedDefinitionCounts(
        cfg,
        new Map(
          [...definitions].map(([pkg, byName]) => [
            pkg,
            new Map([...byName].map(([name, defs]) => [name, defs.length])),
          ]),
        ),
      );
    }
  }

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
      const locality = pkg === undefined ? 'unknown' : localityByPackage.get(pkg);
      if (locality === 'external') continue;
      if (locality === 'local' && pkg !== undefined) {
        const found = definitions.get(pkg)?.get(site.name) ?? [];
        if (found.length >= 2) continue;
        if (found.length === 1) preciseBySite.set(siteKey(parsed.filePath, site.atRange), found[0]);
      }
      kept.push(site);
    }
    if (kept.length !== parsed.referenceSites.length) {
      parsedFiles[i] = Object.freeze({ ...parsed, referenceSites: Object.freeze(kept) });
    }
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
