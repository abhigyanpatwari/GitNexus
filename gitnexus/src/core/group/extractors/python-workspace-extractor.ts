import fs from 'node:fs/promises';
import path from 'node:path';
import type { CypherExecutor } from '../contract-extractor.js';
import type { GroupManifestLink, ContractRole } from '../types.js';
import { getPythonParser } from '../../ingestion/languages/python/query.js';
import { getMaxFileSizeBytes } from '../../ingestion/utils/max-file-size.js';
import {
  ParseTimeoutError,
  parseHadErrors,
  parseSourceSafe,
} from '../../tree-sitter/safe-parse.js';
import {
  shouldIgnorePath,
  loadIgnoreRules,
  isHardcodedIgnoredDirectoryAtPath,
} from '../../../config/ignore-service.js';
import { readSafeBounded } from './fs-utils.js';

import { logger } from '../../logger.js';

interface PythonPackageMeta {
  name: string;
  importName: string;
  groupPath: string;
  repoPath: string;
  workspaceDeps: string[];
}

interface ImportedSymbol {
  importName: string;
  symbolName: string;
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
  const importName = toPythonImportName(name);

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
  const importName = toPythonImportName(name);

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

function toPythonImportName(name: string): string {
  return name.replace(/-/g, '_');
}

function collectFromImportNames(
  node: {
    namedChildCount: number;
    namedChild(index: number): {
      id: number;
      type: string;
      text: string;
      childForFieldName(name: string): { text: string } | null;
    } | null;
  },
  moduleNodeId: number,
): string[] {
  const symbols: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.id === moduleNodeId) continue;
    if (child.type === 'dotted_name') {
      symbols.push(child.text);
    } else if (child.type === 'aliased_import') {
      const imported = child.childForFieldName('name');
      if (imported) symbols.push(imported.text);
    }
  }
  return symbols;
}

/** Cheap skip before tree-sitter: real `from <mod>` tokens, not `fromage`. */
function hasFromImportToken(content: string): boolean {
  return /(?:^|[\s;])from\s+\S/.test(content);
}

async function scanPythonImports(
  repoPath: string,
  knownPackages: Set<string>,
): Promise<ImportedSymbol[]> {
  const results: ImportedSymbol[] = [];
  const sourceFiles = await findPythonFiles(repoPath);
  const parser = getPythonParser();
  const maxFileSizeBytes = getMaxFileSizeBytes();

  for (const relFile of sourceFiles) {
    const content = await readSafeBounded(repoPath, relFile, maxFileSizeBytes);
    if (content == null || !hasFromImportToken(content)) continue;

    let tree;
    try {
      tree = parseSourceSafe(parser, content, undefined, undefined, relFile);
    } catch (error) {
      if (error instanceof ParseTimeoutError) {
        logger.warn(
          { file: relFile },
          'python-workspace-extractor: parse timed out, skipping file',
        );
        continue;
      }
      throw error;
    }
    const degraded = parseHadErrors(tree);
    const visit = (node: (typeof tree)['rootNode']): void => {
      if (node.type !== 'import_from_statement') {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) visit(child);
        }
        return;
      }

      // Error recovery can promote unclosed-docstring lookalikes into real
      // import_from_statement nodes. Keep column-0 imports; drop indented ones
      // on a degraded tree so function-local discovery stays on clean parses.
      if (degraded && node.startPosition.column > 0) return;

      const moduleNode = node.childForFieldName('module_name');
      const modulePath = moduleNode?.text;
      if (!modulePath) return;
      const rootModule = modulePath.split('.')[0];
      if (!knownPackages.has(rootModule)) return;

      for (const sym of collectFromImportNames(node, moduleNode.id)) {
        if (isPascalCase(sym)) {
          results.push({ importName: rootModule, symbolName: sym });
        }
      }
    };
    visit(tree.rootNode);
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
        const childPath = path.join(dir, entry.name);
        if (shouldIgnorePath(childRel)) continue;
        if (isHardcodedIgnoredDirectoryAtPath(repoPath, childPath)) continue;
        if (ig && ig.ignores(childRel + '/')) continue;
        await walk(childPath, childRel);
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
    const normalizedDeps = pkg.workspaceDeps.map(toPythonImportName);
    const groupPkgDeps = normalizedDeps.filter((d) => packagesByImportName.has(d));
    if (groupPkgDeps.length === 0) continue;

    const imports = await scanPythonImports(pkg.repoPath, new Set(groupPkgDeps));

    for (const imp of imports) {
      const providerPkg = packagesByImportName.get(imp.importName);
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
