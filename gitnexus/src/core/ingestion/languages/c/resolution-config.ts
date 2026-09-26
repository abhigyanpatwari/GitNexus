/**
 * Per-workspace C/C++ include config — the analog of Objective-C's header
 * scan plus the project files clangd already reads.
 *
 * Loaded once per analyze pass and threaded into `resolveCImportTarget`.
 * `#include <stdio.h>` joins the target onto `headerSearchPaths` and never
 * suffix-matches a same-named file under `src/`. `#include "util.h"` may
 * still look next to the importer and in the basename index.
 *
 * CMake, Make, Meson, and Bazel are not parsed. `compile_commands.json` is
 * the compilation database those tools already emit.
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
  /** `-I` / `-isystem` / `/I`, then implicit `include` / `Headers` / `inc`. */
  readonly headerSearchPaths: readonly string[];
  /** `-iquote`. Quoted includes only. */
  readonly userHeaderSearchPaths: readonly string[];
}

const EMPTY_TRANSLATION_UNITS: ReadonlyMap<string, CTranslationUnitPaths> = new Map();

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
}

export function coerceCFamilyResolutionConfig(value: unknown): CFamilyResolutionConfig | undefined {
  if (value == null) return undefined;
  if (value instanceof Set) {
    return {
      headers: value as ReadonlySet<string>,
      headerSearchPaths: [],
      userHeaderSearchPaths: [],
      translationUnits: EMPTY_TRANSLATION_UNITS,
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
): { readonly headers: ReadonlySet<string>; readonly implicitRoots: readonly string[] } {
  const headers = new Set<string>();
  const implicit: string[] = [];
  walk(repoPath, repoPath, headerExtensions, headers, implicit);
  return { headers, implicitRoots: sortByDepth(implicit) };
}

export function loadCFamilyResolutionConfig(
  repoPath: string,
  headerExtensions: ReadonlySet<string>,
): CFamilyResolutionConfig {
  const { headers, implicitRoots } = scanCFamilyHeaders(repoPath, headerExtensions);

  const clangd = readClangd(repoPath);
  const vscode = readVscodeProperties(repoPath);
  const database = findCompileCommands(repoPath, clangd.databaseDir, vscode.compileCommands);
  const parsed = database === undefined ? undefined : parseCompileCommands(database, repoPath);

  const extrasHeader: string[] = [];
  const extrasUser: string[] = [];
  collectIncludeArgs(clangd.add, repoPath, repoPath, extrasHeader, extrasUser);

  // A missing or unreadable database is not a winning empty include list.
  // Files that are in a readable database keep that entry's roots only.
  const fallbackHeader: string[] = [];
  const fallbackUser: string[] = [];
  if (parsed === undefined) {
    for (const includePath of vscode.includePaths) {
      const rel = toRepoRelative(includePath, repoPath, repoPath);
      if (rel !== undefined) fallbackHeader.push(rel);
    }
    collectFlagFile(join(repoPath, 'compile_flags.txt'), repoPath, fallbackHeader, fallbackUser);
    collectFlagFile(join(repoPath, '.ccls'), repoPath, fallbackHeader, fallbackUser);
  }

  const translationUnits = new Map<string, CTranslationUnitPaths>();
  if (parsed !== undefined) {
    for (const [file, paths] of parsed) {
      translationUnits.set(
        file,
        finishPaths(paths.header, paths.user, extrasHeader, extrasUser, implicitRoots),
      );
    }
  }

  return {
    headers,
    headerSearchPaths: uniquePaths([...fallbackHeader, ...extrasHeader, ...implicitRoots]),
    userHeaderSearchPaths: uniquePaths([...fallbackUser, ...extrasUser]),
    translationUnits,
  };
}

function finishPaths(
  header: readonly string[],
  user: readonly string[],
  extrasHeader: readonly string[],
  extrasUser: readonly string[],
  implicitRoots: readonly string[],
): CTranslationUnitPaths {
  return {
    headerSearchPaths: uniquePaths([...header, ...extrasHeader, ...implicitRoots]),
    userHeaderSearchPaths: uniquePaths([...user, ...extrasUser]),
  };
}

/** Shallower include roots first, then lexicographic. `deps/include` must not beat `include`. */
function sortByDepth(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => {
    const leftDepth = left.length === 0 ? 0 : left.split('/').length;
    const rightDepth = right.length === 0 ? 0 : right.split('/').length;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function walk(
  dir: string,
  root: string,
  headerExtensions: ReadonlySet<string>,
  headers: Set<string>,
  implicit: string[],
): void {
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
      if (IMPLICIT_INCLUDE_DIRECTORIES.has(name)) implicit.push(relativeDir);
      walk(full, root, headerExtensions, headers, implicit);
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
  repoPath: string,
  clangdDatabaseDir: string | undefined,
  vscodeCompileCommands: string | undefined,
): string | undefined {
  if (clangdDatabaseDir !== undefined) {
    const pointed = compileCommandsFile(repoPath, clangdDatabaseDir);
    if (pointed !== undefined) return pointed;
  }
  for (const rel of COMPILE_COMMANDS_CANDIDATES) {
    const full = join(repoPath, rel);
    if (existsSync(full)) return full;
  }
  if (vscodeCompileCommands !== undefined && existsSync(vscodeCompileCommands)) {
    return vscodeCompileCommands;
  }
  return undefined;
}

function compileCommandsFile(repoPath: string, databaseDir: string): string | undefined {
  const rel = toRepoRelative(databaseDir, repoPath, repoPath);
  if (rel === undefined) return undefined;
  const full = join(repoPath, rel, 'compile_commands.json');
  return existsSync(full) ? full : undefined;
}

interface ClangdFlags {
  readonly add: readonly string[];
  readonly databaseDir?: string;
}

function readClangd(repoPath: string): ClangdFlags {
  const text = readText(join(repoPath, '.clangd'));
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

function readVscodeProperties(repoPath: string): VscodeProperties {
  const text = readText(join(repoPath, '.vscode', 'c_cpp_properties.json'));
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
      const resolved = resolvePointedPath(record.compileCommands, repoPath);
      if (resolved !== undefined) compileCommands = resolved;
    }
  }
  return { includePaths, compileCommands };
}

function resolvePointedPath(raw: string, repoPath: string): string | undefined {
  const rel = toRepoRelative(raw, repoPath, repoPath);
  if (rel === undefined) return undefined;
  return rel.length === 0 ? repoPath : join(repoPath, rel);
}

/**
 * Per-file include roots. `undefined` means the file exists but is not a
 * usable compilation database, so callers must fall through to flag files.
 */
function parseCompileCommands(
  filePath: string,
  repoPath: string,
): Map<string, { header: string[]; user: string[] }> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(filePath));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const units = new Map<string, { header: string[]; user: string[] }>();
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

function collectFlagFile(
  filePath: string,
  repoPath: string,
  header: string[],
  user: string[],
): void {
  const text = readText(filePath);
  if (text.length === 0) return;
  const args: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('%')) continue;
    args.push(line);
  }
  collectIncludeArgs(args, repoPath, repoPath, header, user);
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
