import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';

export interface ScannedImport {
  /** The npm package name that was imported (e.g. '@acme/shared-utils') */
  packageName: string;
  /** Individual symbol names imported (empty for default/namespace imports) */
  importedSymbols: string[];
  /** File path relative to repo root */
  filePath: string;
  /** Subpath after the package name (e.g. '/utils' from '@acme/shared-utils/utils') */
  subpath: string | undefined;
  /** Whether this is a namespace import (import * as X) */
  isNamespaceImport: boolean;
  /** Whether this is a default import */
  isDefaultImport: boolean;
}

const ES_IMPORT_RE =
  /(?:import\s+(?:(\*\s+as\s+\w+)\s+from|(\w+)(?:\s*,\s*\{([^}]*)\})?\s+from|(?:type\s+)?\{([^}]*)\}\s+from)\s*['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|export\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"]([^'"]+)['"])/g;

const CJS_REQUIRE_RE =
  /(?:const|let|var)\s+(?:(\w+)|\{([^}]*)\})\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Parse a destructured import list like "Foo, Bar as Baz, type Qux" into symbol names.
 */
function parseNamedImports(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      // Remove 'type ' prefix for type-only imports
      const withoutType = s.replace(/^type\s+/, '');
      // Handle 'Foo as Bar' — we want the original name 'Foo'
      const asIdx = withoutType.indexOf(' as ');
      return asIdx >= 0 ? withoutType.substring(0, asIdx).trim() : withoutType.trim();
    })
    .filter((s) => s.length > 0);
}

/**
 * Split a package specifier into package name and optional subpath.
 * Handles scoped packages: '@scope/pkg/sub' → ['@scope/pkg', '/sub']
 * And unscoped: 'pkg/sub' → ['pkg', '/sub']
 */
function splitPackageSpecifier(specifier: string): { packageName: string; subpath?: string } {
  if (specifier.startsWith('@')) {
    // Scoped: @scope/name or @scope/name/sub/path
    const parts = specifier.split('/');
    const packageName = parts.slice(0, 2).join('/');
    const subpath = parts.length > 2 ? '/' + parts.slice(2).join('/') : undefined;
    return { packageName, subpath };
  }

  const slashIdx = specifier.indexOf('/');
  if (slashIdx < 0) return { packageName: specifier };

  const packageName = specifier.substring(0, slashIdx);
  const subpath = specifier.substring(slashIdx);
  return { packageName, subpath };
}

/**
 * Scan a single file's source code for imports matching any of the target packages.
 */
export function scanFileForImports(
  content: string,
  filePath: string,
  targetPackages: Set<string>,
): ScannedImport[] {
  const results: ScannedImport[] = [];

  // ES imports
  let match: RegExpExecArray | null;
  const esRe = new RegExp(ES_IMPORT_RE.source, ES_IMPORT_RE.flags);
  while ((match = esRe.exec(content)) !== null) {
    const specifier = match[5] || match[6] || match[7];
    if (!specifier) continue;

    const { packageName, subpath } = splitPackageSpecifier(specifier);
    if (!targetPackages.has(packageName)) continue;

    const isNamespaceImport = !!match[1];
    const isDefaultImport = !!match[2];
    const namedFromDefault = match[3] || '';
    const namedOnly = match[4] || '';

    const importedSymbols = [
      ...parseNamedImports(namedFromDefault),
      ...parseNamedImports(namedOnly),
    ];

    const isSideEffect = !!match[6];

    results.push({
      packageName,
      importedSymbols,
      filePath,
      subpath,
      isNamespaceImport,
      isDefaultImport: isDefaultImport && !isSideEffect,
    });
  }

  // CommonJS require
  const cjsRe = new RegExp(CJS_REQUIRE_RE.source, CJS_REQUIRE_RE.flags);
  while ((match = cjsRe.exec(content)) !== null) {
    const specifier = match[3];
    if (!specifier) continue;

    const { packageName, subpath } = splitPackageSpecifier(specifier);
    if (!targetPackages.has(packageName)) continue;

    const defaultName = match[1];
    const destructured = match[2];

    const importedSymbols = destructured ? parseNamedImports(destructured) : [];
    const isDefaultImport = !!defaultName;

    results.push({
      packageName,
      importedSymbols,
      filePath,
      subpath,
      isNamespaceImport: false,
      isDefaultImport,
    });
  }

  return results;
}

/**
 * Scan all source files in a repo for imports matching target packages.
 */
export async function scanRepoForImports(
  repoPath: string,
  targetPackages: Set<string>,
): Promise<ScannedImport[]> {
  if (targetPackages.size === 0) return [];

  const files = await glob('**/*.{ts,tsx,js,jsx,mjs,cjs}', {
    cwd: repoPath,
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.gitnexus/**'],
    nodir: true,
  });

  const results: ScannedImport[] = [];

  for (const rel of files) {
    const abs = path.resolve(repoPath, rel);
    const base = path.resolve(repoPath);
    const relToBase = path.relative(base, abs);
    if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) continue;

    let content: string;
    try {
      content = await fs.promises.readFile(abs, 'utf-8');
    } catch {
      continue;
    }

    results.push(...scanFileForImports(content, rel, targetPackages));
  }

  return results;
}
