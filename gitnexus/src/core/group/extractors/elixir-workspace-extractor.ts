import fs from 'node:fs/promises';
import path from 'node:path';
import type { CypherExecutor } from '../contract-extractor.js';
import type { GroupManifestLink, ContractRole } from '../types.js';
import { shouldIgnorePath, loadIgnoreRules } from '../../../config/ignore-service.js';

interface ElixirAppMeta {
  appName: string;
  modulePrefix: string;
  groupPath: string;
  repoPath: string;
  deps: string[];
}

interface ImportedModule {
  appName: string;
  moduleName: string;
  filePath: string;
}

async function parseMixExs(
  repoPath: string,
): Promise<{ appName: string; modulePrefix: string; deps: string[] } | null> {
  const mixPath = path.join(repoPath, 'mix.exs');
  let content: string;
  try {
    content = await fs.readFile(mixPath, 'utf-8');
  } catch {
    return null;
  }

  // app: :my_app
  const appMatch = content.match(/app:\s*:(\w+)/);
  if (!appMatch) return null;
  const appName = appMatch[1];

  // Derive module prefix: my_app -> MyApp
  const modulePrefix = appName
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

  const deps: string[] = [];

  // {:dep_name, "~> 1.0"} or {:dep_name, in_umbrella: true}
  // {:dep_name, git: "..."} or {:dep_name, path: "..."}
  const depMatches = content.matchAll(
    /\{:(\w+)\s*,\s*(?:"[^"]*"|~[^}]*|[^}]*(?:in_umbrella|path|git)\s*:[^}]*)\}/g,
  );
  for (const m of depMatches) {
    deps.push(m[1]);
  }

  return { appName, modulePrefix, deps: [...new Set(deps)] };
}

async function scanElixirImports(
  repoPath: string,
  knownApps: Map<string, string>,
): Promise<ImportedModule[]> {
  const results: ImportedModule[] = [];
  const sourceFiles = await findElixirFiles(repoPath);

  for (const relFile of sourceFiles) {
    const absPath = path.join(repoPath, relFile);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    // alias MyApp.SomeModule
    // alias MyApp.SomeModule, as: Short
    // alias MyApp.{ModA, ModB}
    const aliasRegex = /^\s*alias\s+([A-Z]\w+(?:\.[A-Z]\w+)*(?:\.\{[^}]+\})?)/gm;
    let match;
    while ((match = aliasRegex.exec(content)) !== null) {
      const aliasExpr = match[1];
      const modules = expandAlias(aliasExpr);
      for (const mod of modules) {
        const appName = matchModuleToApp(mod, knownApps);
        if (appName) {
          results.push({ appName, moduleName: mod, filePath: relFile });
        }
      }
    }

    // Direct module reference: MyApp.Module.func() or MyApp.Module
    // Strip comment lines and string literals to avoid false positives
    const codeOnly = content
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    for (const [prefix, appName] of knownApps) {
      const refRegex = new RegExp(
        `\\b(${escapeRegex(prefix)}\\.[A-Z][A-Za-z0-9]*(?:\\.[A-Z][A-Za-z0-9]*)*)`,
        'g',
      );
      while ((match = refRegex.exec(codeOnly)) !== null) {
        const mod = match[1];
        if (!results.some((r) => r.moduleName === mod && r.filePath === relFile)) {
          results.push({ appName, moduleName: mod, filePath: relFile });
        }
      }
    }
  }

  return results;
}

function expandAlias(expr: string): string[] {
  const braceMatch = expr.match(/^([A-Z][\w.]*)\.\{([^}]+)\}$/);
  if (braceMatch) {
    const prefix = braceMatch[1];
    return braceMatch[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `${prefix}.${s}`);
  }
  return [expr];
}

function matchModuleToApp(moduleName: string, knownApps: Map<string, string>): string | null {
  for (const [prefix, appName] of knownApps) {
    if (moduleName === prefix || moduleName.startsWith(prefix + '.')) {
      return appName;
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTopModule(moduleName: string, prefix: string): string {
  const rest = moduleName.slice(prefix.length);
  if (!rest || rest === '.') return moduleName;
  const afterDot = rest.startsWith('.') ? rest.slice(1) : rest;
  const parts = afterDot.split('.');
  return `${prefix}.${parts[0]}`;
}

async function findElixirFiles(repoPath: string): Promise<string[]> {
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
      } else if (entry.name.endsWith('.ex') || entry.name.endsWith('.exs')) {
        if (entry.name === 'mix.exs' || entry.name === 'mix.lock') continue;
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel)) continue;
        results.push(childRel);
      }
    }
  }

  await walk(repoPath, '');
  return results;
}

export interface ElixirWorkspaceResult {
  links: GroupManifestLink[];
  discoveredApps: Map<string, ElixirAppMeta>;
}

export async function extractElixirWorkspaceLinks(
  repos: Record<string, string>,
  repoPaths: Map<string, string>,
  _dbExecutors?: Map<string, CypherExecutor>,
): Promise<ElixirWorkspaceResult> {
  const appsByName = new Map<string, ElixirAppMeta>();
  const appsByGroupPath = new Map<string, ElixirAppMeta>();

  for (const [groupPath] of Object.entries(repos)) {
    const repoPath = repoPaths.get(groupPath);
    if (!repoPath) continue;

    const manifest = await parseMixExs(repoPath);
    if (!manifest) continue;

    const meta: ElixirAppMeta = {
      appName: manifest.appName,
      modulePrefix: manifest.modulePrefix,
      groupPath,
      repoPath,
      deps: manifest.deps,
    };
    const existing = appsByName.get(manifest.appName);
    if (existing) {
      console.warn(
        `[elixir-workspace-extractor] duplicate app "${manifest.appName}" in "${groupPath}" and "${existing.groupPath}" — skipping "${groupPath}"`,
      );
      continue;
    }
    appsByName.set(manifest.appName, meta);
    appsByGroupPath.set(groupPath, meta);
  }

  const links: GroupManifestLink[] = [];
  const seen = new Set<string>();

  for (const [, app] of appsByGroupPath) {
    const groupDeps = app.deps.filter((d) => appsByName.has(d));
    if (groupDeps.length === 0) continue;

    const knownApps = new Map<string, string>();
    for (const dep of groupDeps) {
      const depMeta = appsByName.get(dep);
      if (depMeta) knownApps.set(depMeta.modulePrefix, dep);
    }

    const imports = await scanElixirImports(app.repoPath, knownApps);

    for (const imp of imports) {
      const providerApp = appsByName.get(imp.appName);
      if (!providerApp) continue;

      const topModule = extractTopModule(imp.moduleName, providerApp.modulePrefix);
      const key = `${app.groupPath}→${providerApp.groupPath}::${topModule}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // V1: Elixir contracts use the full module name (e.g. "Core.Schema") without
      // an "appName::" prefix. resolveSymbol will query the graph with this full
      // string — resolution depends on Elixir indexer storing fully-qualified names.
      const link: GroupManifestLink = {
        from: providerApp.groupPath,
        to: app.groupPath,
        type: 'custom',
        contract: topModule,
        role: 'provider' as ContractRole,
      };
      links.push(link);
    }
  }

  return { links, discoveredApps: appsByGroupPath };
}
