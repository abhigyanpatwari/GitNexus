import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import type { ImportConfigs } from './import-resolvers/types.js';
import type { CsharpStructureLineScanner } from './languages/csharp/namespace-siblings.js';

import { isDev } from './utils/env.js';

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
    for (let i = 0; i < csprojNames.length; i += CSHARP_SCAN_READ_CONCURRENCY) {
      const batch = csprojNames.slice(i, i + CSHARP_SCAN_READ_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((name) => readCsprojConfig(path.join(dir, name), name, repoRoot, dir)),
      );
      for (const r of settled) {
        const config = r.status === 'fulfilled' ? r.value : null;
        if (config) {
          configs.push(config);
          rootNamespaces.add(config.rootNamespace);
        }
      }
    }
    for (let i = 0; i < csNames.length; i += CSHARP_SCAN_READ_CONCURRENCY) {
      const batch = csNames.slice(i, i + CSHARP_SCAN_READ_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((name) =>
          collectDeclaredNamespaces(path.join(dir, name), declaredNamespaces, rootNamespaces),
        ),
      );
      // A `.cs` that was unreadable (or whose read/scan unexpectedly rejected)
      // leaves its namespaces uncollected → mark truncated to fail the #1881
      // gate OPEN rather than wrongly suppress an import. The scan streams each
      // file, so file size no longer trips truncation.
      for (const r of settled) {
        if (r.status !== 'fulfilled' || r.value === 'truncated') truncated = true;
      }
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

// ============================================================================
// BUNDLED CONFIG LOADER
// ============================================================================

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
  };
}
