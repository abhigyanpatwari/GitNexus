/**
 * Dart import resolution.
 * Handles: dart: SDK (skip), package: (pubspec), relative (.dart) imports.
 */

import type { ImportResult, ResolveCtx } from './types.js';

/** Dart: package: imports via pubspec.yaml, dart: SDK skipped, relative imports. */
export function resolveDartImport(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  // Skip SDK imports (dart:core, dart:async, etc.)
  if (rawImportPath.startsWith('dart:')) return null;

  // package: imports — resolve via pubspec.yaml package name
  if (rawImportPath.startsWith('package:')) {
    const dartPubspec = ctx.configs.dartPubspec;
    if (dartPubspec) {
      const prefix = `package:${dartPubspec.packageName}/`;
      if (rawImportPath.startsWith(prefix)) {
        const relativePath = 'lib/' + rawImportPath.slice(prefix.length);
        if (ctx.allFilePaths.has(relativePath)) {
          return { kind: 'files', files: [relativePath] };
        }
      }
    }
    // External package — not in repo
    return null;
  }

  // Relative imports (./foo.dart, ../bar.dart, bare relative)
  const currentDir = filePath.split('/').slice(0, -1);
  const parts = rawImportPath.replace(/^\.\//, '').split('/');
  const resolvedParts = [...currentDir];
  for (const part of parts) {
    if (part === '..') resolvedParts.pop();
    else if (part !== '.') resolvedParts.push(part);
  }
  const resolved = resolvedParts.join('/');
  if (ctx.allFilePaths.has(resolved)) {
    return { kind: 'files', files: [resolved] };
  }
  return null;
}
