import fs from 'node:fs/promises';
import path from 'node:path';
import type { CypherExecutor } from '../contract-extractor.js';
import type { GroupManifestLink, ContractRole } from '../types.js';
import { shouldIgnorePath, loadIgnoreRules } from '../../../config/ignore-service.js';

import { logger } from '../../logger.js';
interface PackageMeta {
  name: string;
  groupPath: string;
  repoPath: string;
  workspaceDeps: string[];
}

interface ImportedSymbol {
  packageName: string;
  symbolName: string;
  filePath: string;
}

async function parsePackageManifest(
  repoPath: string,
): Promise<{ name: string; workspaceDeps: string[] } | null> {
  const pkgPath = path.join(repoPath, 'package.json');
  let content: string;
  try {
    content = await fs.readFile(pkgPath, 'utf-8');
  } catch {
    return null;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content);
  } catch {
    return null;
  }

  const name = typeof pkg.name === 'string' ? pkg.name : '';
  if (!name) return null;

  const deps: string[] = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const section = pkg[field];
    if (section && typeof section === 'object') {
      deps.push(...Object.keys(section as Record<string, unknown>));
    }
  }

  return { name, workspaceDeps: [...new Set(deps)] };
}

async function scanImports(
  repoPath: string,
  knownPackages: Set<string>,
): Promise<ImportedSymbol[]> {
  const results: ImportedSymbol[] = [];
  const sourceFiles = await findSourceFiles(repoPath);

  for (const relFile of sourceFiles) {
    const absPath = path.join(repoPath, relFile);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    // ES import: import { Foo, Bar } from '<pkg>'
    // Also: import { Foo as Baz } from '<pkg>'
    const esImportRegex = /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm;
    let match;
    while ((match = esImportRegex.exec(content)) !== null) {
      const importClause = match[1];
      const modulePath = match[2];
      const pkgName = resolvePackageName(modulePath);
      if (!pkgName || !knownPackages.has(pkgName)) continue;

      const symbols = parseImportClause(importClause);
      for (const sym of symbols) {
        if (isExportedName(sym)) {
          results.push({ packageName: pkgName, symbolName: sym, filePath: relFile });
        }
      }
    }

    // ES import default: import Foo from '<pkg>'
    const defaultImportRegex = /^import\s+([A-Z][A-Za-z0-9]*)\s+from\s+['"]([^'"]+)['"]/gm;
    while ((match = defaultImportRegex.exec(content)) !== null) {
      const symbolName = match[1];
      const modulePath = match[2];
      const pkgName = resolvePackageName(modulePath);
      if (!pkgName || !knownPackages.has(pkgName)) continue;

      if (isExportedName(symbolName)) {
        results.push({ packageName: pkgName, symbolName, filePath: relFile });
      }
    }

    // CommonJS: const { Foo, Bar } = require('<pkg>')
    const cjsRegex = /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
    while ((match = cjsRegex.exec(content)) !== null) {
      const importClause = match[1];
      const modulePath = match[2];
      const pkgName = resolvePackageName(modulePath);
      if (!pkgName || !knownPackages.has(pkgName)) continue;

      const symbols = parseImportClause(importClause);
      for (const sym of symbols) {
        if (isExportedName(sym)) {
          results.push({ packageName: pkgName, symbolName: sym, filePath: relFile });
        }
      }
    }
  }

  return results;
}

function resolvePackageName(modulePath: string): string | null {
  if (modulePath.startsWith('.') || modulePath.startsWith('/')) return null;
  // Scoped: @scope/pkg or @scope/pkg/sub
  if (modulePath.startsWith('@')) {
    const parts = modulePath.split('/');
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return null;
  }
  // Unscoped: pkg or pkg/sub
  return modulePath.split('/')[0];
}

function parseImportClause(clause: string): string[] {
  return clause
    .split(',')
    .map((s) => {
      const trimmed = s.trim();
      // Handle `Foo as Bar` — use the original export name
      const asMatch = trimmed.match(/^(\S+)\s+as\s+/);
      return asMatch ? asMatch[1] : trimmed;
    })
    .filter(Boolean);
}

function isExportedName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

async function findSourceFiles(repoPath: string): Promise<string[]> {
  const results: string[] = [];
  const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
  const ig = await loadIgnoreRules(repoPath);

  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel + '/')) continue;
        await walk(path.join(dir, entry.name), childRel);
      } else {
        const ext = path.extname(entry.name);
        if (EXTENSIONS.has(ext)) {
          if (shouldIgnorePath(childRel)) continue;
          if (ig && ig.ignores(childRel)) continue;
          results.push(childRel);
        }
      }
    }
  }

  await walk(repoPath, '');
  return results;
}

export interface NodeWorkspaceResult {
  links: GroupManifestLink[];
  discoveredPackages: Map<string, PackageMeta>;
}

export async function extractNodeWorkspaceLinks(
  repos: Record<string, string>,
  repoPaths: Map<string, string>,
  _dbExecutors?: Map<string, CypherExecutor>,
): Promise<NodeWorkspaceResult> {
  const packagesByName = new Map<string, PackageMeta>();
  const packagesByGroupPath = new Map<string, PackageMeta>();

  for (const [groupPath] of Object.entries(repos)) {
    const repoPath = repoPaths.get(groupPath);
    if (!repoPath) continue;

    const manifest = await parsePackageManifest(repoPath);
    if (!manifest) continue;

    const meta: PackageMeta = {
      name: manifest.name,
      groupPath,
      repoPath,
      workspaceDeps: manifest.workspaceDeps,
    };
    const existing = packagesByName.get(manifest.name);
    if (existing) {
      logger.warn(
        `[node-workspace-extractor] duplicate package name "${manifest.name}" in "${groupPath}" and "${existing.groupPath}" — skipping "${groupPath}"`,
      );
      continue;
    }
    packagesByName.set(manifest.name, meta);
    packagesByGroupPath.set(groupPath, meta);
  }

  const links: GroupManifestLink[] = [];
  const seen = new Set<string>();

  for (const [, pkg] of packagesByGroupPath) {
    const groupPkgDeps = pkg.workspaceDeps.filter((d) => packagesByName.has(d));
    if (groupPkgDeps.length === 0) continue;

    const knownPackages = new Set(groupPkgDeps);
    const imports = await scanImports(pkg.repoPath, knownPackages);

    for (const imp of imports) {
      const providerPkg = packagesByName.get(imp.packageName);
      if (!providerPkg) continue;

      const qualifiedContract = `${imp.packageName}::${imp.symbolName}`;
      const key = `${pkg.groupPath}→${providerPkg.groupPath}::${qualifiedContract}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const link: GroupManifestLink = {
        from: providerPkg.groupPath,
        to: pkg.groupPath,
        type: 'custom',
        contract: qualifiedContract,
        role: 'provider' as ContractRole,
      };
      links.push(link);
    }
  }

  return { links, discoveredPackages: packagesByGroupPath };
}
