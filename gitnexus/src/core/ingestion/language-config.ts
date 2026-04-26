import fs from 'fs/promises';
import path from 'path';
import type { ImportConfigs } from './import-resolvers/types.js';

import { isDev } from './utils/env.js';

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

/** Swift Package Manager module config */
export interface SwiftPackageConfig {
  /** Map of target name -> source directory path (e.g., "SiuperModel" -> "Package/Sources/SiuperModel") */
  targets: Map<string, string>;
}

/** Zig package config parsed from build.zig.zon */
export interface ZigBuildZonConfig {
  /**
   * Map of dependency name -> repo-relative path for `.path = "..."` entries.
   * `.url`-based deps cannot be resolved to a repo-local file (they unpack
   * into a build cache outside the repo) and so are not included here.
   */
  pathDeps: Map<string, string>;
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
          console.log(`📦 Loaded ${aliases.size} path aliases from ${filename}`);
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
        console.log(`📦 Loaded Go module path: ${match[1]}`);
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
      console.log(`📦 Loaded ${psr4.size} PSR-4 mappings from composer.json`);
    }
    return { psr4 };
  } catch {
    return null;
  }
}

/**
 * Parse .csproj files to extract RootNamespace.
 * Scans the repo root for .csproj files and returns configs for each.
 */
export async function loadCSharpProjectConfig(repoRoot: string): Promise<CSharpProjectConfig[]> {
  const configs: CSharpProjectConfig[] = [];
  // BFS scan for .csproj files up to 5 levels deep, cap at 100 dirs to avoid runaway scanning
  const scanQueue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  const maxDepth = 5;
  const maxDirs = 100;
  let dirsScanned = 0;

  while (scanQueue.length > 0 && dirsScanned < maxDirs) {
    const { dir, depth } = scanQueue.shift()!;
    dirsScanned++;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && depth < maxDepth) {
          // Skip common non-project directories
          if (
            entry.name === 'node_modules' ||
            entry.name === '.git' ||
            entry.name === 'bin' ||
            entry.name === 'obj'
          )
            continue;
          scanQueue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
        if (entry.isFile() && entry.name.endsWith('.csproj')) {
          try {
            const csprojPath = path.join(dir, entry.name);
            const content = await fs.readFile(csprojPath, 'utf-8');
            const nsMatch = content.match(/<RootNamespace>\s*([^<]+)\s*<\/RootNamespace>/);
            const rootNamespace = nsMatch ? nsMatch[1].trim() : entry.name.replace(/\.csproj$/, '');
            const projectDir = path.relative(repoRoot, dir).replace(/\\/g, '/');
            configs.push({ rootNamespace, projectDir });
            if (isDev) {
              console.log(
                `📦 Loaded C# project: ${entry.name} (namespace: ${rootNamespace}, dir: ${projectDir})`,
              );
            }
          } catch {
            // Can't read .csproj
          }
        }
      }
    } catch {
      // Can't read directory
    }
  }
  return configs;
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
      console.log(`📦 Loaded ${targets.size} Swift package targets`);
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
 *   - Only the top-level `.dependencies = .{ ... }` block is parsed; nested
 *     or aliased blocks are ignored.
 *   - Each dep entry is matched by a single shape: `.<name> = .{ ... }`
 *     where `<name>` is a bare identifier (no `@"…"` quoted form).
 *   - Only `.path = "..."` is captured. `.url` deps are left unresolved
 *     because their unpacked location lives outside the repo
 *     (.zig-cache/p/<hash>/ or ~/.cache/zig/p/<hash>/) and is therefore
 *     not in our `allFilePaths` set.
 *   - Comments (`//`) inside the dep block are not stripped; if a `.path`
 *     is commented out it will still match. Acceptable for an indexer.
 */
export async function loadZigBuildZon(repoRoot: string): Promise<ZigBuildZonConfig | null> {
  try {
    const zonPath = path.join(repoRoot, 'build.zig.zon');
    const raw = await fs.readFile(zonPath, 'utf-8');
    return parseZigBuildZon(raw);
  } catch {
    return null;
  }
}

/** Pure parser split out for testability. Returns null when no path-deps found. */
export function parseZigBuildZon(raw: string): ZigBuildZonConfig | null {
  // Locate the `.dependencies = .{ ... }` block. Use brace counting because
  // dep entries are nested anonymous structs and a naive `}` match would stop early.
  const depsHeader = raw.match(/\.dependencies\s*=\s*\.\{/);
  if (!depsHeader) return null;
  const start = depsHeader.index! + depsHeader[0].length;
  let depth = 1;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const block = raw.slice(start, end);

  const pathDeps = new Map<string, string>();
  // Match each `.<name> = .{ ... }` entry; capture the entry body.
  const entryRe = /\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\.\{([\s\S]*?)\}\s*,?/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(block)) !== null) {
    const depName = m[1];
    const body = m[2];
    const pathMatch = body.match(/\.path\s*=\s*"([^"\n]+)"/);
    if (pathMatch) {
      pathDeps.set(depName, pathMatch[1]);
    }
  }

  if (pathDeps.size === 0) return null;
  if (isDev) {
    console.log(`📦 Loaded ${pathDeps.size} Zig path-dep(s) from build.zig.zon`);
  }
  return { pathDeps };
}

// ============================================================================
// BUNDLED CONFIG LOADER
// ============================================================================

/** Load all language-specific configs once for an ingestion run. */
export async function loadImportConfigs(repoRoot: string): Promise<ImportConfigs> {
  return {
    tsconfigPaths: await loadTsconfigPaths(repoRoot),
    goModule: await loadGoModulePath(repoRoot),
    composerConfig: await loadComposerConfig(repoRoot),
    swiftPackageConfig: await loadSwiftPackageConfig(repoRoot),
    csharpConfigs: await loadCSharpProjectConfig(repoRoot),
    zigBuildZon: await loadZigBuildZon(repoRoot),
  };
}
