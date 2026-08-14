/**
 * TypeScript / JavaScript module resolution (#2953).
 *
 * This is the algorithm `tsc` and Node actually run, in the order they run it.
 * It replaces `import-resolvers/utils.ts:suffixResolve` on the TS/JS/Vue path,
 * which answered a different question — "does any file in this repo have a path
 * ending in this specifier?" — and answered it by dropping leading segments
 * until something matched. That is why `@acme/telemetry/nest`, a registry
 * dependency, landed on the repo's only path ending in `nest/index.ts`.
 *
 * Every rule below resolves against something DECLARED: a real path, a
 * `tsconfig` mapping, or a `package.json` manifest. A specifier that matches
 * none of them is external, and external resolves to nothing. There is
 * deliberately no fallback: a guess is what this module exists to remove, and
 * an edge nobody declared is worse than a missing one precisely because it
 * cannot be told apart from a real one downstream.
 *
 * ## The order, and why it is this order
 *
 *   1. relative / absolute — a path is a path; nothing else can claim it.
 *   2. `#`-prefixed — package.json `imports`, which is scoped to the importing
 *      package and shadows everything else by design.
 *   3. tsconfig `paths` — explicit mappings win over `baseUrl`, and the LONGEST
 *      matching pattern wins among them (tsc's rule, not first-declared).
 *   4. tsconfig `baseUrl` — the rule that makes `import 'src/utils/foo'` legal.
 *      Note it applies only when a config actually declares one; without it,
 *      TypeScript treats a non-relative specifier as a package lookup, and so
 *      does this module.
 *   5. workspace package — the manifest map, resolved through that package's
 *      own `exports` / `main` / `module` / `types`.
 *   6. anything else — external. `null`.
 */

import type { NodeWorkspacePackages } from '../../import-resolvers/node-workspace-packages.js';
import {
  matchSubpathMap,
  nodePackageNameOf,
  owningPackage,
  resolveNodeWorkspaceImport,
  substituteStar,
} from '../../import-resolvers/node-workspace-packages.js';
import { resolveFile } from './file-candidates.js';
import { tsconfigFor, type TsconfigIndex, type TsPathMapping } from './tsconfig.js';

export interface TsModuleResolutionContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
  readonly tsconfigs: TsconfigIndex | null;
  readonly workspacePackages: NodeWorkspacePackages | null;
}

/**
 * Resolve one specifier to a repo file, or `null` when nothing in the repo
 * declares it.
 */
export function resolveTsModule(specifier: string, ctx: TsModuleResolutionContext): string | null {
  if (specifier === '') return null;

  // 1. A path specifier.
  if (specifier.startsWith('.')) {
    const joined = joinFrom(ctx.fromFile, specifier);
    return joined === null ? null : resolveFile(joined, ctx.allFilePaths);
  }
  if (specifier.startsWith('/')) {
    return resolveFile(specifier.slice(1), ctx.allFilePaths);
  }

  // 2. Package-internal `#imports`. Scoped to the importing package, so it is
  //    looked up there and nowhere else — a `#` specifier that the package does
  //    not declare is an error in Node, not a repo-wide search.
  if (specifier.startsWith('#')) {
    return resolveSubpathImport(specifier, ctx);
  }

  const config = tsconfigFor(ctx.tsconfigs, ctx.fromFile);

  // 3. `paths`, longest matching pattern first.
  if (config !== null && config.paths.length > 0) {
    const viaPaths = resolveViaPaths(specifier, config.paths, ctx.allFilePaths);
    if (viaPaths !== null) return viaPaths;
  }

  // 4. `baseUrl`.
  if (config !== null && config.baseUrl !== null) {
    const viaBaseUrl = resolveFile(joinRepo(config.baseUrl, specifier), ctx.allFilePaths);
    if (viaBaseUrl !== null) return viaBaseUrl;
  }

  // 5. A package that lives in this repo.
  const viaWorkspace = resolveNodeWorkspaceImport(
    specifier,
    ctx.workspacePackages,
    ctx.allFilePaths,
  );
  if (viaWorkspace !== null) return viaWorkspace;

  // 6. External. Nothing in the repo declared it, so it resolves to nothing —
  //    which for a registry dependency is the correct and complete answer.
  return null;
}

/**
 * Apply `paths` the way tsc does: the pattern with the longest literal prefix
 * before `*` wins, and its targets are tried in declaration order.
 *
 * The old loader kept `targets[0]` and treated the pattern as a plain prefix,
 * which silently mis-resolves the common `"@/*": ["./src/*", "./generated/*"]`
 * shape — the second target is where half of a generated-code monorepo lives.
 */
function resolveViaPaths(
  specifier: string,
  paths: readonly TsPathMapping[],
  allFiles: ReadonlySet<string>,
): string | null {
  const matches: { mapping: TsPathMapping; stem: string | null; prefixLength: number }[] = [];

  for (const mapping of paths) {
    const star = mapping.pattern.indexOf('*');
    if (star === -1) {
      if (mapping.pattern === specifier) {
        matches.push({ mapping, stem: null, prefixLength: mapping.pattern.length });
      }
      continue;
    }
    const prefix = mapping.pattern.slice(0, star);
    const suffix = mapping.pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (specifier.length < prefix.length + suffix.length) continue;
    matches.push({
      mapping,
      stem: specifier.slice(prefix.length, specifier.length - suffix.length),
      prefixLength: prefix.length,
    });
  }

  // An exact (starless) pattern outranks any wildcard, THEN longer prefix wins.
  // Sorting on prefix length alone left that first rule to luck: `a` and `a*`
  // both match `a` with prefix length 1, so whichever was declared first won.
  matches.sort(
    (a, b) => Number(a.stem !== null) - Number(b.stem !== null) || b.prefixLength - a.prefixLength,
  );

  for (const match of matches) {
    for (const target of match.mapping.targets) {
      const candidate = match.stem === null ? target : substituteStar(target, match.stem);
      const resolved = resolveFile(candidate, allFiles);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

/** Resolve `#name` against the importing file's own package manifest. */
function resolveSubpathImport(specifier: string, ctx: TsModuleResolutionContext): string | null {
  const packages = ctx.workspacePackages;
  if (packages === null) return null;
  const owner = owningPackage(ctx.fromFile, packages);
  if (owner === null) return null;
  // `imports` takes pattern keys (`"#internal/*"`) exactly like `exports`, so
  // it gets the same matcher rather than an exact lookup.
  for (const stem of matchSubpathMap(owner.subpathImports, specifier) ?? []) {
    const resolved = resolveFile(stem, ctx.allFilePaths);
    if (resolved !== null) return resolved;
  }
  return null;
}

/**
 * Resolve a relative specifier against the importing file's directory, or
 * `null` when it climbs out of the repository.
 *
 * Popping an empty segment list would silently CLAMP at the root, so
 * `../../../secret` from `src/main.ts` became `secret` and could resolve a
 * repo-root file the specifier never named. Outside the repo there is nothing
 * indexed to resolve to, so the honest answer is nothing.
 */
function joinFrom(fromFile: string, specifier: string): string | null {
  const segments = fromFile.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join('/');
}

function joinRepo(dir: string, rest: string): string {
  return dir === '' ? rest : `${dir}/${rest}`;
}

/** Whether a specifier names a package rather than a path — used by callers
 *  that want to report an unresolved import as external rather than missing. */
export function isPackageSpecifier(specifier: string): boolean {
  return nodePackageNameOf(specifier) !== null;
}
