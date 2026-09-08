/**
 * Per-workspace Objective-C import config — the analog of TypeScript's
 * tsconfig, C#'s csproj scan, and C/C++'s header scan.
 *
 * Loaded once per analyze pass via `objectiveCScopeResolver.loadResolutionConfig`
 * and threaded into `resolveObjectiveCImportTarget`. `.h` files are usually
 * classified as C++ unless they contain Objective-C syntax, so the ObjC
 * resolver's `allFilePaths` can miss headers that `#import` / `#include`
 * still name. This scan is what makes those paths visible.
 */

import { readdirSync, readFileSync, type Dirent } from 'fs';
import { join, relative } from 'path';
import { clearObjectiveCFileFacts } from './facts.js';

const HEADER_EXTENSIONS = new Set(['.h']);
const MODULE_MAP_NAMES = new Set(['module.modulemap', 'module.map']);

export interface ObjectiveCResolutionConfig {
  /** Repo-relative `.h` paths discovered on disk (C/C++ header-scan analog). */
  readonly headers: ReadonlySet<string>;
  /**
   * xcconfig `HEADER_SEARCH_PATHS`. Used for both quoted and angle-bracket
   * imports — clang's system/project include path.
   */
  readonly headerSearchPaths: readonly string[];
  /**
   * xcconfig `USER_HEADER_SEARCH_PATHS` plus in-repo `Headers` / `include`
   * roots. Quoted `#import "…"` only. Angle-bracket imports must not use
   * these, or `<Foundation/Foundation.h>` would bind a local decoy.
   */
  readonly userHeaderSearchPaths: readonly string[];
  /** Framework name → repo-relative `*.framework/Headers` directory. */
  readonly frameworks: ReadonlyMap<string, string>;
  /** `@import` module name → umbrella / first header path. */
  readonly modules: ReadonlyMap<string, string>;
}

export function emptyObjectiveCResolutionConfig(): ObjectiveCResolutionConfig {
  return {
    headers: new Set(),
    headerSearchPaths: [],
    userHeaderSearchPaths: [],
    frameworks: new Map(),
    modules: new Map(),
  };
}

export function coerceObjectiveCResolutionConfig(
  value: unknown,
): ObjectiveCResolutionConfig | undefined {
  if (value == null) return undefined;
  if (value instanceof Set) {
    return {
      headers: value as ReadonlySet<string>,
      headerSearchPaths: [],
      userHeaderSearchPaths: [],
      frameworks: new Map(),
      modules: new Map(),
    };
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Partial<ObjectiveCResolutionConfig>;
  if (record.headers === undefined) return undefined;
  return {
    headers: record.headers,
    headerSearchPaths: record.headerSearchPaths ?? [],
    userHeaderSearchPaths: record.userHeaderSearchPaths ?? [],
    frameworks: record.frameworks ?? new Map(),
    modules: record.modules ?? new Map(),
  };
}

export function loadObjectiveCResolutionConfig(repoPath: string): ObjectiveCResolutionConfig {
  // Worker capture facts are process-local and outlive a single analysis in
  // server mode. This hook runs once before each Objective-C workspace pass,
  // before ParsedFile side channels are restored for the current files.
  clearObjectiveCFileFacts();
  return scanObjectiveCWorkspace(repoPath);
}

export function scanObjectiveCWorkspace(repoPath: string): ObjectiveCResolutionConfig {
  const headers = new Set<string>();
  const frameworks = new Map<string, string>();
  const moduleMapPaths: string[] = [];
  const xcconfigPaths: string[] = [];
  const implicitSearchRoots = new Set<string>();

  walk(repoPath, repoPath, {
    headers,
    frameworks,
    moduleMapPaths,
    xcconfigPaths,
    implicitSearchRoots,
  });

  const xcconfig = { headerSearchPaths: [] as string[], userHeaderSearchPaths: [] as string[] };
  for (const filePath of xcconfigPaths) {
    const parsed = parseXcconfigSearchPaths(readText(join(repoPath, filePath)));
    xcconfig.headerSearchPaths.push(...parsed.headerSearchPaths);
    xcconfig.userHeaderSearchPaths.push(...parsed.userHeaderSearchPaths);
  }
  const headerSearchPaths = uniquePaths(xcconfig.headerSearchPaths);
  const userHeaderSearchPaths = uniquePaths([
    ...implicitSearchRoots,
    ...xcconfig.userHeaderSearchPaths,
  ]);

  const modules = new Map<string, string>();
  for (const mapPath of moduleMapPaths) {
    for (const [name, header] of parseModuleMap(
      readText(join(repoPath, mapPath)),
      dirnamePosix(mapPath),
    )) {
      if (!modules.has(name)) modules.set(name, header);
    }
  }

  return { headers, headerSearchPaths, userHeaderSearchPaths, frameworks, modules };
}

interface ScanSink {
  readonly headers: Set<string>;
  readonly frameworks: Map<string, string>;
  readonly moduleMapPaths: string[];
  readonly xcconfigPaths: string[];
  readonly implicitSearchRoots: Set<string>;
}

function walk(dir: string, root: string, sink: ScanSink): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(name)) continue;
      const relativeDir = normalizeRepoPath(relative(root, full));
      if (name.endsWith('.framework')) {
        const frameworkName = name.slice(0, -'.framework'.length);
        if (frameworkName.length > 0 && !sink.frameworks.has(frameworkName)) {
          sink.frameworks.set(frameworkName, `${relativeDir}/Headers`);
        }
      }
      if (name === 'Headers' || name === 'include') {
        sink.implicitSearchRoots.add(relativeDir);
      }
      walk(full, root, sink);
    } else if (entry.isFile()) {
      const relativePath = normalizeRepoPath(relative(root, full));
      const ext = name.slice(name.lastIndexOf('.'));
      if (HEADER_EXTENSIONS.has(ext)) sink.headers.add(relativePath);
      if (MODULE_MAP_NAMES.has(name)) sink.moduleMapPaths.push(relativePath);
      if (ext === '.xcconfig') sink.xcconfigPaths.push(relativePath);
    }
  }
}

function shouldSkipDirectory(name: string): boolean {
  return (
    name === 'node_modules' ||
    name === '.git' ||
    name === 'vendor' ||
    name === 'dist' ||
    name === 'build' ||
    name === 'out' ||
    name === 'target' ||
    name === '_build' ||
    name === '.next' ||
    name === 'DerivedData' ||
    name === 'xcuserdata' ||
    name === '.build' ||
    name === 'Pods' ||
    name === 'Carthage' ||
    name.startsWith('cmake-build')
  );
}

export function parseXcconfigSearchPaths(source: string): {
  readonly headerSearchPaths: string[];
  readonly userHeaderSearchPaths: string[];
} {
  const headerSearchPaths: string[] = [];
  const userHeaderSearchPaths: string[] = [];
  const joined = source.replace(/\\\r?\n/g, ' ');
  for (const rawLine of joined.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (line.length === 0) continue;
    const match = /^(HEADER_SEARCH_PATHS|USER_HEADER_SEARCH_PATHS)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const sink =
      match[1] === 'USER_HEADER_SEARCH_PATHS' ? userHeaderSearchPaths : headerSearchPaths;
    for (const token of tokenizeXcconfigValue(match[2] ?? '')) {
      const resolved = expandXcconfigPath(token);
      if (resolved !== undefined) sink.push(resolved);
    }
  }
  return { headerSearchPaths, userHeaderSearchPaths };
}

function tokenizeXcconfigValue(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch ?? '')) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function expandXcconfigPath(token: string): string | undefined {
  if (token === '$(inherited)' || token === '$inherited') return undefined;
  if (/\$\((SDKROOT|DEVELOPER_DIR|PLATFORM_DIR|TOOLCHAIN_DIR)\)/.test(token)) return undefined;
  const expanded = token
    .replace(/\$\((SRCROOT|PROJECT_DIR)\)\/?/g, '')
    .replace(/\/\*\*?$/, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (expanded.startsWith('$') || expanded.startsWith('/')) return undefined;
  return collapseRepoPath(expanded);
}

export function parseModuleMap(
  source: string,
  mapDir: string,
): ReadonlyArray<readonly [string, string]> {
  const modules: Array<readonly [string, string]> = [];
  const blocks = /(?:framework\s+)?module\s+([A-Za-z_][\w.]*)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  for (const match of source.matchAll(blocks)) {
    const name = match[1];
    const body = match[2] ?? '';
    if (name === undefined || name === '*') continue;
    const header =
      /umbrella\s+header\s+"([^"]+)"/.exec(body)?.[1] ??
      /umbrella\s+"([^"]+)"/.exec(body)?.[1] ??
      /header\s+"([^"]+)"/.exec(body)?.[1];
    if (header === undefined) continue;
    modules.push([name, collapseRepoPath(resolveModuleMapHeader(mapDir, header))]);
  }
  return modules;
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function dirnamePosix(filePath: string): string {
  const normalized = normalizeRepoPath(filePath);
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? '' : normalized.slice(0, slash);
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const normalized = normalizeRepoPath(path);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function normalizeRepoPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** Collapse `.` / `..` in scanned config paths. Import targets stay raw. */
export function collapseRepoPath(value: string): string {
  const parts = normalizeRepoPath(value).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function resolveModuleMapHeader(mapDir: string, header: string): string {
  const direct = collapseRepoPath(joinPosix(mapDir, header));
  const frameworkRoot = frameworkRootFromModulesDir(mapDir);
  if (frameworkRoot === undefined) return direct;
  const base = header.slice(header.replaceAll('\\', '/').lastIndexOf('/') + 1);
  return collapseRepoPath(joinPosix(`${frameworkRoot}/Headers`, base));
}

function frameworkRootFromModulesDir(mapDir: string): string | undefined {
  if (mapDir === 'Modules') return undefined;
  if (!mapDir.endsWith('/Modules')) return undefined;
  const parent = mapDir.slice(0, -'/Modules'.length);
  return parent.endsWith('.framework') ? parent : undefined;
}

function joinPosix(left: string, right: string): string {
  if (left.length === 0) return right;
  return `${left}/${right}`;
}
