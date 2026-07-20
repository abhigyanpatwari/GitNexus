import type { BindingRef, ParsedFile, ScopeId, TypeRef } from 'gitnexus-shared';
import { logger } from '../../../logger.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import type { JvmPackageFact } from './package-facts.js';

const MAX_PACKAGE_FILES = 500;

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

      for (const { filePath, scope } of bucket.moduleScopes) {
        let scopeAug = augmentations.get(scope.id);
        if (scopeAug === undefined) {
          scopeAug = new Map();
          augmentations.set(scope.id, scopeAug);
        }

        const proximityCache = new Map<string, number>();
        const candidates = classDefs.filter((candidate) => candidate.filePath !== filePath);
        for (const candidate of candidates) {
          if (!proximityCache.has(candidate.filePath)) {
            proximityCache.set(
              candidate.filePath,
              sharedSegmentCount(candidate.filePath, filePath),
            );
          }
        }
        candidates.sort(
          (a, b) => (proximityCache.get(b.filePath) ?? 0) - (proximityCache.get(a.filePath) ?? 0),
        );

        const injectedIds = new Set<string>();
        for (const { def } of candidates) {
          if (injectedIds.has(def.nodeId) || def.qualifiedName === undefined) continue;
          injectedIds.add(def.nodeId);
          const simpleName = def.qualifiedName.includes('.')
            ? def.qualifiedName.slice(def.qualifiedName.lastIndexOf('.') + 1)
            : def.qualifiedName;
          const bindings = scopeAug.get(simpleName) ?? [];
          if (!scopeAug.has(simpleName)) scopeAug.set(simpleName, bindings);
          bindings.push({ def, origin: 'namespace' });
        }

        const typeBindings = scope.typeBindings as Map<string, TypeRef>;
        for (const sibling of bucket.moduleScopes) {
          if (sibling.filePath === filePath) continue;
          for (const [name, ref] of sibling.scope.typeBindings) {
            if (!typeBindings.has(name)) typeBindings.set(name, ref);
          }
        }
        for (const sibling of bucket.parsed) {
          if (sibling.filePath === filePath) continue;
          for (const siblingScope of sibling.scopes) {
            if (siblingScope.kind !== 'Class') continue;
            for (const [name, ref] of siblingScope.typeBindings) {
              if (ref.source !== 'self' && !typeBindings.has(name)) typeBindings.set(name, ref);
            }
          }
        }
      }
    }
  }

  return {
    populateNamespaceSiblings,
    isVisibilityIncomplete: (filePath) => incompleteFiles.has(filePath),
  };
}

function sharedSegmentCount(a: string, b: string): number {
  const aSegments = a.replace(/\\/g, '/').split('/');
  const bSegments = b.replace(/\\/g, '/').split('/');
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
