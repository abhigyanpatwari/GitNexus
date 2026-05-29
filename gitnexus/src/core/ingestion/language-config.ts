import fs from 'fs/promises';
import path from 'path';
import type { ImportConfigs } from './import-resolvers/types.js';
import type { CsharpFileStructure } from './languages/csharp/namespace-siblings.js';

import { isDev } from './utils/env.js';
import { getMaxFileSizeBytes } from './utils/max-file-size.js';

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
const CSHARP_SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj']);
const CSHARP_ROOT_NAMESPACE_RE = /<RootNamespace>\s*([^<]+)\s*<\/RootNamespace>/;

// Declared `namespace` names are extracted with the comment/string-aware
// scanner shared with the scope-resolution namespace-siblings pass
// (`extractCsharpStructureViaScanner`), not a bare regex: a regex matches
// `namespace` inside comments and string literals, seeding the #1881 gate
// with phantom namespaces. Imported lazily (and memoized) so the always-on
// `loadImportConfigs` path — every repo, every language — doesn't eagerly
// pull tree-sitter-c-sharp in via `namespace-siblings.ts` → `query.ts`.
let csharpScannerPromise: Promise<(content: string) => CsharpFileStructure> | undefined;
function getCsharpStructureScanner(): Promise<(content: string) => CsharpFileStructure> {
  if (csharpScannerPromise === undefined) {
    csharpScannerPromise = import('./languages/csharp/namespace-siblings.js').then(
      (mod) => mod.extractCsharpStructureViaScanner,
    );
  }
  return csharpScannerPromise;
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
 * work this scan introduces. Reads within a directory are issued in parallel
 * (see below); directories are still visited breadth-first.
 */
export async function scanCSharpProject(repoRoot: string): Promise<CSharpProjectScan> {
  const configs: CSharpProjectConfig[] = [];
  const declaredNamespaces = new Set<string>();
  const rootNamespaces = new Set<string>();
  const scanQueue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  let dirsScanned = 0;
  let truncated = false;
  // Per-file read cap (shared with the Phase-1 walker). A `.cs`/`.csproj` larger
  // than this is skipped unread so a single huge generated file can't pull an
  // unbounded buffer into memory during the always-on scan.
  const maxFileSizeBytes = getMaxFileSizeBytes();

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
    // Issue all file reads in this directory concurrently; csproj results stay
    // in entry order (config precedence matters) while `.cs` namespace results
    // land in shared Sets where order is irrelevant.
    const csprojReads: Promise<CSharpProjectConfig | null>[] = [];
    const csReads: Promise<boolean>[] = [];
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
      const filePath = path.join(dir, entry.name);
      if (entry.name.endsWith('.csproj')) {
        csprojReads.push(readCsprojConfig(filePath, entry.name, repoRoot, dir, maxFileSizeBytes));
      } else if (entry.name.endsWith('.cs')) {
        csReads.push(
          collectDeclaredNamespaces(filePath, declaredNamespaces, rootNamespaces, maxFileSizeBytes),
        );
      }
    }
    for (const config of await Promise.all(csprojReads)) {
      if (config) {
        configs.push(config);
        rootNamespaces.add(config.rootNamespace);
      }
    }
    // A `.cs` that was skipped (oversized) or unreadable leaves its namespaces
    // uncollected, so the scan is incomplete → mark truncated to fail the
    // #1881 gate OPEN rather than wrongly suppress an import declared there.
    for (const skipped of await Promise.all(csReads)) {
      if (skipped) truncated = true;
    }
  }

  if (truncated) {
    // Surface the fail-open so a too-small cap (or an unreadable subtree)
    // silently disabling the #1881 gate repo-wide is observable (#4) rather
    // than a mystery edge regression.
    logger.warn(
      `[csharp] namespace scan of ${repoRoot} truncated (dir cap ${CSHARP_SCAN_MAX_DIRS}, depth cap ${CSHARP_SCAN_MAX_DEPTH}, or an unreadable directory); the #1881 suffix-fallback gate fails open for unmatched usings`,
    );
  }
  return { configs, declaredNamespaces, rootNamespaces, truncated };
}

async function readCsprojConfig(
  csprojPath: string,
  fileName: string,
  repoRoot: string,
  dir: string,
  maxFileSizeBytes: number,
): Promise<CSharpProjectConfig | null> {
  try {
    const stat = await fs.stat(csprojPath);
    if (stat.size > maxFileSizeBytes) return null; // oversized .csproj → skip unread
    const content = await fs.readFile(csprojPath, 'utf-8');
    const nsMatch = content.match(CSHARP_ROOT_NAMESPACE_RE);
    const rootNamespace = nsMatch ? nsMatch[1].trim() : fileName.replace(/\.csproj$/, '');
    const projectDir = path.relative(repoRoot, dir).replace(/\\/g, '/');
    if (isDev) {
      logger.info(
        `📦 Loaded C# project: ${fileName} (namespace: ${rootNamespace}, dir: ${projectDir})`,
      );
    }
    return { rootNamespace, projectDir };
  } catch {
    return null; // can't read .csproj
  }
}

/**
 * Collect declared `namespace` names from one `.cs` file into the shared Sets.
 *
 * Returns `true` when the file was skipped (oversized) or could not be read, so
 * the caller can mark the scan truncated — its namespaces are missing, and the
 * #1881 gate must fail OPEN rather than wrongly suppress an import declared in
 * the unread file. Returns `false` on a successful read.
 */
async function collectDeclaredNamespaces(
  filePath: string,
  declaredNamespaces: Set<string>,
  rootNamespaces: Set<string>,
  maxFileSizeBytes: number,
): Promise<boolean> {
  let content: string;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > maxFileSizeBytes) {
      return true; // oversized source → skip unread, signal truncation
    }
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return true; // unreadable source → signal truncation (was a silent skip)
  }
  const scan = await getCsharpStructureScanner();
  for (const ns of scan(content).namespaces) {
    declaredNamespaces.add(ns);
    const dot = ns.indexOf('.');
    rootNamespaces.add(dot === -1 ? ns : ns.slice(0, dot));
  }
  return false;
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
