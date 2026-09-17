/**
 * Swift same-module (SPM target) implicit visibility for the
 * `populateNamespaceSiblings` hook.
 *
 * Swift gives every file in a module access to every other file's
 * top-level declarations WITHOUT any `import` statement (whole-module
 * visibility). This is the Swift analogue of Go's same-package sibling
 * visibility — `populateGoPackageSiblings` is the template.
 *
 * Module identity: Swift has no in-source `package X` marker. The SPM
 * target is a directory subtree (`Sources/<Target>/…`). Module membership
 * is threaded in via the SPM target map (`ctx.resolutionConfig` →
 * `coerceSwiftTargets`) and grouped by `groupSwiftFilesBySpmTarget`,
 * replicating legacy `wireSwiftImplicitImports`'s `groupSwiftFilesByTarget`:
 * files are grouped by SPM target subtree when a package config is present,
 * else ALL Swift files form one module (`__default__`,
 * single-Xcode-project assumption). Every `.swift` file in the same target
 * sees its siblings' top-level defs.
 *
 * Bindings are added through the append-only `bindingAugmentations`
 * channel (Contract Invariant I8) with `origin: 'namespace'`, exactly
 * like the Go implementation — `indexes.bindings` is frozen post-
 * finalize and must not be mutated.
 */

import type { BindingRef, ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { coerceSwiftTargets, groupSwiftFilesBySpmTarget } from './target-grouping.js';

export function populateSwiftTargetSiblings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly resolutionConfig?: unknown;
  },
): void {
  // Group files by SPM target subtree (the module). No-source-dir → all
  // files in one `__default__` bucket.
  const targets = coerceSwiftTargets(ctx.resolutionConfig);
  const filesByTarget = groupSwiftFilesBySpmTarget(
    parsedFiles,
    (parsed) => parsed.filePath,
    targets,
  );

  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;

  for (const [, group] of filesByTarget) {
    populateNestedTypeFragments(group, indexes, augmentations);
    if (group.length < 2) continue; // no file siblings to share
    const siblings = group.map((parsed) => ({
      filePath: parsed.filePath,
      defs: [...parsed.localDefs] as SymbolDefinition[],
    }));
    for (const target of siblings) {
      for (const receiver of siblings) {
        if (receiver.filePath === target.filePath) continue; // no self-reference
        const receiverModule = indexes.moduleScopes.byFilePath.get(receiver.filePath);
        if (receiverModule === undefined) continue;

        for (const def of target.defs) {
          const name = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
          if (name === '') continue;
          const bucket = getAugmentationBucket(augmentations, receiverModule, name);
          if (bucket.some((b) => b.def.nodeId === def.nodeId)) continue;
          bucket.push({ def, origin: 'namespace' });
        }
      }
    }
  }
}

/**
 * A Swift extension is a second lexical fragment of its extended type. Make
 * nested types declared by the primary fragment visible from every same-target
 * fragment with the same logical owner. Keeping this on class scopes preserves
 * lexical precedence when an unrelated top-level type has the same simple name.
 */
function populateNestedTypeFragments(
  group: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  augmentations: Map<ScopeId, Map<string, BindingRef[]>>,
): void {
  const scopesByOwner = new Map<string, ScopeId[]>();
  for (const parsed of group) {
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      const key = scopeOwnerKey(scope);
      if (key === undefined) continue;
      const scopes = scopesByOwner.get(key) ?? [];
      if (!scopesByOwner.has(key)) scopesByOwner.set(key, scopes);
      scopes.push(scope.id);
    }
  }

  for (const parsed of group) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type) || def.ownerId === undefined) continue;
      const owner = indexes.defs.byId.get(def.ownerId);
      if (owner === undefined) continue;
      const targetScopes = scopesByOwner.get(logicalOwnerKey(owner));
      if (targetScopes === undefined) continue;
      const name = simpleName(def);
      if (name === '') continue;
      for (const scopeId of targetScopes) {
        const bucket = getAugmentationBucket(augmentations, scopeId, name);
        if (bucket.some((binding) => binding.def.nodeId === def.nodeId)) continue;
        bucket.push({ def, origin: 'namespace' });
      }
    }
  }
}

function scopeOwnerKey(scope: Scope): string | undefined {
  const owner = scope.ownedDefs.find((def) => isClassLike(def.type));
  if (owner !== undefined) return logicalOwnerKey(owner);

  // Extension scopes carry no synthetic class def. Their locally bound
  // members are already qualified with the extended type (`Container.f`).
  let inferredOwner: string | undefined;
  for (const refs of scope.bindings.values()) {
    for (const { def } of refs) {
      const qualifiedName = def.qualifiedName;
      if (qualifiedName === undefined) continue;
      const separator = qualifiedName.lastIndexOf('.');
      if (separator <= 0) continue;
      const candidate = logicalOwnerKey({
        ...def,
        qualifiedName: qualifiedName.slice(0, separator),
      });
      if (inferredOwner !== undefined && inferredOwner !== candidate) return undefined;
      inferredOwner = candidate;
    }
  }
  return inferredOwner;
}

function logicalOwnerKey(def: SymbolDefinition): string {
  const qualifiedName = def.qualifiedName ?? def.nodeId;
  const namespacePrefix = def.namespacePrefix ?? '';
  return `${namespacePrefix.length}:${namespacePrefix}:${qualifiedName}`;
}

function simpleName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
}

function getAugmentationBucket(
  augmentations: Map<ScopeId, Map<string, BindingRef[]>>,
  scopeId: ScopeId,
  name: string,
): BindingRef[] {
  let scopeBindings = augmentations.get(scopeId);
  if (scopeBindings === undefined) {
    scopeBindings = new Map<string, BindingRef[]>();
    augmentations.set(scopeId, scopeBindings);
  }
  let bucketArr = scopeBindings.get(name);
  if (bucketArr === undefined) {
    bucketArr = [];
    scopeBindings.set(name, bucketArr);
  }
  return bucketArr;
}
