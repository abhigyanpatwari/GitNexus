/**
 * Header / implementation visibility for `populateNamespaceSiblings`.
 *
 * Objective-C has no Java package or C# namespace. The compilation unit is
 * the workspace analog: `Foo.h` + `Foo.m` in the same directory, and files
 * that declare or implement the same class / protocol, see each other's
 * top-level defs without a second `#import` of a sibling they already share.
 * Bindings go through the append-only `bindingAugmentations` channel
 * (`origin: 'namespace'`), matching Swift / Go.
 */

import type { BindingRef, ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  isInternalObjectiveCFunctionDef,
  objectiveCFactsFromParsedFiles,
  type ObjCContainerFact,
} from './facts.js';

export function populateObjectiveCCompilationUnitSiblings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const groups = new Map<string, ParsedFile[]>();
  const byPath = new Map<string, ParsedFile>();
  for (const parsed of parsedFiles) {
    byPath.set(parsed.filePath, parsed);
    const stemKey = compilationUnitStemKey(parsed.filePath);
    if (stemKey !== undefined) appendGroup(groups, stemKey, parsed);
  }

  const internalFunctionIds = new Set<string>();
  for (const fact of objectiveCFactsFromParsedFiles(parsedFiles)) {
    const parsed = byPath.get(fact.filePath);
    if (parsed !== undefined) {
      for (const container of fact.containers) {
        appendGroup(groups, `type:${typeVisibilityName(container)}`, parsed);
      }
    }
    for (const fn of fact.functions) {
      if (fn.linkage === 'internal') internalFunctionIds.add(fn.nodeId);
    }
  }

  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const unique = uniqueFiles(group);
    if (unique.length < 2) continue;
    for (const receiver of unique) {
      const receiverModule = indexes.moduleScopes.byFilePath.get(receiver.filePath);
      if (receiverModule === undefined) continue;
      for (const source of unique) {
        if (source.filePath === receiver.filePath) continue;
        for (const def of source.localDefs as SymbolDefinition[]) {
          if (internalFunctionIds.has(def.nodeId) || isInternalObjectiveCFunctionDef(def)) {
            continue;
          }
          const name = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
          if (name === '') continue;
          const bucket = getAugmentationBucket(augmentations, receiverModule, name);
          if (bucket.some((binding) => binding.def.nodeId === def.nodeId)) continue;
          bucket.push({ def, origin: 'namespace' });
        }
      }
    }
  }
}

function compilationUnitStemKey(filePath: string): string | undefined {
  const normalized = filePath.replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  const base = slash === -1 ? normalized : normalized.slice(slash + 1);
  const ext = extensionOf(base);
  if (ext !== '.h' && ext !== '.m' && ext !== '.mm') return undefined;
  const dir = slash === -1 ? '' : normalized.slice(0, slash);
  return `stem:${dir}/${base.slice(0, -ext.length)}`;
}

function typeVisibilityName(container: ObjCContainerFact): string {
  if (container.kind === 'category' || container.kind === 'extension') {
    return container.hostClass ?? container.name;
  }
  return container.name;
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

function appendGroup(groups: Map<string, ParsedFile[]>, key: string, parsed: ParsedFile): void {
  const bucket = groups.get(key);
  if (bucket === undefined) {
    groups.set(key, [parsed]);
    return;
  }
  bucket.push(parsed);
}

function uniqueFiles(group: readonly ParsedFile[]): ParsedFile[] {
  const seen = new Set<string>();
  const out: ParsedFile[] = [];
  for (const parsed of group) {
    if (seen.has(parsed.filePath)) continue;
    seen.add(parsed.filePath);
    out.push(parsed);
  }
  return out;
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
  let bucket = scopeBindings.get(name);
  if (bucket === undefined) {
    bucket = [];
    scopeBindings.set(name, bucket);
  }
  return bucket;
}
