import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import type { CsharpStructureLineScanner } from './languages/csharp/namespace-siblings.js';

import { isDev } from './utils/env.js';
import { isHardcodedIgnoredDirectoryAtPath } from '../../config/ignore-service.js';

import { mapConcurrent } from '../../lib/utils.js';
import { logger } from '../logger.js';
// ============================================================================
// LANGUAGE-SPECIFIC CONFIG TYPES
// ============================================================================

/** TypeScript path alias config parsed from tsconfig.json */
export interface TsconfigPaths {
  /** Map of alias prefix -> target prefix (e.g., "@/" -> "src/") */
  aliases: Map<string, string>;
  /** Base URL for path resolution (relative to repo root) */
  baseUrl: string;
}

/** Go module config parsed from go.mod */
export interface GoModuleConfig {
  /** Module path (e.g., "github.com/user/repo") */
  modulePath: string;
}

/** PHP Composer PSR-4 autoload config */
export interface ComposerConfig {
  /** Map of namespace prefix -> directory (e.g., "App\\" -> "app/") */
  psr4: Map<string, string>;
  /** Production `autoload.psr-4` prefixes that may gate external namespaces.
   *  Absent on legacy/manual configs, where every mapping remains authoritative. */
  authoritativePsr4?: ReadonlySet<string>;
  /** True when Composer also declares an autoload mechanism this resolver does not model. */
  hasUnmodeledAutoload?: boolean;
  /** PSR-4 entries sorted by namespace length descending (longest match wins).
   *  Cached once at config load time to avoid re-sorting on every import. */
  psr4Sorted?: readonly [string, string][];
}

function normalizeComposerDirectory(baseDir: string, directory: string): string {
  const normalizedBase = baseDir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const normalizedDirectory = directory
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
  if (normalizedBase === '') return normalizedDirectory;
  if (normalizedDirectory === '') return normalizedBase;
  return path.posix.normalize(`${normalizedBase}/${normalizedDirectory}`);
}

/** Parse one Composer manifest without performing I/O. */
export function parseComposerConfig(value: unknown, baseDir = ''): ComposerConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const composer = value as Record<string, unknown>;
  const autoload = composer.autoload;
  const autoloadDev = composer['autoload-dev'];
  if (autoload === undefined && autoloadDev === undefined) return null;

  const psr4 = new Map<string, string>();
  const authoritativePsr4 = new Set<string>();
  let hasUnmodeledAutoload = false;

  const addSection = (sectionValue: unknown, authoritative: boolean): void => {
    if (typeof sectionValue !== 'object' || sectionValue === null || Array.isArray(sectionValue)) {
      return;
    }
    const section = sectionValue as Record<string, unknown>;
    if ('psr-0' in section || 'classmap' in section) hasUnmodeledAutoload = true;

    const rawPsr4 = section['psr-4'];
    if (typeof rawPsr4 !== 'object' || rawPsr4 === null || Array.isArray(rawPsr4)) return;

    for (const [namespace, directories] of Object.entries(rawPsr4)) {
      const stringDirectories = Array.isArray(directories)
        ? directories.filter((entry): entry is string => typeof entry === 'string')
        : typeof directories === 'string'
          ? [directories]
          : [];
      if (stringDirectories.length === 0) continue;
      if (stringDirectories.length > 1) hasUnmodeledAutoload = true;

      const normalizedNamespace = namespace.replace(/\\+$/, '');
      const normalizedDirectory = normalizeComposerDirectory(baseDir, stringDirectories[0]);
      const existing = psr4.get(normalizedNamespace);
      if (existing !== undefined && existing !== normalizedDirectory) {
        hasUnmodeledAutoload = true;
        continue;
      }
      if (existing === undefined) psr4.set(normalizedNamespace, normalizedDirectory);
      if (authoritative) authoritativePsr4.add(normalizedNamespace);
    }
  };

  // Production mappings win duplicate prefixes. Development mappings remain
  // usable for test code but do not establish authority for the external gate.
  addSection(autoload, true);
  addSection(autoloadDev, false);

  return { psr4, authoritativePsr4, hasUnmodeledAutoload };
}

/** Merge package-local Composer manifests into one repository-relative config. */
export function mergeComposerConfigs(configs: readonly ComposerConfig[]): ComposerConfig | null {
  if (configs.length === 0) return null;

  const psr4 = new Map<string, string>();
  const authoritativePsr4 = new Set<string>();
  let hasUnmodeledAutoload = false;
  for (const config of configs) {
    hasUnmodeledAutoload ||= config.hasUnmodeledAutoload === true;
    for (const [namespace, directory] of config.psr4) {
      const existing = psr4.get(namespace);
      if (existing !== undefined && existing !== directory) {
        hasUnmodeledAutoload = true;
        continue;
      }
      if (existing === undefined) psr4.set(namespace, directory);
    }
    for (const namespace of config.authoritativePsr4 ?? config.psr4.keys()) {
      authoritativePsr4.add(namespace);
    }
  }
  return { psr4, authoritativePsr4, hasUnmodeledAutoload };
}

/** C# project config parsed from .csproj files */
export interface CSharpProjectConfig {
  /** Root namespace from <RootNamespace> or assembly name (default: project directory name) */
  rootNamespace: string;
  /** Directory containing the .csproj file */
  projectDir: string;
}

/**
 * Declared-namespace evidence used to gate C# suffix-fallback resolution so
 * BCL usings (e.g. `System.Threading.Tasks`) can't match a coincidentally-
 * named local file (#1881).
 */
export interface CSharpNamespaceEvidence {
  /** Every `namespace X.Y` declared in-repo (scan may be capped — see `truncated`). */
  readonly declaredNamespaces?: ReadonlySet<string>;
  /** csproj RootNamespace values plus the top-level segment of each declared
   *  namespace — the anchor set for the parent-namespace gate direction. */
  readonly rootNamespaces?: ReadonlySet<string>;
  /** True when the BFS hit its dir/depth cap, so the namespace set may be
   *  incomplete; the gate fails open (allows) in that case. */
  readonly truncated?: boolean;
}

/** Result of a single BFS over a repo collecting both csproj configs and
 *  declared `.cs` namespaces (one disk traversal — see `scanCSharpProject`). */
export interface CSharpProjectScan {
  readonly configs: CSharpProjectConfig[];
  readonly declaredNamespaces: ReadonlySet<string>;
  readonly rootNamespaces: ReadonlySet<string>;
  readonly truncated: boolean;
}

/** Project the one-pass {@link CSharpProjectScan} into the
 *  {@link CSharpNamespaceEvidence} both import-resolution legs thread to the
 *  #1881 gate — one shape, two carriers (`ImportConfigs.csharpNamespaces` for
 *  the legacy DAG, `CsharpResolutionConfig.namespaces` for the scope resolver).
 *  Keeps the field mapping in one place so the two carriers can't drift. */
export function csharpScanToEvidence(scan: CSharpProjectScan): CSharpNamespaceEvidence {
  return {
    declaredNamespaces: scan.declaredNamespaces,
    rootNamespaces: scan.rootNamespaces,
    truncated: scan.truncated,
  };
}

/** Swift Package Manager module config */
export interface SwiftPackageConfig {
  /** Map of target name -> source directory path (e.g., "SiuperModel" -> "Package/Sources/SiuperModel") */
  targets: Map<string, string>;
}

/** Zig package config parsed from build.zig.zon and the root build.zig */
export interface ZigBuildZonConfig {
  /**
   * Map of dependency name -> the dep's directory, in one of two spellings
   * depending on which package this config describes:
   *
   *   - ROOT package (`pkg === ''`): the raw `.path = "..."` value, exactly as
   *     written in build.zig.zon (relative to the repo root, and possibly
   *     escaping it: `../local_dep`). This is what `parseZigBuildZon` promises
   *     and what its tests pin.
   *   - NESTED package: repo-relative and already normalized, because a nested
   *     package's `.path` is written relative to ITS directory and means
   *     nothing against the repo-relative keys consumers match on
   *     (`packages/app`'s `../core` is stored as `packages/core`). A dep
   *     escaping the REPO root is dropped rather than stored.
   *
   * Either spelling is safe to hand to `normalizeZigDepPath` below — it rejects
   * absolute and repo-escaping values and is idempotent on an already
   * normalized one, which is what `resolveZigImportInternal` relies on.
   * `.url`-based deps cannot be resolved to a repo-local file (they unpack into
   * a build cache outside the repo) and so are not included here.
   */
  pathDeps: Map<string, string>;
  /**
   * Per path-dep: repo-relative root source files the dep's own `build.zig`
   * declares (`b.addModule("name", .{ .root_source_file = b.path("src/x.zig")
   * })`), keyed by dep name, in file order. Entries whose module name matches
   * the dep name come first — that is the module a consumer's
   * `@import("<dep>")` maps to under the ecosystem convention that the zon key
   * and the module name agree. Absent (or empty) when the dep has no readable
   * `build.zig`; the resolver then falls back to the conventional layouts.
   */
  moduleRoots?: Map<string, readonly string[]>;
  /**
   * Modules the repo's OWN root `build.zig` declares under an importable
   * name, module name → repo-relative root source file
   * (`b.addModule("lp", .{ .root_source_file = b.path("src/lp.zig") })`, or a
   * `createModule` binding later named through `addImport("lp", binding)`).
   * These are what an in-repo `@import("lp")` means — the most common shape in
   * single-package repos, where every file imports the package's own root
   * module by name. Independent of `build.zig.zon`: a repo with a `build.zig`
   * and no zon still resolves them. See `parseZigRootModules`.
   */
  rootModules?: Map<string, string>;
  /**
   * Every build module the root `build.zig` declares, each with ITS OWN
   * import table — `addModule` / `createModule` roots and the root modules of
   * `addExecutable` / `addLibrary` / `addTest` artifacts, with the aliases
   * their `addImport("<alias>", …)` calls and `.imports = &.{ … }` fields
   * bind. `rootModules` flattens all of those into one first-wins map, which
   * is wrong as soon as two modules bind one alias to different roots (an
   * `app` and a `tool` executable that each `addImport("config", …)` their
   * own `config.zig`): the second module's files resolved to the first
   * module's target. The resolver walks a source file to its containing
   * module(s) and consults their tables first — see
   * `resolveZigImportInternal` / `parseZigBuildModules`.
   */
  buildModules?: readonly ZigBuildModule[];
}

/**
 * One Zig build package: the directory whose `build.zig` / `build.zig.zon`
 * declare the config, and that config with every path REPO-relative.
 *
 * A Zig module's import table is declared by the `build.zig` of the package it
 * belongs to, so a repo holding several packages holds several import tables —
 * the same shape a TypeScript monorepo has with a `tsconfig.json` per package.
 */
export interface ZigPackageScope {
  /** Repo-relative directory the package governs (`''` for the repo root). */
  readonly dir: string;
  readonly config: ZigBuildZonConfig;
}

/**
 * Every Zig build package in the repo, indexed so the nearest one to a file
 * wins — the `TsconfigIndex` analogue, and for the same reason.
 */
export interface ZigWorkspaceIndex {
  /** Deepest-first, so the first `dir` that prefixes a file path governs it. */
  readonly packages: readonly ZigPackageScope[];
}

/** One build module of the root `build.zig` — see `ZigBuildZonConfig.buildModules`. */
export interface ZigBuildModule {
  /** The `addModule("<name>", …)` name; absent for `createModule` bindings
   *  and artifact root modules, which are reachable only through aliases. */
  readonly name?: string;
  /** Repo-relative root source file (`b.path("src/x.zig")`). */
  readonly root: string;
  /** Alias → repo-relative root source file, as this module's own
   *  `addImport` calls and `.imports` field declare it. Includes aliases to
   *  a path dep's module (`addImport("api", dep.module("core"))`) when the
   *  dep's build.zig declares that module. */
  readonly imports: ReadonlyMap<string, string>;
}

// ============================================================================
// LANGUAGE-SPECIFIC CONFIG LOADERS
// ============================================================================

/**
 * Parse tsconfig.json to extract path aliases.
 * Tries tsconfig.json, tsconfig.app.json, tsconfig.base.json in order.
 */
export async function loadTsconfigPaths(repoRoot: string): Promise<TsconfigPaths | null> {
  const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json'];

  for (const filename of candidates) {
    try {
      const tsconfigPath = path.join(repoRoot, filename);
      const raw = await fs.readFile(tsconfigPath, 'utf-8');
      // Strip JSON comments (// and /* */ style) for robustness
      const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(stripped);
      const compilerOptions = tsconfig.compilerOptions;
      if (!compilerOptions?.paths) continue;

      const baseUrl = compilerOptions.baseUrl || '.';
      const aliases = new Map<string, string>();

      for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const target = targets[0] as string;

        // Convert glob patterns: "@/*" -> "@/", "src/*" -> "src/"
        const aliasPrefix = pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern;
        const targetPrefix = target.endsWith('/*') ? target.slice(0, -1) : target;

        aliases.set(aliasPrefix, targetPrefix);
      }

      if (aliases.size > 0) {
        if (isDev) {
          logger.info(`📦 Loaded ${aliases.size} path aliases from ${filename}`);
        }
        return { aliases, baseUrl };
      }
    } catch {
      // File doesn't exist or isn't valid JSON - try next
    }
  }

  return null;
}

/**
 * Parse go.mod to extract module path.
 */
export async function loadGoModulePath(repoRoot: string): Promise<GoModuleConfig | null> {
  try {
    const goModPath = path.join(repoRoot, 'go.mod');
    const content = await fs.readFile(goModPath, 'utf-8');
    const match = content.match(/^module\s+(\S+)/m);
    if (match) {
      if (isDev) {
        logger.info(`📦 Loaded Go module path: ${match[1]}`);
      }
      return { modulePath: match[1] };
    }
  } catch {
    // No go.mod
  }
  return null;
}

/** Parse composer.json to extract PSR-4 autoload mappings (including autoload-dev). */
export async function loadComposerConfig(repoRoot: string): Promise<ComposerConfig | null> {
  try {
    const composerPath = path.join(repoRoot, 'composer.json');
    const raw = await fs.readFile(composerPath, 'utf-8');
    const config = parseComposerConfig(JSON.parse(raw));
    if (config === null) return null;

    if (isDev) {
      logger.info(`📦 Loaded ${config.psr4.size} PSR-4 mappings from composer.json`);
    }
    return config;
  } catch {
    return null;
  }
}

// BFS bounds shared by the C# project/namespace scan. Sized to comfortably
// exceed normal C# repos so `truncated` stays the rare exception it was meant
// to be: a too-low cap trips `truncated=true` on ordinary repos, which makes
// `csharpSuffixFallbackAllowed` fail OPEN for every import and silently
// disables the #1881 gate. Truncation remains the safety valve for genuinely
// pathological trees (deep generated output, huge monorepos).
const CSHARP_SCAN_MAX_DEPTH = 24;
const CSHARP_SCAN_MAX_DIRS = 20000;
// Bound on in-flight file reads per directory so a directory with thousands of
// `.cs` files can't exhaust file descriptors / spike memory. Mirrors the
// Phase-1 walker's `READ_CONCURRENCY` (see `filesystem-walker.ts`).
const CSHARP_SCAN_READ_CONCURRENCY = 32;
const CSHARP_SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj']);
const CSHARP_ROOT_NAMESPACE_RE = /<RootNamespace>\s*([^<]+)\s*<\/RootNamespace>/;

// Declared `namespace` names are extracted with the comment/string-aware
// scanner shared with the scope-resolution namespace-siblings pass
// (`extractCsharpStructureViaScanner`), not a bare regex: a regex matches
// `namespace` inside comments and string literals, seeding the #1881 gate
// with phantom namespaces. Imported lazily (and memoized) so the always-on
// `loadImportConfigs` path — every repo, every language — doesn't eagerly
// pull tree-sitter-c-sharp in via `namespace-siblings.ts` → `query.ts`.
let csharpScannerFactoryPromise: Promise<() => CsharpStructureLineScanner> | undefined;
function getCsharpStructureScannerFactory(): Promise<() => CsharpStructureLineScanner> {
  if (csharpScannerFactoryPromise === undefined) {
    csharpScannerFactoryPromise = import('./languages/csharp/namespace-siblings.js').then(
      (mod) => mod.createCsharpStructureScanner,
    );
  }
  return csharpScannerFactoryPromise;
}

/**
 * Single BFS over a repo that collects BOTH .csproj configs and the set of
 * `namespace` declarations from `.cs` files.
 *
 * The csproj walk is cheap (a handful of project files); the namespace scan
 * is NOT — it opens and reads every `.cs` file in the repo to collect its
 * `namespace` declarations. That `.cs` read cost is the price of the #1881
 * gate, not a saving: collapsing the csproj and namespace walks into one BFS
 * avoids a second directory traversal, but the per-file `.cs` reads are new
 * work this scan introduces. Reads within a directory are issued in bounded
 * windows (see below); directories are still visited breadth-first.
 */
export async function scanCSharpProject(repoRoot: string): Promise<CSharpProjectScan> {
  const configs: CSharpProjectConfig[] = [];
  const declaredNamespaces = new Set<string>();
  const rootNamespaces = new Set<string>();
  const scanQueue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  let dirsScanned = 0;
  let truncated = false;

  while (scanQueue.length > 0) {
    if (dirsScanned >= CSHARP_SCAN_MAX_DIRS) {
      truncated = true;
      break;
    }
    const { dir, depth } = scanQueue.shift()!;
    dirsScanned++;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory → its `.cs` namespaces are missed, so the scan is
      // incomplete. Mark truncated so the #1881 gate fails OPEN (allows the
      // suffix fallback) rather than wrongly blocking an import whose declaring
      // namespace lived in the unread subtree (#5).
      truncated = true;
      continue;
    }
    // Collect read targets, then issue them in bounded windows (rather than all
    // at once) so a directory with thousands of `.cs` files can't exhaust file
    // descriptors / spike memory. csproj reads keep entry order (config
    // precedence matters); `.cs` namespace results land in shared Sets where
    // order is irrelevant.
    const csprojNames: string[] = [];
    const csNames: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (CSHARP_SCAN_SKIP_DIRS.has(entry.name)) continue;
        if (depth < CSHARP_SCAN_MAX_DEPTH) {
          scanQueue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        } else {
          truncated = true; // a real subtree was pruned at the depth cap
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.csproj')) {
        csprojNames.push(entry.name);
      } else if (entry.name.endsWith('.cs')) {
        csNames.push(entry.name);
      }
    }
    // `mapConcurrent` runs the same bounded waves and degrades per item
    // (a rejection becomes `undefined`), so entry order is still preserved.
    const csprojResults = await mapConcurrent(
      csprojNames,
      (name) => readCsprojConfig(path.join(dir, name), name, repoRoot, dir),
      { concurrency: CSHARP_SCAN_READ_CONCURRENCY },
    );
    for (const config of csprojResults) {
      if (config) {
        configs.push(config);
        rootNamespaces.add(config.rootNamespace);
      }
    }
    const csResults = await mapConcurrent(
      csNames,
      (name) => collectDeclaredNamespaces(path.join(dir, name), declaredNamespaces, rootNamespaces),
      { concurrency: CSHARP_SCAN_READ_CONCURRENCY },
    );
    // A `.cs` that was unreadable (or whose read/scan unexpectedly rejected)
    // leaves its namespaces uncollected → mark truncated to fail the #1881
    // gate OPEN rather than wrongly suppress an import. The scan streams each
    // file, so file size no longer trips truncation. A rejected read arrives
    // here as `undefined`, which is `!== 'ok'` just like the old
    // `r.status !== 'fulfilled'` arm.
    for (const r of csResults) {
      if (r !== 'ok') truncated = true;
    }
  }

  if (truncated) {
    // Surface the fail-open so an incomplete scan (dir/depth cap, or an
    // unreadable directory or `.cs` file) silently disabling the #1881 gate
    // repo-wide is observable (#4) rather than a mystery edge regression.
    logger.warn(
      `[csharp] namespace scan of ${repoRoot} truncated (dir cap ${CSHARP_SCAN_MAX_DIRS}, depth cap ${CSHARP_SCAN_MAX_DEPTH}, an unreadable directory, or an unreadable .cs file); the #1881 suffix-fallback gate fails open for unmatched usings`,
    );
  }
  return { configs, declaredNamespaces, rootNamespaces, truncated };
}

// Generous soft budget for locating `<RootNamespace>`: a real .csproj declares
// it in the first PropertyGroup near the top, so this is only reached by a
// pathological project file with a huge leading ItemGroup and no early
// RootNamespace. On hit we OMIT the config rather than guess a root (Codex F4).
const CSPROJ_ROOT_SCAN_MAX_BYTES = 4 * 1024 * 1024;
// Overlap kept across stream chunks so a `<RootNamespace>` tag straddling a
// chunk boundary is still matched (the tag + a short namespace value fit well
// within this window).
const CSPROJ_TAG_OVERLAP = 512;

/**
 * Stream a `.csproj` just far enough to find `<RootNamespace>`, in constant
 * memory and without a stat-then-read filesystem race. Returns the namespace
 * when found; otherwise `rootNamespace: null` with `capHit` distinguishing a
 * genuine read-to-EOF absence (`false`) from "not found within the soft budget"
 * (`true`) — so the caller never synthesizes a wrong filename root for a late
 * tag (Codex F4).
 */
async function findCsprojRootNamespace(
  csprojPath: string,
): Promise<{ rootNamespace: string | null; capHit: boolean }> {
  const stream = createReadStream(csprojPath, { encoding: 'utf-8' });
  let window = '';
  let bytesRead = 0;
  try {
    for await (const chunk of stream) {
      const text = chunk as string;
      bytesRead += text.length;
      window =
        (window.length > CSPROJ_TAG_OVERLAP ? window.slice(-CSPROJ_TAG_OVERLAP) : window) + text;
      const match = window.match(CSHARP_ROOT_NAMESPACE_RE);
      if (match) {
        stream.destroy();
        return { rootNamespace: match[1]!.trim(), capHit: false };
      }
      if (bytesRead >= CSPROJ_ROOT_SCAN_MAX_BYTES) {
        stream.destroy();
        return { rootNamespace: null, capHit: true };
      }
    }
  } catch {
    // Unreadable .csproj: don't guess a filename root either — omit the config.
    return { rootNamespace: null, capHit: true };
  }
  return { rootNamespace: null, capHit: false }; // read to EOF, tag genuinely absent
}

async function readCsprojConfig(
  csprojPath: string,
  fileName: string,
  repoRoot: string,
  dir: string,
): Promise<CSharpProjectConfig | null> {
  const { rootNamespace: found, capHit } = await findCsprojRootNamespace(csprojPath);
  // A late `<RootNamespace>` we couldn't reach (capHit) or an unreadable file
  // must NOT synthesize a filename root — a wrong authoritative root would make
  // imports under the real root resolve to nothing and suppress the fallback
  // (Codex F4). Omit the config so the no-csproj fallback stays available. Only
  // fall back to the filename on a genuine read-to-EOF absence of the tag.
  if (capHit) return null;
  const rootNamespace = found ?? fileName.replace(/\.csproj$/, '');
  const projectDir = path.relative(repoRoot, dir).replace(/\\/g, '/');
  if (isDev) {
    logger.info(
      `📦 Loaded C# project: ${fileName} (namespace: ${rootNamespace}, dir: ${projectDir})`,
    );
  }
  return { rootNamespace, projectDir };
}

/**
 * Stream one `.cs` file line-by-line and collect its declared `namespace` names
 * into the shared Sets.
 *
 * Streaming (rather than reading the whole file into a string) keeps memory
 * constant regardless of file size, so a large generated `.cs` (`*.g.cs`, EF /
 * gRPC output) is fully scanned instead of skipped by a per-file size cap —
 * which would otherwise trip `truncated` and disable the #1881 gate repo-wide.
 * Only the cheap line scan streams here; the tree-sitter PARSE path keeps its
 * own size cap.
 *
 * Returns `'truncated'` when the file could not be read, so the caller marks the
 * scan truncated and the #1881 gate fails OPEN rather than wrongly suppress an
 * import declared in the unread file. Returns `'ok'` on a complete read.
 */
async function collectDeclaredNamespaces(
  filePath: string,
  declaredNamespaces: Set<string>,
  rootNamespaces: Set<string>,
): Promise<'ok' | 'truncated'> {
  const createScanner = await getCsharpStructureScannerFactory();
  const scanner = createScanner();
  try {
    // `crlfDelay: Infinity` treats every `\r\n` as a single break; the line
    // scanner is terminator-agnostic, so a streamed scan yields the same
    // namespaces as scanning the whole file content at once.
    const lines = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      scanner.pushLine(line);
    }
  } catch {
    return 'truncated'; // unreadable source → signal truncation (fail open)
  }
  const structure = scanner.result();
  for (const ns of structure.namespaces) {
    declaredNamespaces.add(ns);
    const dot = ns.indexOf('.');
    rootNamespaces.add(dot === -1 ? ns : ns.slice(0, dot));
  }
  // A declaration the scanner could not fully capture (Codex F3) means the
  // collected namespaces are an incomplete picture of this file — treat it like
  // a truncated read so the #1881 gate fails OPEN rather than over-block an
  // import whose namespace was dropped.
  return structure.incomplete ? 'truncated' : 'ok';
}

export async function loadSwiftPackageConfig(repoRoot: string): Promise<SwiftPackageConfig | null> {
  // Swift imports are module-name based (e.g., `import SiuperModel`)
  // SPM convention: Sources/<TargetName>/ or Package/Sources/<TargetName>/
  // We scan for these directories to build a target map
  const targets = new Map<string, string>();

  const sourceDirs = ['Sources', 'Package/Sources', 'src'];
  for (const sourceDir of sourceDirs) {
    try {
      const fullPath = path.join(repoRoot, sourceDir);
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          targets.set(entry.name, sourceDir + '/' + entry.name);
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  if (targets.size > 0) {
    if (isDev) {
      logger.info(`📦 Loaded ${targets.size} Swift package targets`);
    }
    return { targets };
  }
  return null;
}

/**
 * Load the Zig build configuration a repo's `build.zig.zon` + root `build.zig`
 * declare: `.path` deps (and the roots their own build.zig names) from the
 * zon, and the repo's own named modules from the root build.zig. Either file
 * may be missing — a repo with a `build.zig` but no `build.zig.zon` still
 * resolves `@import("<own module>")`. Null only when neither contributes.
 *
 * `build.zig.zon` is Zig source (an anonymous-struct literal), not JSON.
 * Rather than pull in a tree-sitter parse for one file, we use a small
 * regex-based extractor that handles the common shapes:
 *
 *   .dependencies = .{
 *       .ziggit_pkg = .{
 *           .url = "https://...",
 *           .hash = "1220...",
 *       },
 *       .local_dep = .{
 *           .path = "../local_dep",
 *       },
 *   },
 *
 * Limitations (intentional — bail to null on anything weirder):
 *   - Only the top-level `.dependencies = .{ ... }` block is parsed (brace
 *     depth 1); a same-named field nested in another struct is ignored.
 *   - Each dep entry is matched by a single shape: `.<name> = .{ ... }`
 *     where `<name>` is a bare identifier (no `@"…"` quoted form).
 *   - Only `.path = "..."` is captured. `.url` deps are left unresolved
 *     because their unpacked location lives outside the repo
 *     (.zig-cache/p/<hash>/ or ~/.cache/zig/p/<hash>/) and is therefore
 *     not in our `allFilePaths` set.
 *   - `//` line comments are stripped before scanning (string-aware, so a
 *     `//` inside `.url = "https://…"` survives), and brace matching skips
 *     string literals — a commented-out `.path` or a `}` inside a comment
 *     or string cannot declare a dep or truncate the block.
 */
export async function loadZigBuildConfig(
  repoRoot: string,
  packageDir = '',
): Promise<ZigBuildZonConfig | null> {
  // Every path this function returns is REPO-relative, because that is the
  // keyspace `allFilePaths` uses. The parsers below answer package-relative, so
  // a nested package rebases them through `inPackage`. For the root package
  // (`packageDir === ''`) the prefix is empty and every value is byte-identical
  // to what this function returned before nested packages existed.
  const pkg = packageDir === '' ? '' : `${packageDir}/`;
  const inPackage = (relToPackage: string): string => `${pkg}${relToPackage}`;
  const packageFile = (name: string): string => path.join(repoRoot, packageDir, name);
  let config: ZigBuildZonConfig | null = null;
  try {
    const raw = await fs.readFile(packageFile('build.zig.zon'), 'utf-8');
    config = parseZigBuildZon(raw);
  } catch {
    // No zon (or unreadable): the root build.zig may still declare modules.
  }

  // The repo's own importable modules, from its root build.zig. Independent
  // of the zon: `@import("<own module>")` is how single-package repos refer
  // to their root file from every other file.
  let rootModules: Map<string, string> | undefined;
  let rootBuildZig: string | null = null;
  try {
    rootBuildZig = await fs.readFile(packageFile('build.zig'), 'utf-8');
    const parsed = parseZigRootModules(rootBuildZig);
    if (parsed.size > 0) {
      rootModules = new Map(Array.from(parsed, ([name, root]) => [name, inPackage(root)]));
    }
  } catch {
    // No root build.zig — nothing to declare.
  }

  if (config === null) {
    if (rootBuildZig === null) return null;
    // No zon: no path deps, so `dep.module(…)` operands resolve to nothing.
    const buildModules = rebaseZigBuildModules(parseZigBuildModules(rootBuildZig), inPackage);
    if (!rootModules && buildModules.length === 0) return null;
    return {
      pathDeps: new Map(),
      ...(rootModules ? { rootModules } : {}),
      ...(buildModules.length > 0 ? { buildModules } : {}),
    };
  }

  // A path dep's importable root is whatever ITS build.zig declares, not a
  // fixed layout: read `root_source_file` per `addModule` and remember it
  // repo-relative. Best effort — an unreadable build.zig just leaves the
  // conventional-layout fallback in place.
  const moduleRoots = new Map<string, readonly string[]>();
  // Per path dep: the modules its build.zig NAMES (`addModule("core", …)`),
  // repo-relative — what a root-build.zig `dep.module("core")` operand means.
  const depModules = new Map<string, ReadonlyMap<string, string>>();
  // A nested package's `.path` values are written relative to ITS directory, so
  // they are rebased here and stored repo-relative; `resolveZigImportInternal`
  // then reads them through the same `normalizeZigDepPath`, which is idempotent
  // on an already-normalized value. A dep that escapes the REPO root (not merely
  // the package) resolves to nothing and is dropped. The root package keeps its
  // raw spelling, which is what `parseZigBuildZon` promises and its tests pin.
  const pathDeps = pkg === '' ? config.pathDeps : new Map<string, string>();
  for (const [depName, depPath] of config.pathDeps) {
    // Asked of the value AS WRITTEN, before the package prefix goes on: an
    // absolute `.path` points outside the repository whichever package declared
    // it, and prefixing hides that from `normalizeZigDepPath`. See
    // `isAbsoluteZigDepPath`.
    if (isAbsoluteZigDepPath(depPath)) continue;
    const rel = normalizeZigDepPath(`${pkg}${depPath}`);
    if (rel === null) continue;
    if (pkg !== '') pathDeps.set(depName, rel);
    let buildZig: string;
    try {
      buildZig = await fs.readFile(path.join(repoRoot, rel, 'build.zig'), 'utf-8');
    } catch {
      continue;
    }
    const prefixed = (r: string): string => (rel === '' ? r : `${rel}/${r}`);
    const roots = parseZigBuildModuleRoots(buildZig, depName).map(prefixed);
    if (roots.length > 0) moduleRoots.set(depName, roots);
    const named = new Map<string, string>();
    for (const mod of parseZigBuildModules(buildZig)) {
      if (mod.name !== undefined && !named.has(mod.name)) named.set(mod.name, prefixed(mod.root));
    }
    if (named.size > 0) depModules.set(depName, named);
  }
  const buildModules =
    rootBuildZig === null
      ? []
      : rebaseZigBuildModules(
          parseZigBuildModules(rootBuildZig, depModules),
          inPackage,
          depModules,
        );
  return {
    ...config,
    pathDeps,
    ...(moduleRoots.size > 0 ? { moduleRoots } : {}),
    ...(rootModules ? { rootModules } : {}),
    ...(buildModules.length > 0 ? { buildModules } : {}),
  };
}

/**
 * Rebase a package's own build modules to repo-relative paths.
 *
 * `parseZigBuildModules` answers package-relative for everything it read out of
 * the `build.zig` it was handed, with one exception: an alias resolved through
 * `depModules` (`addImport("api", dep.module("core"))`) is already repo-relative,
 * because `depModules` was built that way. Prefixing that a second time would
 * point the alias at a path no file has. The already-repo-relative values are
 * therefore identified by membership in `depModules`, not guessed at from their
 * shape.
 */
function rebaseZigBuildModules(
  modules: readonly ZigBuildModule[],
  inPackage: (relToPackage: string) => string,
  depModules?: ReadonlyMap<string, ReadonlyMap<string, string>>,
): ZigBuildModule[] {
  if (inPackage('') === '') return [...modules];
  const fromDep = new Set<string>();
  for (const named of depModules?.values() ?? [])
    for (const root of named.values()) fromDep.add(root);
  return modules.map((mod) => ({
    ...(mod.name !== undefined ? { name: mod.name } : {}),
    root: inPackage(mod.root),
    imports: new Map(
      Array.from(mod.imports, ([alias, root]) => [
        alias,
        fromDep.has(root) ? root : inPackage(root),
      ]),
    ),
  }));
}

/** Bounds for the package walk, mirroring the tsconfig scan. */
const ZIG_SCAN_MAX_DIRS = 20_000;
const ZIG_SCAN_MAX_DEPTH = 24;

/**
 * The Zig build package governing `filePath` — the nearest one at or above it.
 *
 * A Zig module's import table is declared by the `build.zig` of the package the
 * file belongs to, so the nearest enclosing package is the faithful reading of
 * `@import("name")` at that site, exactly as `tsconfigFor` reads a non-relative
 * specifier against the nearest enclosing project.
 *
 * There is deliberately NO fall-through to an enclosing package when the nearest
 * one does not bind the name. Falling through is how a vendored dependency's
 * `@import("config")` silently resolved to the outer repo's `config` module —
 * the same failure `loadTsconfigIndex` documents for a package whose own
 * tsconfig declares no `baseUrl`, and the same failure the per-module import
 * tables in `resolveZigImportInternal` already exist to prevent one level down.
 */
export function zigPackageFor(
  index: ZigWorkspaceIndex | null | undefined,
  filePath: string,
): ZigBuildZonConfig | null {
  if (index === null || index === undefined) return null;
  for (const scope of index.packages) {
    if (scope.dir === '') return scope.config;
    if (filePath.startsWith(`${scope.dir}/`)) return scope.config;
  }
  return null;
}

/**
 * Load every Zig build package in the repo, nearest-first.
 *
 * Called with no `packageDir` — which is how every call site read it before
 * this function existed — `loadZigBuildConfig` reads the ROOT `build.zig` /
 * `build.zig.zon` and nothing else. That is the whole configuration of a
 * single-package repo and none of the configuration of a monorepo: a repo
 * laying its packages out as `packages/<name>/build.zig` has no root build
 * files at all, so the loader answers `null` and EVERY bare
 * `@import("<module>")` in it goes unresolved — cross-file resolution silently
 * degrades to relative imports only. Measured on a two-package fixture:
 * `config = null`, `@import("core")` → `null`.
 *
 * The loader itself is not root-bound any more: this function is what supplies
 * it a `packageDir`, one per package below.
 *
 * So the packages are discovered the way tsconfigs are (`findTsconfigFiles`):
 * one bounded breadth-first walk that skips the hardcoded ignore set, then
 * deepest-first ordering so `zigPackageFor` can take the first match.
 *
 * Called from `ScopeResolver.loadResolutionConfig`, which the orchestrator runs
 * once per LANGUAGE workspace pass — so the walk happens only for repos that
 * actually contain Zig. `loadImportConfigs`, which runs unconditionally for
 * every repo, keeps calling `loadZigBuildConfig` for the root package alone;
 * that is the same split TypeScript already has between the cheap
 * `loadTsconfigPaths` and the repo-walking `loadTsconfigIndex`.
 */
export async function loadZigWorkspaceIndex(repoRoot: string): Promise<ZigWorkspaceIndex | null> {
  const dirs = await findZigPackageDirs(repoRoot);
  if (dirs.length === 0) return null;
  const packages: ZigPackageScope[] = [];
  for (const dir of dirs) {
    const config = await loadZigBuildConfig(repoRoot, dir);
    // A `build.zig` that declares no module and no path dep contributes nothing
    // a lookup could answer with. Keeping it as an empty scope would be worse
    // than dropping it: it would shadow an enclosing package that DOES declare
    // the name, and answer nothing in its place.
    if (config !== null) packages.push({ dir, config });
  }
  if (packages.length === 0) return null;
  // Deepest first, so `zigPackageFor` takes the most specific package rather
  // than whichever the walk reached first.
  packages.sort((a, b) => b.dir.length - a.dir.length || a.dir.localeCompare(b.dir));
  return { packages };
}

/** Repo-relative directories holding a `build.zig` and/or a `build.zig.zon`. */
async function findZigPackageDirs(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  // A HEAD INDEX rather than `queue.shift()`. The queue is pushed to while it is
  // drained, which keeps the array in a mode where `shift()` memmoves the whole
  // remainder instead of taking V8's left-trimming fast path — so the walk is
  // quadratic in the frontier, and `ZIG_SCAN_MAX_DIRS` is the bound on how bad
  // that gets. Measured at that bound (20,000 dequeues): 53 ms at fan-out 4 and
  // 81 ms at fan-out 20, against 0.8 ms here — 66-106x, paid before any config
  // is read. Memory is unchanged: entries were already retained by the pushes,
  // `shift()` only dropped the head.
  let queueHead = 0;
  let dirsScanned = 0;

  while (queueHead < queue.length && dirsScanned < ZIG_SCAN_MAX_DIRS) {
    const { dir, depth } = queue[queueHead++]!;
    dirsScanned++;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let isPackage = false;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const childDir = path.join(dir, entry.name);
        if (isHardcodedIgnoredDirectoryAtPath(repoRoot, childDir)) continue;
        if (depth < ZIG_SCAN_MAX_DEPTH) queue.push({ dir: childDir, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      // Either marker declares a package: a `build.zig` with no zon still names
      // modules, and a zon with no build.zig still names path deps.
      if (entry.name === 'build.zig' || entry.name === 'build.zig.zon') isPackage = true;
    }
    if (isPackage) {
      const rel = path.relative(repoRoot, dir).split(path.sep).join('/');
      found.push(rel === '.' || rel === '' ? '' : rel);
    }
  }
  return found;
}

/**
 * Normalize a `.path` value from build.zig.zon into a repo-relative form.
 * Returns null for paths that escape the repo root (start with `..`) or
 * are absolute — those point to files we don't index. `.` / `./` normalize
 * to the empty string (the repo root itself). Shared with the import
 * resolver so both sides agree on which deps are in-repo.
 */
/**
 * Does this `.path` value point outside the repository BY ITS SPELLING —
 * POSIX absolute (`/dep`), Windows drive-qualified (`C:\dep`, `C:/dep`),
 * root-relative (`\dep`) or UNC (`\\server\share`)?
 *
 * Separators are normalized first so every Windows spelling is visible to the
 * one test. Exported-in-spirit rather than inlined because it must be asked in
 * TWO places and the two must not drift: `normalizeZigDepPath` asks it of the
 * value it is given, and `loadZigBuildConfig` asks it of a NESTED package's
 * value BEFORE prefixing the package directory. That second call is the whole
 * point — prefixing turns `/dep` into `packages/app//dep`, which is relative by
 * inspection, so the check inside `normalizeZigDepPath` no longer sees an
 * absolute path and the empty segment is simply dropped, mapping an
 * out-of-repo dependency onto a real in-repo directory if one happens to exist.
 *
 * `path.posix.join` is NOT a substitute: it strips the leading slash too
 * (`join('packages/app/', '/dep')` is `packages/app/dep`), so it produces the
 * same fabricated path without ever rejecting anything.
 *
 * A `..` prefix is deliberately NOT handled here. `../core` escapes the
 * package but not necessarily the repo, and rebasing it is exactly what the
 * nested-package branch exists to do; `normalizeZigDepPath` rejects the ones
 * that still escape the ROOT after rebasing.
 */
function isAbsoluteZigDepPath(depPath: string): boolean {
  const normalized = depPath.replace(/\\/g, '/');
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
}

export function normalizeZigDepPath(depPath: string): string | null {
  const normalized = depPath.replace(/\\/g, '/');
  if (isAbsoluteZigDepPath(depPath)) return null;
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/**
 * The `root_source_file` paths a `build.zig` declares, dep-relative, with the
 * module whose `addModule("<name>", …)` name equals `preferredName` first.
 *
 * Reads two shapes, which between them cover `zig init` output and the
 * common hand-written build scripts:
 *   - `b.addModule("name", .{ .root_source_file = b.path("src/root.zig") })`
 *   - any other `.root_source_file = b.path("…")` (exe/lib/test artifacts),
 *     kept as unnamed fallbacks in file order.
 * A `.zig` under `b.path` is required — `.{ .cwd_relative = … }` and
 * `LazyPath` values computed at build time are not resolvable statically and
 * are skipped. Duplicates collapse to the first occurrence.
 */
export function parseZigBuildModuleRoots(buildZig: string, preferredName: string): string[] {
  const named: string[] = [];
  const unnamed: string[] = [];
  const seen = new Set<string>();
  const add = (into: string[], p: string): void => {
    const norm = normalizeZigDepPath(p);
    if (norm === null || norm === '' || !norm.endsWith('.zig') || seen.has(norm)) return;
    seen.add(norm);
    into.push(norm);
  };
  const rootRe = /\.root_source_file\s*=\s*b\.path\(\s*"([^"\n]+)"\s*\)/;
  // The named module: scan the whole `addModule(…)` argument list, balanced
  // on parentheses, so a nested field before `.root_source_file` (`.imports =
  // &.{ .{ … } }`) does not end the match early — a `[^}]*` regex stopped at
  // that inner `}` and silently demoted the module to an unnamed fallback.
  const text = stripZonComments(buildZig);
  const mask = zonStringMask(text);
  const callRe = /\baddModule\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    if (mask[m.index] !== 0) continue;
    const argsStart = m.index + m[0].length;
    const argsEnd = findZigParenEnd(text, argsStart);
    if (argsEnd < 0) break;
    const args = text.slice(argsStart, argsEnd);
    const nameMatch = /^\s*"([^"\n]+)"\s*,/.exec(args);
    if (nameMatch?.[1] !== preferredName) continue;
    const root = zigTopLevelStaticRoot(args);
    if (root !== null) add(named, root);
  }
  const anyRe = new RegExp(rootRe.source, 'g');
  while ((m = anyRe.exec(text)) !== null) add(unnamed, m[1]!);
  return [...named, ...unnamed];
}

/**
 * The importable modules a repo's ROOT `build.zig` declares, module name →
 * repo-relative root source file. Static scan (no execution) of two shapes:
 *
 *   - `b.addModule("<name>", .{ .root_source_file = b.path("<p>.zig"), … })`
 *     names the module directly;
 *   - `const m = b.createModule(.{ .root_source_file = b.path("<p>.zig"), … })`
 *     (or `const m = b.addModule(…)`) bound to an identifier and later named
 *     by `x.addImport("<name>", m)` or `.imports = &.{ .{ .name = "<name>",
 *     .module = m } }`.
 *
 * Deliberately NOT resolved — they are not in-repo source files: modules whose
 * root is not a static `b.path("….zig")` (generated `opts.createModule()` from
 * `addOptions`, `translate_c.createModule()`, `.cwd_relative` / computed
 * LazyPaths), `addImport("<name>", dep.module("…"))` (a `.url` / path dep,
 * handled through the zon), and aliases whose module operand is anything but a
 * bare identifier bound above (`config.lp_module`). Comments are stripped and
 * string literals skipped; the first declaration of a name wins.
 */
export function parseZigRootModules(buildZig: string): Map<string, string> {
  const text = stripZonComments(buildZig);
  const mask = zonStringMask(text);
  const modules = new Map<string, string>();
  // identifier → repo-relative root, for `const m = b.createModule(…)` /
  // `const m = b.addModule(…)` bindings later named via addImport.
  const bindings = new Map<string, string>();
  const callRe = /\b(addModule|createModule)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    if (mask[m.index] !== 0) continue;
    const argsStart = m.index + m[0].length;
    const argsEnd = findZigParenEnd(text, argsStart);
    if (argsEnd < 0) break;
    const args = text.slice(argsStart, argsEnd);
    const root = zigTopLevelStaticRoot(args);
    if (root === null) continue;
    if (m[1] === 'addModule') {
      const nameMatch = /^\s*"([^"\n]+)"\s*,/.exec(args);
      if (nameMatch && !modules.has(nameMatch[1]!)) modules.set(nameMatch[1]!, root);
    }
    const binding = ZIG_MODULE_BINDING_RE.exec(text.slice(0, m.index));
    if (binding && !bindings.has(binding[1]!)) bindings.set(binding[1]!, root);
  }
  if (bindings.size === 0) return modules;
  const aliasRes = [
    /\.addImport\(\s*"([^"\n]+)"\s*,\s*([A-Za-z_]\w*)\s*\)/g,
    /\.name\s*=\s*"([^"\n]+)"\s*,\s*\.module\s*=\s*([A-Za-z_]\w*)\s*[,}]/g,
  ];
  for (const re of aliasRes) {
    while ((m = re.exec(text)) !== null) {
      if (mask[m.index] !== 0) continue;
      const root = bindings.get(m[2]!);
      if (root !== undefined && !modules.has(m[1]!)) modules.set(m[1]!, root);
    }
  }
  return modules;
}

/**
 * Every build module the ROOT `build.zig` declares, each with its OWN import
 * table (`ZigBuildModule`). Static scan (no execution) of:
 *
 *   - `b.addModule("<name>", .{ .root_source_file = b.path("<p>.zig"), … })`
 *     and `const m = b.createModule(.{ .root_source_file = … })` — a module,
 *     bound to the identifier a preceding `const m =` names;
 *   - `b.addExecutable` / `addLibrary` / `addStaticLibrary` /
 *     `addSharedLibrary` / `addTest` / `addObject(.{ .root_source_file =
 *     b.path("<p>.zig"), … })` — an artifact whose ROOT MODULE is a module of
 *     its own (reached as `exe.root_module.addImport(…)`), or `.root_module =
 *     m` / `.root_module = b.createModule(…)` naming one declared inline;
 *   - `<m>.addImport("<alias>", <operand>)`, `<exe>.root_module.addImport(…)`
 *     and the `.imports = &.{ .{ .name = "<alias>", .module = <operand> } }`
 *     field of a module's own arguments — an entry in THAT module's table.
 *     The operand is a module binding (`m`) or a path dep's named module,
 *     `dep.module("<name>")` with `const dep = b.dependency("<zon name>", …)`,
 *     looked up in `depModules` (zon dep name → module name → repo-relative
 *     root, from the dep's own build.zig).
 *
 * Why per module rather than one map (`parseZigRootModules`): an alias is
 * scoped to the module that declares it. Two executables that each
 * `addImport("config", …)` their own `config.zig` are the ordinary
 * multi-target layout, and a single first-wins map sent the second module's
 * `@import("config")` to the first module's file — a confident wrong
 * `IMPORTS` edge and every `config.*` call behind it. Deliberately NOT
 * resolved, as in `parseZigRootModules`: generated roots
 * (`addOptions().createModule()`, `translate_c.createModule()`, computed
 * LazyPaths), `.url` deps, and operands that are not a bare identifier or a
 * `dep.module("…")` on a `b.dependency` binding. Comments stripped, string
 * literals masked; the first binding of an identifier wins.
 */
export function parseZigBuildModules(
  buildZig: string,
  depModules?: ReadonlyMap<string, ReadonlyMap<string, string>>,
): ZigBuildModule[] {
  const text = stripZonComments(buildZig);
  const mask = zonStringMask(text);

  // Pass 1 — modules and the identifiers bound to them. `at` is the offset
  // of the call's name token, so an inline `.root_module = b.createModule(…)`
  // can be matched back to the module it minted.
  interface Draft {
    readonly name?: string;
    readonly root: string;
    readonly at: number;
    readonly argsStart: number;
    readonly argsEnd: number;
    readonly imports: Map<string, string>;
  }
  const drafts: Draft[] = [];
  const bindings = new Map<string, number>(); // identifier → drafts index
  const bind = (prefixEnd: number, idx: number): void => {
    const binding = ZIG_MODULE_BINDING_RE.exec(text.slice(0, prefixEnd));
    if (binding && !bindings.has(binding[1]!)) bindings.set(binding[1]!, idx);
  };
  // Artifact bindings whose `.root_module = <ident>` names a module declared
  // by another call; resolved once every binding is known.
  const pendingArtifactAliases: { readonly ident: string; readonly module: string }[] = [];
  const callRe =
    /\b(addModule|createModule|addExecutable|addLibrary|addStaticLibrary|addSharedLibrary|addTest|addObject)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    if (mask[m.index] !== 0) continue;
    const argsStart = m.index + m[0].length;
    const argsEnd = findZigParenEnd(text, argsStart);
    if (argsEnd < 0) break;
    const args = text.slice(argsStart, argsEnd);
    const kind = m[1]!;
    if (kind === 'addModule' || kind === 'createModule') {
      const root = zigTopLevelStaticRoot(args);
      if (root === null) continue;
      const nameMatch = kind === 'addModule' ? /^\s*"([^"\n]+)"\s*,/.exec(args) : null;
      drafts.push({
        ...(nameMatch ? { name: nameMatch[1]! } : {}),
        root,
        at: m.index,
        argsStart,
        argsEnd,
        imports: new Map(),
      });
      bind(m.index, drafts.length - 1);
      continue;
    }
    // An artifact. Its root module is either declared inline by
    // `.root_source_file`, or handed over through `.root_module = …`.
    const rootModule = /\.root_module\s*=\s*((?:[A-Za-z_]\w*\.)*)([A-Za-z_]\w*)\s*(\()?/.exec(args);
    if (rootModule) {
      if (rootModule[3] === '(' && rootModule[2] === 'createModule') {
        // Inline `.root_module = b.createModule(.{ … })`: the module is minted
        // by the createModule call inside these args (a later iteration of
        // this loop); remember the artifact's binding for it.
        const nameOffset = rootModule.index + rootModule[0].lastIndexOf('createModule');
        const binding = ZIG_MODULE_BINDING_RE.exec(text.slice(0, m.index));
        if (binding) {
          pendingArtifactAliases.push({
            ident: binding[1]!,
            module: `@${argsStart + nameOffset}`,
          });
        }
      } else if (rootModule[1] === '' && rootModule[3] === undefined) {
        const binding = ZIG_MODULE_BINDING_RE.exec(text.slice(0, m.index));
        if (binding) pendingArtifactAliases.push({ ident: binding[1]!, module: rootModule[2]! });
      }
      continue;
    }
    const root = zigTopLevelStaticRoot(args);
    if (root === null) continue;
    drafts.push({ root, at: m.index, argsStart, argsEnd, imports: new Map() });
    bind(m.index, drafts.length - 1);
  }
  for (const alias of pendingArtifactAliases) {
    if (bindings.has(alias.ident)) continue;
    const idx = alias.module.startsWith('@')
      ? drafts.findIndex((d) => d.at === Number(alias.module.slice(1)))
      : (bindings.get(alias.module) ?? -1);
    if (idx >= 0) bindings.set(alias.ident, idx);
  }
  if (drafts.length === 0) return [];

  // `const dep = b.dependency("<zon name>", …)` bindings, for `dep.module("…")`.
  const dependencyBindings = new Map<string, string>();
  const depRe =
    /(?:const|var)\s+([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_]\w*\.)*dependency\(\s*"([^"\n]+)"/g;
  while ((m = depRe.exec(text)) !== null) {
    if (mask[m.index] !== 0) continue;
    if (!dependencyBindings.has(m[1]!)) dependencyBindings.set(m[1]!, m[2]!);
  }
  // An import operand → the repo-relative root it names, or null.
  const operandRoot = (operand: string): string | null => {
    const bare = /^([A-Za-z_]\w*)$/.exec(operand);
    if (bare) {
      const idx = bindings.get(bare[1]!);
      return idx === undefined ? null : drafts[idx]!.root;
    }
    const viaDep = /^([A-Za-z_]\w*)\.module\(\s*"([^"\n]+)"\s*\)$/.exec(operand);
    if (viaDep) {
      const zonName = dependencyBindings.get(viaDep[1]!);
      return zonName === undefined ? null : (depModules?.get(zonName)?.get(viaDep[2]!) ?? null);
    }
    return null;
  };
  const addImport = (idx: number, alias: string, operand: string): void => {
    const root = operandRoot(operand.trim());
    const table = drafts[idx]!.imports;
    if (root !== null && !table.has(alias)) table.set(alias, root);
  };

  // Pass 2a — `<m>.addImport("<alias>", <operand>)` / `<exe>.root_module.addImport(…)`.
  const addImportRe = /\b([A-Za-z_]\w*)(?:\.root_module)?\.addImport\s*\(/g;
  while ((m = addImportRe.exec(text)) !== null) {
    if (mask[m.index] !== 0) continue;
    const idx = bindings.get(m[1]!);
    if (idx === undefined) continue;
    const argsStart = m.index + m[0].length;
    const argsEnd = findZigParenEnd(text, argsStart);
    if (argsEnd < 0) break;
    const args = text.slice(argsStart, argsEnd);
    const aliasMatch = /^\s*"([^"\n]+)"\s*,/.exec(args);
    if (!aliasMatch) continue;
    addImport(idx, aliasMatch[1]!, args.slice(aliasMatch[0].length));
  }
  // Pass 2b — `.imports = &.{ .{ .name = "<alias>", .module = <operand> }, … }`
  // inside a module's own argument list. The operand runs to the next `,` or
  // `}` at paren depth 0 (`dep.module("core")` carries parentheses).
  const entryRe = /\.name\s*=\s*"([^"\n]+)"\s*,\s*\.module\s*=\s*/g;
  drafts.forEach((draft, idx) => {
    const args = text.slice(draft.argsStart, draft.argsEnd);
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(args)) !== null) {
      if (mask[draft.argsStart + e.index] !== 0) continue;
      let depth = 0;
      let end = e.index + e[0].length;
      for (; end < args.length; end++) {
        const ch = args[end];
        if (ch === '(') depth++;
        else if (ch === ')') {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && (ch === ',' || ch === '}')) break;
      }
      addImport(idx, e[1]!, args.slice(e.index + e[0].length, end));
    }
  });

  return drafts.map(({ name, root, imports }) => ({
    ...(name !== undefined ? { name } : {}),
    root,
    imports,
  }));
}

/** First `.root_source_file = b.path("….zig")` at the TOP level of a
 *  module-options `.{ … }` — not a nested `.imports = &.{ .{ … } }` entry. */
function zigTopLevelStaticRoot(args: string): string | null {
  const mask = zonStringMask(args);
  let structAt = -1;
  for (let i = 0; i < args.length - 1; i++) {
    if (mask[i] !== 0) continue;
    if (args[i] === '.' && args[i + 1] === '{') {
      structAt = i;
      break;
    }
  }
  if (structAt < 0) return null;
  const bodyStart = structAt + 2;
  const bodyEnd = findZonBlockEnd(args, bodyStart);
  if (bodyEnd < 0) return null;
  const match = /\.root_source_file\s*=\s*b\.path\(\s*"([^"\n]+)"\s*\)/.exec(
    zonBlankNestedBlocks(args.slice(bodyStart, bodyEnd)),
  );
  if (match === null) return null;
  const root = normalizeZigDepPath(match[1]!);
  return root === null || root === '' || !root.endsWith('.zig') ? null : root;
}

/** `const m = b.createModule` / `const m = b.addModule` — not `config.createModule`. */
const ZIG_MODULE_BINDING_RE = /(?:const|var)\s+([A-Za-z_]\w*)\s*=\s*b\.$/;

/**
 * Index of the `)` matching the `(` that precedes `start`, skipping parens
 * inside `"…"` literals. -1 when unbalanced. Call on comment-stripped text.
 */
function findZigParenEnd(text: string, start: number): number {
  let depth = 1;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Blank out `//` line comments (and `\\` multiline-string-literal lines) in
 * ZON source, string-aware: a `//` inside a `"…"` literal (`.url =
 * "https://…"`) is content, not a comment. Comment bytes are replaced with
 * spaces so every surviving character keeps its offset.
 */
function stripZonComments(raw: string): string {
  const out = raw.split('');
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === '\\')
        i++; // skip the escaped char
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    const isLineComment = ch === '/' && raw[i + 1] === '/';
    const isMultilineLiteral =
      ch === '\\' &&
      raw[i + 1] === '\\' &&
      /^[ \t]*$/.test(raw.slice(raw.lastIndexOf('\n', i) + 1, i));
    if (isLineComment || isMultilineLiteral) {
      while (i < raw.length && raw[i] !== '\n') out[i++] = ' ';
    }
  }
  return out.join('');
}

/**
 * Index of the `}` matching the `{` that precedes `start`, skipping braces
 * inside `"…"` literals. -1 when unbalanced. Call on comment-stripped text.
 */
function findZonBlockEnd(text: string, start: number): number {
  let depth = 1;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * `body` with every nested `{ … }` block (string-aware) replaced by spaces of
 * equal length, so a regex over the result only sees the block's DIRECT
 * fields and offsets still line up with the original text.
 */
function zonBlankNestedBlocks(body: string): string {
  const out = body.split('');
  let depth = 0;
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') {
        if (depth > 0 && i + 1 < body.length) out[i + 1] = ' ';
        i++;
      } else if (ch === '"') inString = false;
      if (depth > 0) out[i] = ' ';
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && depth > 0) {
      depth--;
      out[i] = ' ';
      continue;
    }
    if (depth > 0) out[i] = ' ';
  }
  return out.join('');
}

/**
 * Per-offset "is inside a `"…"` literal" mask for comment-stripped ZON text,
 * so header regexes can reject a match that merely LOOKS like a field
 * (`.name = ".dependencies = .{ … }"` is a string, not the dependencies
 * block). Escaped quotes (`\"`) do not end the literal.
 */
function zonStringMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      mask[i] = 1;
      if (ch === '\\' && i + 1 < text.length) mask[++i] = 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      mask[i] = 1;
    }
  }
  return mask;
}

/**
 * Per-offset brace depth for comment-stripped ZON text, string-aware: the
 * depth AT an offset is the number of unclosed `{` before it. The file's
 * top-level `.{` puts every direct field at depth 1.
 */
function zonDepthMask(text: string): Uint8Array {
  const depth = new Uint8Array(text.length);
  let d = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    depth[i] = d;
    if (inString) {
      if (ch === '\\' && i + 1 < text.length) depth[++i] = d;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') d++;
    else if (ch === '}' && d > 0) d--;
  }
  return depth;
}

/**
 * First match of a sticky-free global `re` in `text[from, to)` whose start
 * lies outside a string literal (per `mask`) and, when `depthAt` is given, at
 * exactly that brace depth (per `depth`). Null when none.
 */
function matchZonHeader(
  text: string,
  re: RegExp,
  mask: Uint8Array,
  from: number,
  to: number,
  depth?: Uint8Array,
  depthAt?: number,
): RegExpExecArray | null {
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && m.index < to) {
    if (mask[m.index] !== 0) continue;
    if (depth !== undefined && depthAt !== undefined && depth[m.index] !== depthAt) continue;
    return m;
  }
  return null;
}

/** Pure parser split out for testability. Returns null when no path-deps found. */
export function parseZigBuildZon(raw: string): ZigBuildZonConfig | null {
  const text = stripZonComments(raw);
  const mask = zonStringMask(text);
  const depth = zonDepthMask(text);
  // Locate the `.dependencies = .{ ... }` block. Use brace counting because
  // dep entries are nested anonymous structs and a naive `}` match would stop
  // early — and only accept a header outside string literals AND at brace
  // depth 1 (a direct field of the file's top-level `.{`), so neither a
  // `.name` value spelling `.dependencies = .{` nor a `.dependencies` field
  // nested in some earlier anonymous struct can hijack it.
  const depsHeader = matchZonHeader(
    text,
    /\.dependencies\s*=\s*\.\{/g,
    mask,
    0,
    text.length,
    depth,
    1,
  );
  if (!depsHeader) return null;
  const start = depsHeader.index + depsHeader[0].length;
  const end = findZonBlockEnd(text, start);
  if (end < 0) return null;

  const pathDeps = new Map<string, string>();
  // Walk each `.<name> = .{ ... }` entry inside [start, end); the body ends
  // at the matching brace (string-aware), not at the first `}` in the text,
  // and an entry header inside a string (`.url = "…/.x = .{"`) is not an entry.
  const entryHeaderRe = /\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\.\{/g;
  let cursor = start;
  let m: RegExpExecArray | null;
  while ((m = matchZonHeader(text, entryHeaderRe, mask, cursor, end)) !== null) {
    const depName = m[1];
    const bodyStart = m.index + m[0].length;
    const bodyEnd = findZonBlockEnd(text, bodyStart);
    if (bodyEnd < 0 || bodyEnd > end) break;
    cursor = bodyEnd + 1;
    // Only a `.path` that is a DIRECT field of the entry counts: a nested
    // object inside the entry (`.foo = .{ .url = "…", .x = .{ .path = "…" } }`)
    // must not turn a URL dep into a path dep. Blank nested blocks first and
    // reject a match that starts inside a string literal.
    const body = zonBlankNestedBlocks(text.slice(bodyStart, bodyEnd));
    const pathMatch = matchZonHeader(
      body,
      /\.path\s*=\s*"([^"\n]+)"/g,
      mask.subarray(bodyStart, bodyEnd),
      0,
      body.length,
    );
    if (pathMatch) {
      pathDeps.set(depName, pathMatch[1]);
    }
  }

  if (pathDeps.size === 0) return null;
  if (isDev) {
    logger.info(`📦 Loaded ${pathDeps.size} Zig path-dep(s) from build.zig.zon`);
  }
  return { pathDeps };
}

// ============================================================================
// BUNDLED CONFIG LOADER
// ============================================================================

/**
 * Bundled language-specific configs loaded once per ingestion run — the
 * result of {@link loadImportConfigs}, and every field's type is declared
 * above in this module.
 *
 * It lives here rather than in `import-resolvers/types.ts` (its consumer, via
 * `ResolveCtx`) so the dependency runs one way: the import-resolver types
 * import this bundle, and this module imports nothing from them. Homing the
 * producer's result type with the producer also keeps `import-resolvers/
 * types.ts` free of per-language names.
 */
export interface ImportConfigs {
  tsconfigPaths: TsconfigPaths | null;
  goModule: GoModuleConfig | null;
  composerConfig: ComposerConfig | null;
  swiftPackageConfig: SwiftPackageConfig | null;
  csharpConfigs: CSharpProjectConfig[];
  /** In-repo namespace evidence gating C# suffix-fallback resolution (#1881). */
  csharpNamespaces?: CSharpNamespaceEvidence;
  /** Zig `.path` deps from build.zig.zon. Optional so call sites that
   *  hand-build ImportConfigs (tests) don't have to supply it. */
  zigBuildZon?: ZigBuildZonConfig | null;
}

/** Load all language-specific configs once for an ingestion run. */
export async function loadImportConfigs(repoRoot: string): Promise<ImportConfigs> {
  const csharpScan = await scanCSharpProject(repoRoot);
  return {
    tsconfigPaths: await loadTsconfigPaths(repoRoot),
    goModule: await loadGoModulePath(repoRoot),
    composerConfig: await loadComposerConfig(repoRoot),
    swiftPackageConfig: await loadSwiftPackageConfig(repoRoot),
    csharpConfigs: csharpScan.configs,
    csharpNamespaces: csharpScanToEvidence(csharpScan),
    zigBuildZon: await loadZigBuildConfig(repoRoot),
  };
}
