import type { BindingRef, ParsedFile, ScopeId, TypeRef } from 'gitnexus-shared';
import { logger } from '../../../logger.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import type { JvmPackageFact } from './package-facts.js';

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
}

interface PackageBucket {
  readonly parsed: ParsedFile[];
  readonly moduleScopes: { filePath: string; scope: ParsedFile['scopes'][number] }[];
}

export function createJvmPackageSiblingVisibility(
  options: JvmPackageSiblingOptions,
): JvmPackageSiblingVisibility {
  const incompleteFiles = new Set<string>();

  function populateNamespaceSiblings(
    parsedFiles: readonly ParsedFile[],
    indexes: ScopeResolutionIndexes,
    ctx: {
      readonly fileContents: ReadonlyMap<string, string>;
    },
  ): void {
    incompleteFiles.clear();
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
    }

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

      const classDefs: { def: BindingRef['def']; filePath: string }[] = [];
      for (const parsed of bucket.parsed) {
        const moduleScopeId = parsed.scopes.find((scope) => scope.kind === 'Module')?.id;
        for (const scope of parsed.scopes) {
          if (scope.kind !== 'Class' || scope.parent !== moduleScopeId) continue;
          const def = scope.ownedDefs.find((candidate) => isClassLike(candidate.type));
          if (def !== undefined) classDefs.push({ def, filePath: parsed.filePath });
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

      for (const { filePath, scope } of bucket.moduleScopes) {
        let scopeAug = augmentations.get(scope.id);
        if (scopeAug === undefined) {
          scopeAug = new Map();
          augmentations.set(scope.id, scopeAug);
        }

        const ownSegments = segmentsByPath.get(filePath) ?? pathSegments(filePath);
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
        // Nearest-first by shared path prefix. Ties (the common case in a flat
        // package, where every sibling shares the same directory) keep the
        // walker's traversal order, so the retained set is deterministic but
        // arbitrary among equally-near candidates — which is why truncation
        // marks the file incomplete below rather than being treated as exact.
        candidates.sort(
          (a, b) => (proximityCache.get(b.filePath) ?? 0) - (proximityCache.get(a.filePath) ?? 0),
        );

        const injectedIds = new Set<string>();
        const injectedPaths = new Set<string>();
        let truncated = false;
        for (const { def, filePath: defPath } of candidates) {
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

        // Keep the two halves of "what this file can see" in agreement: when
        // the cap truncated the binding set, merge type bindings from the same
        // bounded sibling set only — and iterate that set directly, so the cap
        // bounds the merge work too instead of just filtering a full scan. An
        // untruncated scope merges every sibling as before, including ones that
        // contribute no class-like def.
        const typeBindings = scope.typeBindings as Map<string, TypeRef>;
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
      }
    }

    if (truncatedFiles > 0) {
      logger.warn(
        `[${options.languageLabel}-package-siblings] sibling injection truncated at ${maxInjectedSiblings} per file for ${truncatedFiles} file(s); wildcard attribution disabled for those files (raise or unset GITNEXUS_MAX_INJECTED_SIBLINGS to widen, 0 for unbounded)`,
      );
    }
  }

  return {
    populateNamespaceSiblings,
    isVisibilityIncomplete: (filePath) => incompleteFiles.has(filePath),
  };
}

function pathSegments(filePath: string): string[] {
  return filePath.replace(/\\/g, '/').split('/');
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
