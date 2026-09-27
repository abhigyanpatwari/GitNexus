/**
 * Per-workspace C/C++ include config — the analog of Objective-C's header
 * scan plus the project files clangd already reads.
 *
 * Loaded once per analyze pass and threaded into `resolveCImportTarget`.
 * `#include <stdio.h>` joins the target onto `headerSearchPaths` and never
 * suffix-matches a same-named file under `src/`. `#include "util.h"` may
 * still look next to the importer and in the basename index.
 *
 * Config is read in every directory, not only the root, and a file takes
 * the nearest one — how clangd finds `compile_commands.json` and
 * `compile_flags.txt` in a monorepo. CMake `include_directories` and
 * `target_include_directories` are read too. Make, Meson, and Bazel are not
 * parsed; `compile_commands.json` is the compilation database they emit.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { load as loadYaml } from 'js-yaml';

export const C_HEADER_EXTENSIONS: ReadonlySet<string> = new Set(['.h']);
export const CPP_HEADER_EXTENSIONS: ReadonlySet<string> = new Set([
  '.h',
  '.hpp',
  '.hxx',
  '.hh',
  '.cuh',
]);

const IMPLICIT_INCLUDE_DIRECTORIES = new Set(['include', 'Headers', 'inc']);

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '_build',
  '.next',
  'debug',
  'release',
  'bazel-out',
  'bazel-bin',
  'bazel-testlogs',
  'buck-out',
]);

/** clangd's well-known locations. One file each — the build tree is not walked. */
const COMPILE_COMMANDS_CANDIDATES = [
  'compile_commands.json',
  '.vscode/compile_commands.json',
  'build/compile_commands.json',
  'out/compile_commands.json',
  'debug/compile_commands.json',
  'release/compile_commands.json',
];

/** Include roots for one translation unit, or for files with no database entry. */
export interface CTranslationUnitPaths {
  /** `-I` / `-isystem` / `/I`. Implicit `include` / `Headers` / `inc` only when nothing is declared. */
  readonly headerSearchPaths: readonly string[];
  /** `-iquote`. Quoted includes only. */
  readonly userHeaderSearchPaths: readonly string[];
}

const EMPTY_TRANSLATION_UNITS: ReadonlyMap<string, CTranslationUnitPaths> = new Map();
const EMPTY_DIRECTORY_SCOPES: ReadonlyMap<string, CTranslationUnitPaths> = new Map();

export interface CFamilyResolutionConfig {
  /** In-repo headers the scan found. Build trees are not included. */
  readonly headers: ReadonlySet<string>;
  /**
   * Roots for a file that has no `compile_commands.json` entry.
   * Another translation unit's `-I` list is not copied here.
   */
  readonly headerSearchPaths: readonly string[];
  /** `-iquote` roots for a file that has no compilation-database entry. */
  readonly userHeaderSearchPaths: readonly string[];
  /**
   * Per source file, keyed by repo-relative path. Built once per pass.
   * Lookup is a map read; the lists are not rebuilt per include.
   */
  readonly translationUnits: ReadonlyMap<string, CTranslationUnitPaths>;
  /**
   * Roots for a file with no database entry below the repo root, keyed by the
   * directory whose config (or CMakeLists.txt) set them. A file takes its
   * nearest ancestor's entry, else the top-level lists.
   */
  readonly directoryScopes: ReadonlyMap<string, CTranslationUnitPaths>;
}

export function coerceCFamilyResolutionConfig(value: unknown): CFamilyResolutionConfig | undefined {
  if (value == null) return undefined;
  if (value instanceof Set) {
    return {
      headers: value as ReadonlySet<string>,
      headerSearchPaths: [],
      userHeaderSearchPaths: [],
      translationUnits: EMPTY_TRANSLATION_UNITS,
      directoryScopes: EMPTY_DIRECTORY_SCOPES,
    };
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Partial<CFamilyResolutionConfig>;
  if (!(record.headers instanceof Set)) return undefined;
  return {
    headers: record.headers,
    headerSearchPaths: record.headerSearchPaths ?? [],
    userHeaderSearchPaths: record.userHeaderSearchPaths ?? [],
    translationUnits:
      record.translationUnits instanceof Map ? record.translationUnits : EMPTY_TRANSLATION_UNITS,
    directoryScopes:
      record.directoryScopes instanceof Map ? record.directoryScopes : EMPTY_DIRECTORY_SCOPES,
  };
}

/**
 * The file set a resolver should hand to the include lookup.
 *
 * `augment` is the language's own per-pass memo (`augmentedFilePathsFor`).
 * When there is nothing to union, `allFilePaths` is returned as the same
 * object — a copy would be a new memo key on every include.
 */
export function cFamilyImportFiles(
  allFilePaths: ReadonlySet<string>,
  resolutionConfig: unknown,
  augment: (headers: ReadonlySet<string>) => ReadonlySet<string>,
): { readonly files: ReadonlySet<string>; readonly config: CFamilyResolutionConfig | undefined } {
  const config = coerceCFamilyResolutionConfig(resolutionConfig);
  const headers = config?.headers;
  const files = headers !== undefined && headers.size > 0 ? augment(headers) : allFilePaths;
  return { files, config };
}

export function scanCFamilyHeaders(
  repoPath: string,
  headerExtensions: ReadonlySet<string>,
): {
  readonly headers: ReadonlySet<string>;
  readonly implicitRoots: readonly string[];
  readonly configDirectories: readonly string[];
} {
  const headers = new Set<string>();
  const implicit: string[] = [];
  const configDirectories: string[] = [];
  walk(repoPath, repoPath, headerExtensions, headers, implicit, configDirectories);
  return { headers, implicitRoots: sortByDepth(implicit), configDirectories };
}

/** What a directory hands down to its subdirectories, clangd- and CMake-style. */
interface InheritedScope {
  /** Nearest `compile_flags.txt` / `.ccls` / `includePath`. Empty under a database. */
  readonly flagHeader: readonly string[];
  readonly flagUser: readonly string[];
  /** `.clangd` `CompileFlags.Add` from every ancestor, outermost first. */
  readonly clangdHeader: readonly string[];
  readonly clangdUser: readonly string[];
  /** `include_directories` and PRIVATE / PUBLIC target roots from ancestor CMakeLists. */
  readonly cmake: readonly string[];
  /** Absolute dirs for `${PROJECT_SOURCE_DIR}` and `${CMAKE_SOURCE_DIR}`. */
  readonly projectDir: string;
  readonly cmakeRootDir: string | undefined;
}

export function loadCFamilyResolutionConfig(
  repoPath: string,
  headerExtensions: ReadonlySet<string>,
): CFamilyResolutionConfig {
  const { headers, implicitRoots, configDirectories } = scanCFamilyHeaders(
    repoPath,
    headerExtensions,
  );

  const rootScope: InheritedScope = {
    flagHeader: [],
    flagUser: [],
    clangdHeader: [],
    clangdUser: [],
    cmake: [],
    projectDir: repoPath,
    cmakeRootDir: undefined,
  };
  const scopes = new Map<string, InheritedScope>([['', rootScope]]);
  const cmakeGlobal: string[] = [];
  const databases: { readonly depth: number; readonly units: ParsedUnits }[] = [];
  const parsedDatabases = new Map<string, ParsedUnits | undefined>();

  // Pre-order: every parent is settled before its children.
  for (const dir of configDirectories) {
    const parent = nearestScope(scopes, dir) ?? rootScope;
    const dirAbs = dir.length === 0 ? repoPath : join(repoPath, dir);

    const clangd = readClangd(dirAbs);
    const vscode = readVscodeProperties(dirAbs, repoPath);
    const database = findCompileCommands(
      dirAbs,
      repoPath,
      clangd.databaseDir,
      vscode.compileCommands,
    );
    // Two directories can point at one database; parse it once, still honor it in both.
    let parsed: ParsedUnits | undefined;
    if (database !== undefined) {
      const seen = parsedDatabases.has(database);
      parsed = seen ? parsedDatabases.get(database) : parseCompileCommands(database, repoPath);
      parsedDatabases.set(database, parsed);
      if (!seen && parsed !== undefined) databases.push({ depth: depthOf(dir), units: parsed });
    }

    const clangdHeader = [...parent.clangdHeader];
    const clangdUser = [...parent.clangdUser];
    collectIncludeArgs(clangd.add, dirAbs, repoPath, clangdHeader, clangdUser);

    // clangd: the nearest directory with a database or flag file wins, and a
    // database beats a flag file in the same directory. A file the database
    // does not list gets no flags from here — not an ancestor's flag file.
    let flagHeader = parent.flagHeader;
    let flagUser = parent.flagUser;
    if (parsed !== undefined) {
      flagHeader = [];
      flagUser = [];
    } else {
      const header: string[] = [];
      const user: string[] = [];
      for (const includePath of vscode.includePaths) {
        const rel = toRepoRelative(includePath, dirAbs, repoPath);
        if (rel !== undefined) header.push(rel);
      }
      const hasFlags = collectFlagFile(
        join(dirAbs, 'compile_flags.txt'),
        dirAbs,
        repoPath,
        header,
        user,
      );
      const hasCcls = collectFlagFile(join(dirAbs, '.ccls'), dirAbs, repoPath, header, user);
      const hasFlagFile = hasFlags || hasCcls || vscode.includePaths.length > 0;
      if (hasFlagFile) {
        flagHeader = header;
        flagUser = user;
      }
    }

    const cmake = readCMakeLists(dirAbs, repoPath, parent);
    cmakeGlobal.push(...cmake.global);

    scopes.set(dir, {
      flagHeader,
      flagUser,
      clangdHeader,
      clangdUser,
      cmake: cmake.scoped.length === 0 ? parent.cmake : [...parent.cmake, ...cmake.scoped],
      projectDir: cmake.projectDir ?? parent.projectDir,
      cmakeRootDir: parent.cmakeRootDir ?? cmake.cmakeRootDir,
    });
  }

  // Declared roots win. The implicit `include/` guess is only for a file no
  // config speaks for; the compiler would not search those directories either.
  const finish = (scope: InheritedScope): CTranslationUnitPaths => {
    const header = uniquePaths([
      ...scope.flagHeader,
      ...scope.clangdHeader,
      ...scope.cmake,
      ...cmakeGlobal,
    ]);
    return {
      headerSearchPaths: header.length > 0 ? header : implicitRoots,
      userHeaderSearchPaths: uniquePaths([...scope.flagUser, ...scope.clangdUser]),
    };
  };

  const directoryScopes = new Map<string, CTranslationUnitPaths>();
  for (const [dir, scope] of scopes) {
    if (dir.length > 0) directoryScopes.set(dir, finish(scope));
  }

  // The nearest database lists a file first; a shallower one does not override it.
  const translationUnits = new Map<string, CTranslationUnitPaths>();
  databases.sort((left, right) => right.depth - left.depth);
  for (const { units } of databases) {
    for (const [file, paths] of units) {
      if (translationUnits.has(file)) continue;
      const scope = nearestScope(scopes, file) ?? rootScope;
      translationUnits.set(file, {
        headerSearchPaths: uniquePaths([...paths.header, ...scope.clangdHeader]),
        userHeaderSearchPaths: uniquePaths([...paths.user, ...scope.clangdUser]),
      });
    }
  }

  const root = finish(scopes.get('') ?? rootScope);
  return {
    headers,
    headerSearchPaths: root.headerSearchPaths,
    userHeaderSearchPaths: root.userHeaderSearchPaths,
    translationUnits,
    directoryScopes,
  };
}

/** The scope of the deepest directory at or above `path`'s directory. */
export function nearestScope<T>(scopes: ReadonlyMap<string, T>, path: string): T | undefined {
  let dir = parentDirectory(normalizeRepoPath(path));
  for (;;) {
    const scope = scopes.get(dir);
    if (scope !== undefined) return scope;
    if (dir.length === 0) return undefined;
    dir = parentDirectory(dir);
  }
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function depthOf(dir: string): number {
  return dir.length === 0 ? 0 : dir.split('/').length;
}

/** Shallower include roots first, then lexicographic. `deps/include` must not beat `include`. */
function sortByDepth(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => {
    const leftDepth = depthOf(left);
    const rightDepth = depthOf(right);
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

/** Entries that make a directory worth reading config from. Build dirs may hold a database. */
const CONFIG_FILE_NAMES = new Set([
  'compile_commands.json',
  'compile_flags.txt',
  '.ccls',
  '.clangd',
  'CMakeLists.txt',
]);
const DATABASE_DIRECTORY_NAMES = new Set(['.vscode', 'build', 'out', 'debug', 'release']);

function walk(
  dir: string,
  root: string,
  headerExtensions: ReadonlySet<string>,
  headers: Set<string>,
  implicit: string[],
  configDirectories: string[],
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }
  const relativeHere = normalizeRepoPath(relative(root, dir));
  if (
    entries.some((entry) =>
      entry.isDirectory()
        ? DATABASE_DIRECTORY_NAMES.has(entry.name)
        : CONFIG_FILE_NAMES.has(entry.name),
    )
  ) {
    configDirectories.push(relativeHere);
  }
  for (const entry of entries) {
    const name = entry.name;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(name)) continue;
      const relativeDir = normalizeRepoPath(relative(root, full));
      if (IMPLICIT_INCLUDE_DIRECTORIES.has(name)) implicit.push(relativeDir);
      walk(full, root, headerExtensions, headers, implicit, configDirectories);
    } else if (entry.isFile()) {
      const dot = name.lastIndexOf('.');
      const ext = dot === -1 ? '' : name.slice(dot);
      if (headerExtensions.has(ext)) {
        headers.add(normalizeRepoPath(relative(root, full)));
      }
    }
  }
}

function shouldSkipDirectory(name: string): boolean {
  return SKIP_DIRECTORIES.has(name) || name.startsWith('cmake-build');
}

function findCompileCommands(
  dirAbs: string,
  repoPath: string,
  clangdDatabaseDir: string | undefined,
  vscodeCompileCommands: string | undefined,
): string | undefined {
  if (clangdDatabaseDir !== undefined) {
    const pointed = compileCommandsFile(dirAbs, repoPath, clangdDatabaseDir);
    if (pointed !== undefined) return pointed;
  }
  for (const rel of COMPILE_COMMANDS_CANDIDATES) {
    const full = join(dirAbs, rel);
    if (existsSync(full)) return full;
  }
  if (vscodeCompileCommands !== undefined && existsSync(vscodeCompileCommands)) {
    return vscodeCompileCommands;
  }
  return undefined;
}

function compileCommandsFile(
  dirAbs: string,
  repoPath: string,
  databaseDir: string,
): string | undefined {
  const rel = toRepoRelative(databaseDir, dirAbs, repoPath);
  if (rel === undefined) return undefined;
  const full = join(repoPath, rel, 'compile_commands.json');
  return existsSync(full) ? full : undefined;
}

interface ClangdFlags {
  readonly add: readonly string[];
  readonly databaseDir?: string;
}

function readClangd(dirAbs: string): ClangdFlags {
  const text = readText(join(dirAbs, '.clangd'));
  if (text.length === 0) return { add: [] };
  let doc: unknown;
  try {
    doc = loadYaml(text);
  } catch {
    return { add: [] };
  }
  if (doc === null || typeof doc !== 'object') return { add: [] };
  const record = doc as { CompileFlags?: { Add?: unknown }; CompilationDatabase?: unknown };
  const databaseDir =
    typeof record.CompilationDatabase === 'string' ? record.CompilationDatabase : undefined;
  return { add: clangdAddFlags(record.CompileFlags?.Add), databaseDir };
}

function clangdAddFlags(add: unknown): string[] {
  if (typeof add === 'string') return splitCommand(add);
  if (!Array.isArray(add)) return [];
  return add.filter((flag): flag is string => typeof flag === 'string');
}

interface VscodeProperties {
  readonly includePaths: readonly string[];
  readonly compileCommands?: string;
}

function readVscodeProperties(dirAbs: string, repoPath: string): VscodeProperties {
  const text = readText(join(dirAbs, '.vscode', 'c_cpp_properties.json'));
  if (text.length === 0) return { includePaths: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { includePaths: [] };
  }
  if (doc === null || typeof doc !== 'object') return { includePaths: [] };
  const configurations = (doc as { configurations?: unknown }).configurations;
  if (!Array.isArray(configurations)) return { includePaths: [] };

  const includePaths: string[] = [];
  let compileCommands: string | undefined;
  for (const configuration of configurations) {
    if (configuration === null || typeof configuration !== 'object') continue;
    const record = configuration as { includePath?: unknown; compileCommands?: unknown };
    if (Array.isArray(record.includePath)) {
      for (const entry of record.includePath) {
        if (typeof entry === 'string') includePaths.push(entry);
      }
    }
    if (compileCommands === undefined && typeof record.compileCommands === 'string') {
      const resolved = resolvePointedPath(record.compileCommands, dirAbs, repoPath);
      if (resolved !== undefined) compileCommands = resolved;
    }
  }
  return { includePaths, compileCommands };
}

function resolvePointedPath(raw: string, dirAbs: string, repoPath: string): string | undefined {
  const rel = toRepoRelative(raw, dirAbs, repoPath);
  if (rel === undefined) return undefined;
  return rel.length === 0 ? repoPath : join(repoPath, rel);
}

const CMAKE_INCLUDE_COMMAND =
  /(?:^|[^\w])(include_directories|target_include_directories)\s*\(([^)]*)\)/gi;
const CMAKE_PROJECT_COMMAND = /(?:^|[^\w])project\s*\(/i;
const CMAKE_ORDER_KEYWORDS = new Set(['SYSTEM', 'BEFORE', 'AFTER']);

/**
 * Include roots one CMakeLists.txt declares.
 *
 * `include_directories` and PRIVATE target roots reach this directory's
 * subtree. PUBLIC and INTERFACE roots are what dependents compile with.
 * ponytail: no target_link_libraries graph, so PUBLIC/INTERFACE roots reach
 * every file; follow links per target if a monorepo needs dependents only.
 * A path left with `${VAR}` or a generator expression is dropped, not guessed.
 */
function readCMakeLists(
  dirAbs: string,
  repoPath: string,
  parent: InheritedScope,
): {
  readonly scoped: readonly string[];
  readonly global: readonly string[];
  readonly projectDir: string | undefined;
  readonly cmakeRootDir: string | undefined;
} {
  const text = readText(join(dirAbs, 'CMakeLists.txt'));
  if (text.length === 0) {
    return { scoped: [], global: [], projectDir: undefined, cmakeRootDir: undefined };
  }
  const source = text.replace(/#[^\n]*/g, '');
  const projectDir = CMAKE_PROJECT_COMMAND.test(source) ? dirAbs : undefined;
  const variables = new Map<string, string>([
    ['CMAKE_CURRENT_SOURCE_DIR', dirAbs],
    ['CMAKE_CURRENT_LIST_DIR', dirAbs],
    ['PROJECT_SOURCE_DIR', projectDir ?? parent.projectDir],
    ['CMAKE_SOURCE_DIR', parent.cmakeRootDir ?? dirAbs],
  ]);

  const scoped: string[] = [];
  const global: string[] = [];
  for (const match of source.matchAll(CMAKE_INCLUDE_COMMAND)) {
    const isTarget = match[1]?.toLowerCase() === 'target_include_directories';
    const args = [...(match[2] ?? '').matchAll(/"([^"]*)"|(\S+)/g)].map(
      (arg) => arg[1] ?? arg[2] ?? '',
    );
    let visibility = 'PRIVATE';
    for (const arg of isTarget ? args.slice(1) : args) {
      if (CMAKE_ORDER_KEYWORDS.has(arg)) continue;
      if (arg === 'PUBLIC' || arg === 'PRIVATE' || arg === 'INTERFACE') {
        visibility = arg;
        continue;
      }
      const expanded = expandCMakePath(arg, variables);
      if (expanded === undefined) continue;
      const rel = toRepoRelative(expanded, dirAbs, repoPath);
      if (rel === undefined) continue;
      if (visibility !== 'INTERFACE') scoped.push(rel);
      if (isTarget && visibility !== 'PRIVATE') global.push(rel);
    }
  }
  return { scoped, global, projectDir, cmakeRootDir: dirAbs };
}

function expandCMakePath(
  token: string,
  variables: ReadonlyMap<string, string>,
): string | undefined {
  const buildInterface = /^\$<BUILD_INTERFACE:(.*)>$/.exec(token);
  const path = buildInterface?.[1] ?? token;
  if (path.includes('$<')) return undefined;
  return path.replace(/\$\{(\w+)\}/g, (whole, name: string) => variables.get(name) ?? whole);
}

type ParsedUnits = Map<string, { header: string[]; user: string[] }>;

/**
 * Per-file include roots. `undefined` means the file exists but is not a
 * usable compilation database, so callers must fall through to flag files.
 */
function parseCompileCommands(filePath: string, repoPath: string): ParsedUnits | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(filePath));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const units: ParsedUnits = new Map();
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as {
      directory?: unknown;
      command?: unknown;
      arguments?: unknown;
      file?: unknown;
    };
    if (typeof record.file !== 'string' || record.file.length === 0) continue;
    const args = Array.isArray(record.arguments)
      ? record.arguments.filter((arg): arg is string => typeof arg === 'string')
      : typeof record.command === 'string'
        ? splitCommand(record.command)
        : [];
    const directory = typeof record.directory === 'string' ? record.directory : repoPath;
    const base = isAbsolute(directory) ? directory : join(repoPath, directory);
    const fileRel = toRepoRelative(record.file, base, repoPath);
    // First entry for a file wins. A later command must not merge its -I list in.
    if (fileRel === undefined || units.has(fileRel)) continue;
    const header: string[] = [];
    const user: string[] = [];
    collectIncludeArgs(args, base, repoPath, header, user);
    units.set(fileRel, { header, user });
  }
  return units;
}

/** Reads one flag file. Returns whether it exists, so an empty one still claims its directory. */
function collectFlagFile(
  filePath: string,
  baseDir: string,
  repoPath: string,
  header: string[],
  user: string[],
): boolean {
  if (!existsSync(filePath)) return false;
  const text = readText(filePath);
  const args: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('%')) continue;
    args.push(line);
  }
  collectIncludeArgs(args, baseDir, repoPath, header, user);
  return true;
}

function collectIncludeArgs(
  args: readonly string[],
  baseDir: string,
  repoPath: string,
  header: string[],
  user: string[],
): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const eaten = takeIncludeFlag(arg, args[i + 1]);
    if (eaten === undefined) continue;
    if (eaten.consumedNext) i++;
    const rel = toRepoRelative(eaten.path, baseDir, repoPath);
    if (rel === undefined) continue;
    (eaten.quotedOnly ? user : header).push(rel);
  }
}

function takeIncludeFlag(
  arg: string,
  next: string | undefined,
):
  | { readonly path: string; readonly quotedOnly: boolean; readonly consumedNext: boolean }
  | undefined {
  if (arg === '-I' || arg === '-isystem' || arg === '/I' || arg === '-iquote') {
    if (next === undefined || next.startsWith('-')) return undefined;
    return { path: next, quotedOnly: arg === '-iquote', consumedNext: true };
  }
  if (arg.startsWith('-I')) {
    return { path: arg.slice(2), quotedOnly: false, consumedNext: false };
  }
  if (arg.startsWith('/I') && arg.length > 2) {
    return { path: arg.slice(2), quotedOnly: false, consumedNext: false };
  }
  if (arg.startsWith('-isystem') && arg.length > '-isystem'.length) {
    return { path: arg.slice('-isystem'.length), quotedOnly: false, consumedNext: false };
  }
  if (arg.startsWith('-iquote') && arg.length > '-iquote'.length) {
    return { path: arg.slice('-iquote'.length), quotedOnly: true, consumedNext: false };
  }
  return undefined;
}

/** Split a compiler command the way `arguments` already is. Quotes are kept out of the tokens. */
function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      const next = command[i + 1];
      // A Windows path separator is not a shell escape. Only drop the
      // backslash when it quotes the next character.
      if (next === '"' || next === "'" || next === '\\' || next === ' ' || next === '\t') {
        current += next;
        i++;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch ?? '';
  }
  if (current.length > 0) args.push(current);
  return args;
}

function toRepoRelative(rawPath: string, baseDir: string, repoPath: string): string | undefined {
  let raw = normalizeRepoPath(rawPath.trim());
  if (raw.length === 0) return undefined;
  raw = raw.replaceAll('${workspaceFolder}', '.').replaceAll('${workspaceRoot}', '.');
  if (raw.includes('${') || raw.includes('$(')) return undefined;
  raw = raw.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
  if (raw.length === 0) raw = '.';

  const absolute = isAbsolute(raw) || /^[A-Za-z]:/.test(raw) ? raw : join(baseDir, raw);
  const rel = normalizeRepoPath(relative(repoPath, resolve(absolute)));
  // `..headers` is a directory inside the repo. Only `..` and `../…` leave it.
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return undefined;
  return collapseRepoPath(rel);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

export function normalizeRepoPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** Collapse `.` / `..` in a repo-relative path. `..` past the root is a miss, not a clipped path. */
export function collapseRepoPath(value: string): string | undefined {
  const parts = normalizeRepoPath(value).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}
