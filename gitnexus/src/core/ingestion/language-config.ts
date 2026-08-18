import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import type { CsharpStructureLineScanner } from './languages/csharp/namespace-siblings.js';

import { isDev } from './utils/env.js';

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
  /** PSR-4 entries sorted by namespace length descending (longest match wins).
   *  Cached once at config load time to avoid re-sorting on every import. */
  psr4Sorted?: readonly [string, string][];
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

/** Zig package config parsed from build.zig.zon */
export interface ZigBuildZonConfig {
  /**
   * Map of dependency name -> the raw `.path = "..."` value, exactly as
   * written in build.zig.zon (relative to the repo root, and possibly
   * escaping it: `../local_dep`). Consumers normalize — see
   * `normalizeZigDepPath` below, which rejects absolute
   * and repo-escaping values. `.url`-based deps cannot be resolved to a
   * repo-local file (they unpack into a build cache outside the repo) and so
   * are not included here.
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
    const composer = JSON.parse(raw);
    const psr4Raw = composer.autoload?.['psr-4'] ?? {};
    const psr4Dev = composer['autoload-dev']?.['psr-4'] ?? {};
    const merged = { ...psr4Raw, ...psr4Dev };

    const psr4 = new Map<string, string>();
    for (const [ns, dir] of Object.entries(merged)) {
      const nsNorm = (ns as string).replace(/\\+$/, '');
      const dirNorm = (dir as string).replace(/\\/g, '/').replace(/\/+$/, '');
      psr4.set(nsNorm, dirNorm);
    }

    if (isDev) {
      logger.info(`📦 Loaded ${psr4.size} PSR-4 mappings from composer.json`);
    }
    return { psr4 };
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
 * Parse build.zig.zon to extract `.path = "..."` dependency mappings.
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
export async function loadZigBuildZon(repoRoot: string): Promise<ZigBuildZonConfig | null> {
  let config: ZigBuildZonConfig | null;
  try {
    const zonPath = path.join(repoRoot, 'build.zig.zon');
    const raw = await fs.readFile(zonPath, 'utf-8');
    config = parseZigBuildZon(raw);
  } catch {
    return null;
  }
  if (config === null) return null;

  // A path dep's importable root is whatever ITS build.zig declares, not a
  // fixed layout: read `root_source_file` per `addModule` and remember it
  // repo-relative. Best effort — an unreadable build.zig just leaves the
  // conventional-layout fallback in place.
  const moduleRoots = new Map<string, readonly string[]>();
  for (const [depName, depPath] of config.pathDeps) {
    const rel = normalizeZigDepPath(depPath);
    if (rel === null) continue;
    let buildZig: string;
    try {
      buildZig = await fs.readFile(path.join(repoRoot, rel, 'build.zig'), 'utf-8');
    } catch {
      continue;
    }
    const roots = parseZigBuildModuleRoots(buildZig, depName).map((r) =>
      rel === '' ? r : `${rel}/${r}`,
    );
    if (roots.length > 0) moduleRoots.set(depName, roots);
  }
  return moduleRoots.size > 0 ? { ...config, moduleRoots } : config;
}

/**
 * Normalize a `.path` value from build.zig.zon into a repo-relative form.
 * Returns null for paths that escape the repo root (start with `..`) or
 * are absolute — those point to files we don't index. `.` / `./` normalize
 * to the empty string (the repo root itself). Shared with the import
 * resolver so both sides agree on which deps are in-repo.
 */
export function normalizeZigDepPath(depPath: string): string | null {
  // POSIX (`/x`) and Windows (`C:\x`, `C:/x`) absolute paths both point
  // outside the repository.
  if (depPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(depPath)) return null;
  const parts: string[] = [];
  for (const part of depPath.replace(/\\/g, '/').split('/')) {
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
  const namedRe =
    /addModule\(\s*"([^"\n]+)"\s*,\s*\.\{[^}]*?\.root_source_file\s*=\s*b\.path\(\s*"([^"\n]+)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(buildZig)) !== null) {
    if (m[1] === preferredName) add(named, m[2]!);
  }
  const anyRe = /\.root_source_file\s*=\s*b\.path\(\s*"([^"\n]+)"\s*\)/g;
  while ((m = anyRe.exec(buildZig)) !== null) add(unnamed, m[1]!);
  return [...named, ...unnamed];
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
    zigBuildZon: await loadZigBuildZon(repoRoot),
  };
}
