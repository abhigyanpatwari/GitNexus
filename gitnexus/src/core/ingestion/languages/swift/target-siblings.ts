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
 * target is a directory subtree (`Sources/<Target>/…`). The legacy
 * `wireSwiftImplicitImports` (in `languages/swift.ts`) groups files by
 * SPM target when a `Package.swift` config is present, else treats ALL
 * Swift files as one module (`__default__`, single-Xcode-project
 * assumption). The scope-resolution contract does not thread the SPM
 * config here, so we approximate module membership by the file's
 * immediate containing directory — every `.swift` file in the same
 * directory sees its siblings' top-level defs. This matches the common
 * fixture / single-target layout and avoids over-connecting unrelated
 * directories.
 *
 * Bindings are added through the append-only `bindingAugmentations`
 * channel (Contract Invariant I8) with `origin: 'namespace'`, exactly
 * like the Go implementation — `indexes.bindings` is frozen post-
 * finalize and must not be mutated.
 */

import type { BindingRef, ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

export function populateSwiftTargetSiblings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  _ctx: { readonly fileContents: ReadonlyMap<string, string> },
): void {
  // Group files by immediate containing directory (the module proxy).
  const filesByDir = new Map<string, { filePath: string; defs: SymbolDefinition[] }[]>();
  for (const parsed of parsedFiles) {
    const dir = containingDir(parsed.filePath);
    const list = filesByDir.get(dir) ?? [];
    list.push({ filePath: parsed.filePath, defs: [...parsed.localDefs] });
    filesByDir.set(dir, list);
  }

  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;

  for (const [, siblings] of filesByDir) {
    if (siblings.length < 2) continue; // no siblings to share
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

function containingDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
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
