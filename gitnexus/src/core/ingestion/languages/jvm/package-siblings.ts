import type {
  BindingRef,
  ParsedFile,
  ReferenceSite,
  ScopeId,
  SymbolDefinition,
  TypeRef,
} from 'gitnexus-shared';
import { logger } from '../../../logger.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  isClassLike,
  resolveSameNamespaceInheritanceBase,
} from '../../scope-resolution/scope/walkers.js';
import type { JvmPackageFact } from './package-facts.js';
import { isJvmSourceVisible } from './source-visibility.js';

/** Packages larger than this get no implicit sibling visibility at all — every
 *  file in them is marked incomplete. `GITNEXUS_MAX_INJECTED_SIBLINGS` bounds
 *  injection *within* a package and does not lift this skip. */
const MAX_PACKAGE_FILES = 500;

const DEFAULT_MAX_INJECTED_SIBLINGS = 200;

function getMaxInjectedSiblings(): number {
  const raw = process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_INJECTED_SIBLINGS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_INJECTED_SIBLINGS;
}

export interface JvmPackageSiblingOptions {
  readonly languageLabel: string;
  readonly getPackageFact: (filePath: string) => JvmPackageFact | undefined;
  /**
   * Copy every sibling's module and non-self class type bindings into each
   * file's module scope (default `true`). That copy costs files x siblings x
   * bindings per package. A language that types inherited members through the
   * superclass chain instead sets `false`; sibling class bindings are injected
   * either way.
   */
  readonly mergeSiblingTypeBindings?: boolean;
  /** Also make top-level functions visible to the package's other files. */
  readonly includeTopLevelFunctions?: boolean;
}

export interface JvmPackageSiblingVisibility {
  readonly populateNamespaceSiblings: (
    parsedFiles: readonly ParsedFile[],
    indexes: ScopeResolutionIndexes,
    ctx: {
      readonly fileContents: ReadonlyMap<string, string>;
    },
  ) => void;
  readonly isVisibilityIncomplete: (filePath: string) => boolean;
  /**
   * Whether a top-level type named `simpleName` is declared anywhere in this
   * file's package, this file included. Built from every package member, so
   * the injection cap and the large-package skip above do not hide a name.
   * `undefined` when a workspace file has no reliable package, because such a
   * file may declare that name in any package.
   */
  readonly hasSamePackageType: (filePath: string, simpleName: string) => boolean | undefined;
  /** `ScopeResolver.resolveImplicitInheritanceBase`: an unqualified base bound
   *  by the same-package rule, which the sibling bindings above only provide
   *  after the inheritance pre-pass has run. */
  readonly resolveImplicitInheritanceBase: (
    baseName: string,
    derivingClass: SymbolDefinition,
    scopes: ScopeResolutionIndexes,
    site?: ReferenceSite,
  ) => SymbolDefinition | undefined;
}

interface PackageBucket {
  readonly parsed: ParsedFile[];
  readonly moduleScopes: { filePath: string; scope: ParsedFile['scopes'][number] }[];
}

interface SiblingCandidate {
  readonly def: BindingRef['def'];
  readonly filePath: string;
}

interface DirectoryRanking {
  /** Every package candidate, nearest-first for a file in this directory. Own
   *  file entries are included; the caller skips them. */
  readonly ordered: readonly SiblingCandidate[];
  /** Candidates that share the whole directory and continue past it, keyed by
   *  the segment right after the directory. */
  readonly pathsByNextSegment: ReadonlyMap<string, ReadonlySet<string>>;
}

interface SiblingTypeBinding {
  readonly name: string;
  readonly ref: TypeRef;
}

interface SiblingTypeBindingIndex {
  /** The untruncated merge: every other sibling's module bindings, then every
   *  other sibling's non-self class bindings, in path order; a name keeps the
   *  first binding it meets. */
  readonly mergeAll: (filePath: string, typeBindings: Map<string, TypeRef>) => void;
  /** Record bindings a merge outside the index appended past `sizeBefore`. */
  readonly recordAppended: (
    filePath: string,
    typeBindings: ReadonlyMap<string, TypeRef>,
    sizeBefore: number,
  ) => void;
}

export function createJvmPackageSiblingVisibility(
  options: JvmPackageSiblingOptions,
): JvmPackageSiblingVisibility {
  const incompleteFiles = new Set<string>();
  const packageOfFile = new Map<string, string>();
  const typeNamesByPackage = new Map<string, Set<string>>();
  let packageFactsUnknown = false;

  function populateNamespaceSiblings(
    parsedFiles: readonly ParsedFile[],
    indexes: ScopeResolutionIndexes,
    ctx: {
      readonly fileContents: ReadonlyMap<string, string>;
    },
  ): void {
    incompleteFiles.clear();
    packageOfFile.clear();
    typeNamesByPackage.clear();
    const buckets = new Map<string, PackageBucket>();
    const unknownPackageFiles = new Set<string>();
    const parsedPaths = new Set(parsedFiles.map((parsed) => parsed.filePath));

    // A file that failed scope extraction has no ParsedFile or side-channel,
    // but it may still declare a shadowing type in any package. Keep its source
    // path in the uncertainty set without re-parsing it on the main thread.
    for (const filePath of ctx.fileContents.keys()) {
      if (!parsedPaths.has(filePath)) unknownPackageFiles.add(filePath);
    }

    for (const parsed of parsedFiles) {
      const packageFact = options.getPackageFact(parsed.filePath);
      if (!ctx.fileContents.has(parsed.filePath) || packageFact?.status !== 'known') {
        incompleteFiles.add(parsed.filePath);
        unknownPackageFiles.add(parsed.filePath);
        continue;
      }
      const packageName = packageFact.packageName;
      const bucket = buckets.get(packageName) ?? { parsed: [], moduleScopes: [] };
      buckets.set(packageName, bucket);
      bucket.parsed.push(parsed);
      const moduleScope = parsed.scopes.find((scope) => scope.kind === 'Module');
      if (moduleScope !== undefined) {
        bucket.moduleScopes.push({ filePath: parsed.filePath, scope: moduleScope });
      }
      packageOfFile.set(parsed.filePath, packageName);
      let names = typeNamesByPackage.get(packageName);
      if (names === undefined) typeNamesByPackage.set(packageName, (names = new Set()));
      for (const scope of parsed.scopes) {
        if (scope.kind !== 'Class' || scope.parent !== moduleScope?.id) continue;
        const def = scope.ownedDefs.find(
          (candidate) => isClassLike(candidate.type) || candidate.type === 'Annotation',
        );
        const spelling = def === undefined ? undefined : (def.qualifiedName ?? def.nodeId);
        if (spelling !== undefined)
          names.add(
            spelling.slice(Math.max(spelling.lastIndexOf('.'), spelling.lastIndexOf(':')) + 1),
          );
      }
    }
    packageFactsUnknown = unknownPackageFiles.size > 0;

    // A file whose package cannot be proven may shadow a wildcard-imported
    // type in any package. Conservatively disable wildcard attribution for the
    // language workspace while leaving explicit/FQN imports available.
    if (unknownPackageFiles.size > 0) {
      for (const parsed of parsedFiles) incompleteFiles.add(parsed.filePath);
      logger.warn(
        `[${options.languageLabel}-package-siblings] ${unknownPackageFiles.size} file(s) lacked reliable package facts; wildcard attribution disabled for this language workspace`,
      );
    }

    const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;
    const maxInjectedSiblings = getMaxInjectedSiblings();
    const mergeTypeBindings = options.mergeSiblingTypeBindings !== false;
    let truncatedFiles = 0;

    for (const bucket of buckets.values()) {
      if (bucket.moduleScopes.length < 2) continue;
      if (bucket.moduleScopes.length > MAX_PACKAGE_FILES) {
        for (const parsed of bucket.parsed) incompleteFiles.add(parsed.filePath);
        logger.warn(
          `[${options.languageLabel}-package-siblings] skipping package with ${bucket.moduleScopes.length} files (cap=${MAX_PACKAGE_FILES}); same-package implicit visibility disabled for this package`,
        );
        continue;
      }

      const classDefs: SiblingCandidate[] = [];
      for (const parsed of bucket.parsed) {
        const moduleScopeId = parsed.scopes.find((scope) => scope.kind === 'Module')?.id;
        for (const scope of parsed.scopes) {
          if (scope.kind !== 'Class' || scope.parent !== moduleScopeId) continue;
          const def = scope.ownedDefs.find(
            (candidate) => isClassLike(candidate.type) || candidate.type === 'Annotation',
          );
          if (def !== undefined) classDefs.push({ def, filePath: parsed.filePath });
        }
        if (options.includeTopLevelFunctions === true) {
          const moduleScope = parsed.scopes.find((scope) => scope.id === moduleScopeId);
          for (const refs of moduleScope?.bindings.values() ?? []) {
            for (const { def, origin } of refs) {
              if (origin === 'local' && def.type === 'Function' && def.filePath === parsed.filePath)
                classDefs.push({ def, filePath: parsed.filePath });
            }
          }
        }
      }

      // Per-bucket lookups: the per-file loop below is O(files²) over these,
      // so split each path into segments once here instead of re-splitting it
      // on every pairwise proximity comparison, and address siblings by path
      // so a truncated scope can merge its bounded set without rescanning the
      // whole package.
      const segmentsByPath = new Map<string, string[]>();
      const moduleScopeByPath = new Map<string, PackageBucket['moduleScopes'][number]>();
      const parsedByPath = new Map<string, ParsedFile>();
      for (const parsed of bucket.parsed) {
        segmentsByPath.set(parsed.filePath, pathSegments(parsed.filePath));
        parsedByPath.set(parsed.filePath, parsed);
      }
      for (const sibling of bucket.moduleScopes) moduleScopeByPath.set(sibling.filePath, sibling);
      const allSiblingPaths = [...parsedByPath.keys()];
      // The index addresses siblings by path and records appends per module
      // map, so it needs one file per path and one map per module scope.
      const bindingIndex =
        mergeTypeBindings &&
        allSiblingPaths.length === bucket.parsed.length &&
        new Set(bucket.moduleScopes.map((sibling) => sibling.scope.typeBindings)).size ===
          bucket.moduleScopes.length
          ? createSiblingTypeBindingIndex(allSiblingPaths, moduleScopeByPath, parsedByPath)
          : undefined;
      // Proximity depends only on the two paths, so files sharing a directory
      // share one ranking; rank once per directory instead of once per file.
      const rankingByDirectory = new Map<string, DirectoryRanking>();

      for (const { filePath, scope } of bucket.moduleScopes) {
        let scopeAug = augmentations.get(scope.id);
        if (scopeAug === undefined) {
          scopeAug = new Map();
          augmentations.set(scope.id, scopeAug);
        }

        const ownSegments = segmentsByPath.get(filePath) ?? pathSegments(filePath);
        const dirSegments = ownSegments.slice(0, -1);
        const dirKey = `${dirSegments.length}:${dirSegments.join('/')}`;
        let ranking = rankingByDirectory.get(dirKey);
        if (ranking === undefined) {
          ranking = rankForDirectory(classDefs, dirSegments, segmentsByPath);
          rankingByDirectory.set(dirKey, ranking);
        }
        // Nearest-first by shared path prefix. Ties (the common case in a flat
        // package, where every sibling shares the same directory) keep the
        // walker's traversal order, so the retained set is deterministic but
        // arbitrary among equally-near candidates — which is why truncation
        // marks the file incomplete below rather than being treated as exact.
        // The directory ranking is exact for this file unless another path
        // continues past the directory with this file's own name (a directory
        // named like the file, or a path spelling that normalizes to it): that
        // candidate shares one more segment, so rank this file on its own.
        const sameNamePaths = ranking.pathsByNextSegment.get(ownSegments[ownSegments.length - 1]);
        const candidates =
          sameNamePaths !== undefined && (sameNamePaths.size > 1 || !sameNamePaths.has(filePath))
            ? rankByProximity(classDefs, filePath, ownSegments, segmentsByPath)
            : ranking.ordered;

        const injectedIds = new Set<string>();
        const injectedPaths = new Set<string>();
        let truncated = false;
        for (const { def, filePath: defPath } of candidates) {
          if (defPath === filePath) continue;
          if (injectedIds.has(def.nodeId) || def.qualifiedName === undefined) continue;
          if (maxInjectedSiblings > 0 && injectedIds.size >= maxInjectedSiblings) {
            truncated = true;
            break;
          }
          injectedIds.add(def.nodeId);
          injectedPaths.add(defPath);
          const simpleName = def.qualifiedName.includes('.')
            ? def.qualifiedName.slice(def.qualifiedName.lastIndexOf('.') + 1)
            : def.qualifiedName;
          const bindings = scopeAug.get(simpleName) ?? [];
          if (!scopeAug.has(simpleName)) scopeAug.set(simpleName, bindings);
          bindings.push({ def, origin: 'namespace' });
        }

        if (truncated) {
          // Sibling visibility for this file is now partial, and downstream
          // Spring attribution treats a complete flag as "this package's names
          // are fully known". Marking it incomplete keeps wildcard attribution
          // conservative instead of silently resolving against a truncated set.
          incompleteFiles.add(filePath);
          truncatedFiles++;
        }

        // The language opted out of the type-binding copy (see the option).
        if (!mergeTypeBindings) continue;

        // Keep the two halves of "what this file can see" in agreement: when
        // the cap truncated the binding set, merge type bindings from the same
        // bounded sibling set only — and iterate that set directly, so the cap
        // bounds the merge work too instead of just filtering a full scan. An
        // untruncated scope merges every sibling as before, including ones that
        // contribute no class-like def.
        const typeBindings = scope.typeBindings as Map<string, TypeRef>;
        if (!truncated && bindingIndex !== undefined) {
          bindingIndex.mergeAll(filePath, typeBindings);
          continue;
        }
        const sizeBefore = typeBindings.size;
        const mergePaths = truncated ? injectedPaths : allSiblingPaths;
        // Module scopes first, then class scopes: module-level bindings win on
        // a name collision, which the two-pass order (not file order) encodes.
        for (const siblingPath of mergePaths) {
          if (siblingPath === filePath) continue;
          const sibling = moduleScopeByPath.get(siblingPath);
          if (sibling === undefined) continue;
          for (const [name, ref] of sibling.scope.typeBindings) {
            if (!typeBindings.has(name)) typeBindings.set(name, ref);
          }
        }
        for (const siblingPath of mergePaths) {
          if (siblingPath === filePath) continue;
          const sibling = parsedByPath.get(siblingPath);
          if (sibling === undefined) continue;
          for (const siblingScope of sibling.scopes) {
            if (siblingScope.kind !== 'Class') continue;
            for (const [name, ref] of siblingScope.typeBindings) {
              if (ref.source !== 'self' && !typeBindings.has(name)) typeBindings.set(name, ref);
            }
          }
        }
        bindingIndex?.recordAppended(filePath, typeBindings, sizeBefore);
      }
    }

    if (truncatedFiles > 0) {
      logger.warn(
        `[${options.languageLabel}-package-siblings] sibling injection truncated at ${maxInjectedSiblings} per file for ${truncatedFiles} file(s); wildcard attribution disabled for those files (raise or unset GITNEXUS_MAX_INJECTED_SIBLINGS to widen, 0 for unbounded)`,
      );
    }
  }

  // A file whose package is unknown matches nothing, so it can neither claim a
  // base nor be offered one. Top-level types only: `qualifiedNames` keys a
  // nested type by its dotted `Outer.Inner` path, never by the bare name.
  const packageOf = (def: SymbolDefinition): string | undefined => {
    const fact = options.getPackageFact(def.filePath);
    return fact?.status === 'known' ? fact.packageName : undefined;
  };

  // Scope indexes are immutable for this inheritance pass. Hydrate each file's
  // module children once; local and nested classes are not package siblings.
  const topLevelIds = new WeakMap<ScopeResolutionIndexes, Map<string, ReadonlySet<string>>>();
  const isPackageClass = (def: SymbolDefinition, scopes: ScopeResolutionIndexes): boolean => {
    let files = topLevelIds.get(scopes);
    if (files === undefined) topLevelIds.set(scopes, (files = new Map()));
    let ids = files.get(def.filePath);
    if (ids === undefined) {
      const found = new Set<string>();
      const module = scopes.moduleScopes.get(def.filePath);
      if (module !== undefined) {
        for (const childId of scopes.scopeTree.getChildren(module)) {
          const child = scopes.scopeTree.getScope(childId);
          if (child?.kind !== 'Class') continue;
          for (const candidate of child.ownedDefs) {
            if (isClassLike(candidate.type) || candidate.type === 'Annotation')
              found.add(candidate.nodeId);
          }
        }
      }
      files.set(def.filePath, (ids = found));
    }
    return ids.has(def.nodeId);
  };

  // The pre-MRO pass cannot rule out an inherited member type in an
  // enclosing class. Refuse the package fallback until that higher-priority
  // lookup is known, rather than manufacturing an unrelated package edge.
  const heritageScopes = new WeakMap<ScopeResolutionIndexes, ReadonlySet<ScopeId>>();
  const hasInheritedEnclosingClass = (site: ReferenceSite, scopes: ScopeResolutionIndexes) => {
    let inherited = heritageScopes.get(scopes);
    if (inherited === undefined) {
      inherited = new Set(
        scopes.referenceSites.filter((ref) => ref.kind === 'inherits').map((ref) => ref.inScope),
      );
      heritageScopes.set(scopes, inherited);
    }
    let cursor = scopes.scopeTree.getScope(site.inScope)?.parent ?? null;
    while (cursor !== null) {
      const scope = scopes.scopeTree.getScope(cursor);
      if (scope?.kind === 'Class' && inherited.has(cursor)) return true;
      cursor = scope?.parent ?? null;
    }
    return false;
  };

  return {
    populateNamespaceSiblings,
    isVisibilityIncomplete: (filePath) => incompleteFiles.has(filePath),
    hasSamePackageType: (filePath, simpleName) => {
      const packageName = packageOfFile.get(filePath);
      if (packageFactsUnknown || packageName === undefined) return undefined;
      return typeNamesByPackage.get(packageName)?.has(simpleName) === true;
    },
    resolveImplicitInheritanceBase: (baseName, derivingClass, scopes, site) => {
      // An explicit typealias/non-class import can resolve without producing a
      // class binding. Its claim still takes precedence over package siblings.
      const moduleScope = scopes.moduleScopes.get(derivingClass.filePath);
      if (
        moduleScope !== undefined &&
        scopes.imports.edgesAt(moduleScope)?.some((edge) => edge.localName === baseName)
      )
        return undefined;
      if (site !== undefined && hasInheritedEnclosingClass(site, scopes)) return undefined;
      return resolveSameNamespaceInheritanceBase(
        baseName,
        derivingClass,
        scopes,
        packageOf,
        (def) =>
          isPackageClass(def, scopes) &&
          isJvmSourceVisible(derivingClass.filePath, def.filePath) &&
          // Omitted arguments may be raw or constructor-inferred. Explicit
          // arguments must match before proximity ranks same-package bases.
          (site?.typeArguments === undefined ||
            site.typeArguments.length === 0 ||
            (def.typeParameters?.length ?? 0) === site.typeArguments.length),
      );
    },
  };
}

function pathSegments(filePath: string): string[] {
  return filePath.replace(/\\/g, '/').split('/');
}

/**
 * Rank `candidates` for any file directly inside `dirSegments`. A candidate
 * that shares the whole directory scores at least the directory depth against
 * every such file; the rest score below it, and that score does not depend on
 * the file name. So the full-directory candidates come first in walker order
 * and the rest follow, stably sorted by shared prefix. The one exception, a
 * candidate continuing past the directory with the file's own name, is
 * surfaced through `pathsByNextSegment` for the caller to rank exactly.
 */
function rankForDirectory(
  candidates: readonly SiblingCandidate[],
  dirSegments: readonly string[],
  segmentsByPath: ReadonlyMap<string, readonly string[]>,
): DirectoryRanking {
  const depth = dirSegments.length;
  const ordered: SiblingCandidate[] = [];
  const farther: { candidate: SiblingCandidate; shared: number }[] = [];
  const pathsByNextSegment = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const segments = segmentsByPath.get(candidate.filePath) ?? [];
    const shared = sharedSegmentCount(segments, dirSegments);
    if (shared < depth) {
      farther.push({ candidate, shared });
      continue;
    }
    ordered.push(candidate);
    if (segments.length > depth) {
      const next = segments[depth];
      let paths = pathsByNextSegment.get(next);
      if (paths === undefined) pathsByNextSegment.set(next, (paths = new Set()));
      paths.add(candidate.filePath);
    }
  }
  farther.sort((a, b) => b.shared - a.shared);
  for (const { candidate } of farther) ordered.push(candidate);
  return { ordered, pathsByNextSegment };
}

/** Exact per-file nearest-first ranking, for the rare file a directory
 *  ranking cannot serve. */
function rankByProximity(
  classDefs: readonly SiblingCandidate[],
  filePath: string,
  ownSegments: readonly string[],
  segmentsByPath: ReadonlyMap<string, readonly string[]>,
): SiblingCandidate[] {
  const proximityCache = new Map<string, number>();
  const candidates = classDefs.filter((candidate) => candidate.filePath !== filePath);
  for (const candidate of candidates) {
    if (!proximityCache.has(candidate.filePath)) {
      proximityCache.set(
        candidate.filePath,
        sharedSegmentCount(segmentsByPath.get(candidate.filePath) ?? [], ownSegments),
      );
    }
  }
  candidates.sort(
    (a, b) => (proximityCache.get(b.filePath) ?? 0) - (proximityCache.get(a.filePath) ?? 0),
  );
  return candidates;
}

/**
 * The untruncated merge gives each name the binding of the first other sibling
 * that has it, so a merge only needs those first holders, in walk order: it
 * then costs the package's distinct names instead of every sibling's bindings.
 *
 * A class binding needs its first two holders, for a file that holds it
 * itself. A module binding needs only its first: the merge writes into the
 * file's own module map, so a file that holds a name already has it.
 *
 * Module maps are read live: each merge appends to its own file's map, and
 * later merges walk those appends. So every append is recorded here, after the
 * map's earlier entries. Maps only grow, so a sibling that a lower one has
 * overtaken for a name never supplies it again; its entry is dropped on the
 * next walk. Class bindings are never written, so their index is built once.
 */
function createSiblingTypeBindingIndex(
  siblingPaths: readonly string[],
  moduleScopeByPath: ReadonlyMap<string, PackageBucket['moduleScopes'][number]>,
  parsedByPath: ReadonlyMap<string, ParsedFile>,
): SiblingTypeBindingIndex {
  const indexByPath = new Map<string, number>();
  const firstModuleHolder = new Map<string, number>();
  const moduleBindings: SiblingTypeBinding[][] = [];
  const classBindings: SiblingTypeBinding[][] = [];
  const classHolderCount = new Map<string, number>();

  const holdModuleBinding = (index: number, name: string, ref: TypeRef): void => {
    const first = firstModuleHolder.get(name);
    if (first !== undefined && first < index) return;
    firstModuleHolder.set(name, index);
    moduleBindings[index].push({ name, ref });
  };

  siblingPaths.forEach((path, index) => {
    indexByPath.set(path, index);
    moduleBindings.push([]);
    for (const [name, ref] of moduleScopeByPath.get(path)?.scope.typeBindings ?? []) {
      holdModuleBinding(index, name, ref);
    }
    const ownClassBindings: SiblingTypeBinding[] = [];
    const seen = new Set<string>();
    for (const scope of parsedByPath.get(path)?.scopes ?? []) {
      if (scope.kind !== 'Class') continue;
      for (const [name, ref] of scope.typeBindings) {
        if (ref.source === 'self' || seen.has(name)) continue;
        seen.add(name);
        const count = classHolderCount.get(name) ?? 0;
        if (count === 2) continue;
        classHolderCount.set(name, count + 1);
        ownClassBindings.push({ name, ref });
      }
    }
    classBindings.push(ownClassBindings);
  });

  const recordAppends = (filePath: string, appended: readonly SiblingTypeBinding[]): void => {
    const own = indexByPath.get(filePath);
    if (own === undefined) return;
    for (const { name, ref } of appended) holdModuleBinding(own, name, ref);
  };

  return {
    mergeAll: (filePath, typeBindings) => {
      const own = indexByPath.get(filePath);
      const appended: SiblingTypeBinding[] = [];
      for (let index = 0; index < moduleBindings.length; index++) {
        if (index === own) continue;
        const bindings = moduleBindings[index];
        let kept = 0;
        for (const binding of bindings) {
          if (firstModuleHolder.get(binding.name) !== index) continue;
          bindings[kept++] = binding;
          if (typeBindings.has(binding.name)) continue;
          typeBindings.set(binding.name, binding.ref);
          appended.push(binding);
        }
        bindings.length = kept;
      }
      for (let index = 0; index < classBindings.length; index++) {
        if (index === own) continue;
        for (const binding of classBindings[index]) {
          if (typeBindings.has(binding.name)) continue;
          typeBindings.set(binding.name, binding.ref);
          appended.push(binding);
        }
      }
      recordAppends(filePath, appended);
    },
    recordAppended: (filePath, typeBindings, sizeBefore) => {
      const appended: SiblingTypeBinding[] = [];
      let position = 0;
      for (const [name, ref] of typeBindings) {
        if (position++ >= sizeBefore) appended.push({ name, ref });
      }
      recordAppends(filePath, appended);
    },
  };
}

function sharedSegmentCount(aSegments: readonly string[], bSegments: readonly string[]): number {
  let index = 0;
  while (
    index < aSegments.length &&
    index < bSegments.length &&
    aSegments[index] === bSegments[index]
  ) {
    index++;
  }
  return index;
}
