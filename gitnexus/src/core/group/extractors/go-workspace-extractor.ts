import fs from 'node:fs/promises';
import path from 'node:path';
import type { CypherExecutor } from '../contract-extractor.js';
import type { GroupManifestLink, ContractRole } from '../types.js';
import { shouldIgnorePath, loadIgnoreRules } from '../../../config/ignore-service.js';

interface GoModuleMeta {
  modulePath: string;
  groupPath: string;
  repoPath: string;
  requires: string[];
}

interface ImportedSymbol {
  modulePath: string;
  symbolName: string;
  filePath: string;
}

async function parseGoMod(
  repoPath: string,
): Promise<{ modulePath: string; requires: string[] } | null> {
  const goModPath = path.join(repoPath, 'go.mod');
  let content: string;
  try {
    content = await fs.readFile(goModPath, 'utf-8');
  } catch {
    return null;
  }

  const moduleMatch = content.match(/^module\s+(\S+)/m);
  if (!moduleMatch) return null;
  const modulePath = moduleMatch[1];

  const requires: string[] = [];

  // Single-line: require github.com/org/repo v1.2.3
  const singleReqs = content.matchAll(/^require\s+(\S+)\s+/gm);
  for (const m of singleReqs) requires.push(m[1]);

  // Block: require ( ... )
  const blockReqs = content.matchAll(/^require\s*\(\s*\n([\s\S]*?)\)/gm);
  for (const block of blockReqs) {
    const lines = block[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts[0]) requires.push(parts[0]);
    }
  }

  // replace directives (local path deps)
  const replaceLines = content.matchAll(/^replace\s+(\S+)\s+=>\s+\.\//gm);
  for (const m of replaceLines) {
    if (!requires.includes(m[1])) requires.push(m[1]);
  }

  const replaceBlocks = content.matchAll(/^replace\s*\(\s*\n([\s\S]*?)\)/gm);
  for (const block of replaceBlocks) {
    const lines = block[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      const match = trimmed.match(/^(\S+)\s+=>\s+\.\//);
      if (match && !requires.includes(match[1])) requires.push(match[1]);
    }
  }

  return { modulePath, requires: [...new Set(requires)] };
}

async function scanGoImports(
  repoPath: string,
  knownModules: Map<string, string>,
): Promise<ImportedSymbol[]> {
  const results: ImportedSymbol[] = [];
  const sourceFiles = await findGoFiles(repoPath);

  for (const relFile of sourceFiles) {
    const absPath = path.join(repoPath, relFile);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    const importPaths = extractImportPaths(content);
    for (const importPath of importPaths) {
      const matchedModule = findMatchingModule(importPath, knownModules);
      if (!matchedModule) continue;

      const symbols = extractUsedTypes(content, importPath);
      for (const sym of symbols) {
        results.push({ modulePath: matchedModule, symbolName: sym, filePath: relFile });
      }
    }
  }

  return results;
}

function extractImportPaths(content: string): string[] {
  const paths: string[] = [];

  // Single: import "path"
  const singleImports = content.matchAll(/^import\s+"([^"]+)"/gm);
  for (const m of singleImports) paths.push(m[1]);

  // Single aliased: import alias "path"
  const aliasedImports = content.matchAll(/^import\s+\w+\s+"([^"]+)"/gm);
  for (const m of aliasedImports) paths.push(m[1]);

  // Block: import ( ... )
  const blockImports = content.matchAll(/^import\s*\(\s*\n([\s\S]*?)\)/gm);
  for (const block of blockImports) {
    const lines = block[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      const pathMatch = trimmed.match(/"([^"]+)"/);
      if (pathMatch) paths.push(pathMatch[1]);
    }
  }

  return [...new Set(paths)];
}

function findMatchingModule(importPath: string, knownModules: Map<string, string>): string | null {
  for (const [modPath] of knownModules) {
    if (importPath === modPath || importPath.startsWith(modPath + '/')) {
      return modPath;
    }
  }
  return null;
}

function extractUsedTypes(content: string, importPath: string): string[] {
  const pkgName = importPath.split('/').pop() || '';
  if (!pkgName) return [];

  // Match pkg.TypeName where TypeName is PascalCase (exported)
  const typeRegex = new RegExp(`\\b${escapeRegex(pkgName)}\\.([A-Z][A-Za-z0-9]*)`, 'g');
  const types = new Set<string>();
  let match;
  while ((match = typeRegex.exec(content)) !== null) {
    types.add(match[1]);
  }
  return [...types];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findGoFiles(repoPath: string): Promise<string[]> {
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
      } else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel)) continue;
        results.push(childRel);
      }
    }
  }

  await walk(repoPath, '');
  return results;
}

export interface GoWorkspaceResult {
  links: GroupManifestLink[];
  discoveredModules: Map<string, GoModuleMeta>;
}

export async function extractGoWorkspaceLinks(
  repos: Record<string, string>,
  repoPaths: Map<string, string>,
  _dbExecutors?: Map<string, CypherExecutor>,
): Promise<GoWorkspaceResult> {
  const modulesByPath = new Map<string, GoModuleMeta>();
  const modulesByGroupPath = new Map<string, GoModuleMeta>();

  for (const [groupPath] of Object.entries(repos)) {
    const repoPath = repoPaths.get(groupPath);
    if (!repoPath) continue;

    const manifest = await parseGoMod(repoPath);
    if (!manifest) continue;

    const meta: GoModuleMeta = {
      modulePath: manifest.modulePath,
      groupPath,
      repoPath,
      requires: manifest.requires,
    };
    const existing = modulesByPath.get(manifest.modulePath);
    if (existing) {
      console.warn(
        `[go-workspace-extractor] duplicate module "${manifest.modulePath}" in "${groupPath}" and "${existing.groupPath}" — skipping "${groupPath}"`,
      );
      continue;
    }
    modulesByPath.set(manifest.modulePath, meta);
    modulesByGroupPath.set(groupPath, meta);
  }

  const links: GroupManifestLink[] = [];
  const seen = new Set<string>();

  for (const [, mod] of modulesByGroupPath) {
    const groupModDeps = mod.requires.filter((r) => modulesByPath.has(r));
    if (groupModDeps.length === 0) continue;

    const knownModules = new Map<string, string>();
    for (const dep of groupModDeps) {
      knownModules.set(dep, dep);
    }

    const imports = await scanGoImports(mod.repoPath, knownModules);

    for (const imp of imports) {
      const providerMod = modulesByPath.get(imp.modulePath);
      if (!providerMod) continue;

      const qualifiedContract = `${imp.modulePath}::${imp.symbolName}`;
      const key = `${mod.groupPath}→${providerMod.groupPath}::${qualifiedContract}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const link: GroupManifestLink = {
        from: providerMod.groupPath,
        to: mod.groupPath,
        type: 'custom',
        contract: qualifiedContract,
        role: 'provider' as ContractRole,
      };
      links.push(link);
    }
  }

  return { links, discoveredModules: modulesByGroupPath };
}
