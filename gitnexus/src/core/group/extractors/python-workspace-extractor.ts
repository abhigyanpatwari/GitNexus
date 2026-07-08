import fs from 'node:fs/promises';
import path from 'node:path';
import type { CypherExecutor } from '../contract-extractor.js';
import type { GroupManifestLink, ContractRole } from '../types.js';
import { shouldIgnorePath, loadIgnoreRules } from '../../../config/ignore-service.js';

import { logger } from '../../logger.js';
interface PythonPackageMeta {
  name: string;
  importName: string;
  groupPath: string;
  repoPath: string;
  workspaceDeps: string[];
}

interface ImportedSymbol {
  packageName: string;
  symbolName: string;
  filePath: string;
}

async function parsePythonManifest(
  repoPath: string,
): Promise<{ name: string; importName: string; deps: string[] } | null> {
  const pyprojectPath = path.join(repoPath, 'pyproject.toml');
  let content: string | null = null;
  try {
    content = await fs.readFile(pyprojectPath, 'utf-8');
  } catch {
    // fall through to setup.py
  }

  if (content) return parsePyproject(content);

  const setupPyPath = path.join(repoPath, 'setup.py');
  try {
    content = await fs.readFile(setupPyPath, 'utf-8');
  } catch {
    return null;
  }
  return parseSetupPy(content);
}

function parsePyproject(
  content: string,
): { name: string; importName: string; deps: string[] } | null {
  const nameMatch = content.match(/^\[project\]\s*\n(?:[^\n\[]*\n)*?name\s*=\s*"([^"]+)"/m);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const importName = name.replace(/-/g, '_');

  const deps: string[] = [];
  const depsMatch = content.match(/^\[project\]\s*\n[\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (depsMatch) {
    const depLines = depsMatch[1].matchAll(/"([^"]+)"/g);
    for (const m of depLines) {
      deps.push(extractPepName(m[1]));
    }
  }

  const optMatch = content.match(/\[project\.optional-dependencies\]\s*\n([\s\S]*?)(?=\n\[|$)/);
  if (optMatch) {
    const optDeps = optMatch[1].matchAll(/"([^"]+)"/g);
    for (const m of optDeps) {
      deps.push(extractPepName(m[1]));
    }
  }

  return { name, importName, deps: [...new Set(deps)] };
}

function parseSetupPy(
  content: string,
): { name: string; importName: string; deps: string[] } | null {
  const nameMatch = content.match(/name\s*=\s*['"]([^'"]+)['"]/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const importName = name.replace(/-/g, '_');

  const deps: string[] = [];
  const installMatch = content.match(/install_requires\s*=\s*\[([\s\S]*?)\]/);
  if (installMatch) {
    const depLines = installMatch[1].matchAll(/['"]([^'"]+)['"]/g);
    for (const m of depLines) {
      deps.push(extractPepName(m[1]));
    }
  }

  return { name, importName, deps: [...new Set(deps)] };
}

function extractPepName(spec: string): string {
  return spec.split(/[><=!~;\[]/)[0].trim();
}

async function scanPythonImports(
  repoPath: string,
  knownPackages: Map<string, string>,
): Promise<ImportedSymbol[]> {
  const results: ImportedSymbol[] = [];
  const sourceFiles = await findPythonFiles(repoPath);

  for (const relFile of sourceFiles) {
    const absPath = path.join(repoPath, relFile);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    // from <pkg> import Foo, Bar
    // from <pkg>.module import Foo
    const fromImportRegex = /^from\s+(\w[\w.]*)\s+import\s+(.+)/gm;
    let match;
    while ((match = fromImportRegex.exec(content)) !== null) {
      const modulePath = match[1];
      const importClause = match[2];
      const rootModule = modulePath.split('.')[0];
      const originalName = knownPackages.get(rootModule);
      if (!originalName) continue;

      if (importClause.trim() === '(') continue;

      const symbols = importClause
        .replace(/\(|\)/g, '')
        .split(',')
        .map((s) => {
          const trimmed = s.trim();
          const asMatch = trimmed.match(/^(\S+)\s+as\s+/);
          return asMatch ? asMatch[1] : trimmed;
        })
        .filter(Boolean);

      for (const sym of symbols) {
        if (isPascalCase(sym)) {
          results.push({ packageName: originalName, symbolName: sym, filePath: relFile });
        }
      }
    }
  }

  return results;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

async function findPythonFiles(repoPath: string): Promise<string[]> {
  const results: string[] = [];
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
      } else if (entry.name.endsWith('.py')) {
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel)) continue;
        results.push(childRel);
      }
    }
  }

  await walk(repoPath, '');
  return results;
}

export interface PythonWorkspaceResult {
  links: GroupManifestLink[];
  discoveredPackages: Map<string, PythonPackageMeta>;
}

export async function extractPythonWorkspaceLinks(
  repos: Record<string, string>,
  repoPaths: Map<string, string>,
  _dbExecutors?: Map<string, CypherExecutor>,
): Promise<PythonWorkspaceResult> {
  const packagesByImportName = new Map<string, PythonPackageMeta>();
  const packagesByGroupPath = new Map<string, PythonPackageMeta>();

  for (const [groupPath] of Object.entries(repos)) {
    const repoPath = repoPaths.get(groupPath);
    if (!repoPath) continue;

    const manifest = await parsePythonManifest(repoPath);
    if (!manifest) continue;

    const meta: PythonPackageMeta = {
      name: manifest.name,
      importName: manifest.importName,
      groupPath,
      repoPath,
      workspaceDeps: manifest.deps,
    };
    const existing = packagesByImportName.get(manifest.importName);
    if (existing) {
      logger.warn(
        `[python-workspace-extractor] duplicate package "${manifest.name}" in "${groupPath}" and "${existing.groupPath}" — skipping "${groupPath}"`,
      );
      continue;
    }
    packagesByImportName.set(manifest.importName, meta);
    packagesByGroupPath.set(groupPath, meta);
  }

  const links: GroupManifestLink[] = [];
  const seen = new Set<string>();

  for (const [, pkg] of packagesByGroupPath) {
    const normalizedDeps = pkg.workspaceDeps.map((d) => d.replace(/-/g, '_'));
    const groupPkgDeps = normalizedDeps.filter((d) => packagesByImportName.has(d));
    if (groupPkgDeps.length === 0) continue;

    const knownPackages = new Map<string, string>();
    for (const dep of groupPkgDeps) {
      const meta = packagesByImportName.get(dep);
      if (meta) knownPackages.set(dep, meta.name);
    }

    const imports = await scanPythonImports(pkg.repoPath, knownPackages);

    for (const imp of imports) {
      const providerImportName = imp.packageName.replace(/-/g, '_');
      const providerPkg = packagesByImportName.get(providerImportName);
      if (!providerPkg) continue;

      const qualifiedContract = `${providerPkg.name}::${imp.symbolName}`;
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
