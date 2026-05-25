/**
 * Java package-scope implicit visibility.
 *
 * Classes in the same Java package see each other without explicit
 * `import` statements.  This hook groups files by `package` declaration,
 * then injects cross-file class defs into each file's module-scope
 * `bindingAugmentations` and mirrors type-bindings across same-package
 * files — the Java equivalent of C#'s `populateNamespaceSiblings`.
 */

import type { BindingRef, ParsedFile, ScopeId, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { getJavaParser } from './query.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { logger } from '../../../logger.js';

function extractPackageName(content: string, cachedTree?: unknown): string {
  const tree =
    (cachedTree as ReturnType<ReturnType<typeof getJavaParser>['parse']> | undefined) ??
    parseSourceSafe(getJavaParser(), content);
  for (const child of tree.rootNode.namedChildren) {
    if (child.type === 'package_declaration') {
      const scoped = child.namedChildren.find(
        (c) => c.type === 'scoped_identifier' || c.type === 'identifier',
      );
      return scoped?.text ?? '';
    }
  }
  return '';
}

interface PackageBucket {
  readonly parsed: ParsedFile[];
  readonly moduleScopes: { filePath: string; scope: ParsedFile['scopes'][number] }[];
}

export function populateJavaPackageSiblings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly treeCache?: { get(filePath: string): unknown };
  },
): void {
  const buckets = new Map<string, PackageBucket>();

  for (const parsed of parsedFiles) {
    const content = ctx.fileContents.get(parsed.filePath);
    if (content === undefined) continue;
    const pkg = extractPackageName(content, ctx.treeCache?.get(parsed.filePath));
    let bucket = buckets.get(pkg);
    if (bucket === undefined) {
      bucket = { parsed: [], moduleScopes: [] };
      buckets.set(pkg, bucket);
    }
    bucket.parsed.push(parsed);
    const ms = parsed.scopes.find((s) => s.kind === 'Module');
    if (ms !== undefined) {
      bucket.moduleScopes.push({ filePath: parsed.filePath, scope: ms });
    }
  }

  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;

  const MAX_PACKAGE_FILES = 500;

  for (const bucket of buckets.values()) {
    if (bucket.moduleScopes.length < 2) continue;
    if (bucket.moduleScopes.length > MAX_PACKAGE_FILES) {
      logger.warn(
        `[java-package-siblings] skipping package with ${bucket.moduleScopes.length} files (cap=${MAX_PACKAGE_FILES}); same-package implicit visibility disabled for this package`,
      );
      continue;
    }

    const classDefs: { def: BindingRef['def']; filePath: string }[] = [];
    for (const parsed of bucket.parsed) {
      const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
      const moduleScopeId = moduleScope?.id;
      for (const scope of parsed.scopes) {
        if (scope.kind !== 'Class') continue;
        if (scope.parent !== moduleScopeId) continue;
        for (const def of scope.ownedDefs) {
          if (isClassLike(def.type)) {
            classDefs.push({ def, filePath: parsed.filePath });
            break;
          }
        }
      }
    }

    for (const { filePath, scope } of bucket.moduleScopes) {
      let scopeAug = augmentations.get(scope.id);
      if (scopeAug === undefined) {
        scopeAug = new Map();
        augmentations.set(scope.id, scopeAug);
      }

      const candidates = classDefs.filter((d) => d.filePath !== filePath);
      const proximityCache = new Map<string, number>();
      for (const c of candidates) {
        if (!proximityCache.has(c.filePath)) {
          proximityCache.set(c.filePath, sharedSegmentCount(c.filePath, filePath));
        }
      }
      const sorted = candidates.sort(
        (a, b) => (proximityCache.get(b.filePath) ?? 0) - (proximityCache.get(a.filePath) ?? 0),
      );

      const injectedIds = new Set<string>();
      for (const { def } of sorted) {
        if (injectedIds.has(def.nodeId)) continue;
        const qn = def.qualifiedName;
        if (qn === undefined) continue;
        injectedIds.add(def.nodeId);
        const simpleName = qn.includes('.') ? qn.slice(qn.lastIndexOf('.') + 1) : qn;
        let list = scopeAug.get(simpleName);
        if (list === undefined) {
          list = [];
          scopeAug.set(simpleName, list);
        }
        list.push({ def, origin: 'namespace' });
      }

      const tb = scope.typeBindings as Map<string, TypeRef>;
      for (const sibling of bucket.moduleScopes) {
        if (sibling.filePath === filePath) continue;
        for (const [name, ref] of sibling.scope.typeBindings) {
          if (tb.has(name)) continue;
          tb.set(name, ref);
        }
      }

      for (const sibParsed of bucket.parsed) {
        if (sibParsed.filePath === filePath) continue;
        for (const sibScope of sibParsed.scopes) {
          if (sibScope.kind !== 'Class') continue;
          for (const [name, ref] of sibScope.typeBindings) {
            if (ref.source === 'self') continue;
            if (tb.has(name)) continue;
            tb.set(name, ref);
          }
        }
      }
    }
  }
}

function sharedSegmentCount(a: string, b: string): number {
  const sa = a.replace(/\\/g, '/').split('/');
  const sb = b.replace(/\\/g, '/').split('/');
  let i = 0;
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  return i;
}
