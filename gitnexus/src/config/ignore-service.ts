import ignore, { type Ignore } from 'ignore';
import { existsSync } from 'fs';
import { glob } from 'glob';
import fs from 'fs/promises';
import nodePath from 'path';
import type { Path } from 'path-scurry';
import { readRepoControlFile } from './repo-control-file.js';
import { logger } from '../core/logger.js';
import { getCoreExcludesFilePath, getGitInfoExcludePath } from '../storage/git.js';

const DEFAULT_IGNORE_LIST = new Set([
  // Version Control
  '.git',
  '.svn',
  '.hg',
  '.bzr',

  // IDEs & Editors
  '.idea',
  '.vscode',
  '.vs',
  '.eclipse',
  '.settings',
  '.DS_Store',
  'Thumbs.db',

  // Dependencies
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor', // PHP/Go
  'third_party', // C/C++ (Google-style vendored dependencies)
  '3rdparty', // C/C++ (alternate spelling, also Qt convention)
  // 'packages' removed - commonly used for monorepo source code (lerna, pnpm, yarn workspaces)
  'venv',
  '.venv',
  '.env',
  // Bare `env/` can be application source or a Python virtual environment.
  // Path-aware rules below prune it at the root and wherever pyvenv.cfg marks
  // a virtual environment, while preserving ordinary nested source folders.
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'site-packages',
  'dist-packages',
  '.tox',
  'eggs',
  '.eggs',
  'lib64',
  'parts',
  'sdist',
  'wheels',

  // Build Outputs
  'dist',
  'build',
  'out',
  'output',
  'bin',
  'obj',
  'target', // Java/Rust
  '.next',
  // `.next` is Next.js's build CACHE; `_next` is the EMITTED output, and the two
  // are different directories. A Capacitor/Cordova shell copies the emitted
  // bundle to `<platform>/app/src/main/assets/public/_next/static/…`, where none
  // of the path segments hit this list — so a mobile-wrapped Next.js app had its
  // shipped bundle indexed as source, and every Route node it produced pointed at
  // a webpack chunk rather than code anyone wrote (#3007).
  //
  // The name is deliberately unanchored. No `<web-root>/_next` form matches a
  // root-level `_next/static/…`, which is the shape the reported repo has, so
  // anchoring it would miss the case it was added for. The accepted cost is a
  // hand-written directory literally named `_next`; recover one with a bare
  // `!_next/` line in `.gitnexusignore`.
  '_next',
  '.nuxt',
  '.output',
  '.vercel',
  '.netlify',
  '.serverless',
  '_build',
  // `'public/build'` used to sit here. This set is tested one path SEGMENT at a
  // time, and `isHardcodedIgnoredDirectory(name)` takes a bare directory name,
  // so a slash-containing member could never match either — it was inert. Its
  // paths were never unignored though: bare `'build'` above already prunes
  // `public/build/**`, so removing the entry changes no behavior (#3007).
  // `test/unit/ignore-build-output.test.ts` keeps the next slash-bearing entry
  // in this set — or in IGNORED_FILES, ROOT_ARTIFACT_DIRECTORIES or
  // IGNORED_EXTENSIONS — from dying the same way.
  '.parcel-cache',
  '.turbo',
  '.svelte-kit',

  // Test & Coverage
  'coverage',
  '.nyc_output',
  'htmlcov',
  '.coverage',
  '__tests__', // Often just test files
  '__mocks__',
  '.jest',

  // Logs & Temp
  'logs',
  'log',
  'tmp',
  'temp',
  'cache',
  '.cache',
  '.tmp',
  '.temp',

  // Generated/Compiled
  '.generated',
  'auto-generated',
  // Bare `generated/` can contain tracked source-of-truth code. Build output
  // remains covered by .gitignore/.gitnexusignore and the unambiguous names.
  'monaco-workers', // Monaco editor web-worker bundles generated for browser runtime
  '.terraform',

  // Documentation (optional - might want to keep)
  // 'docs',
  // 'documentation',

  // Misc
  '.husky',
  '.github', // GitHub config, not code
  '.circleci',
  '.gitlab',
  'fixtures', // Test fixtures
  'snapshots', // Jest snapshots
  '__snapshots__',
]);

// Ambiguous names that conventionally denote generated artifacts only at the
// repository root. Nested directories with these names are frequently source
// modules (for example apps/web/src/env or packages/api/generated).
const ROOT_ARTIFACT_DIRECTORIES = new Set(['env', 'generated']);

const isRootArtifactDirectory = (relativePath: string, name: string): boolean =>
  !relativePath.includes('/') && ROOT_ARTIFACT_DIRECTORIES.has(name);

const IGNORED_EXTENSIONS = new Set([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.psd',
  '.ai',
  '.sketch',
  '.fig',
  '.xd',

  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.bz2',
  '.xz',
  '.tgz',

  // Binary/Compiled
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.a',
  '.lib',
  '.o',
  '.obj',
  '.class',
  '.jar',
  '.war',
  '.ear',
  '.pyc',
  '.pyo',
  '.pyd',
  '.beam', // Erlang
  '.wasm', // WebAssembly - important!
  '.node', // Native Node addons

  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',

  // Media
  '.mp4',
  '.mp3',
  '.wav',
  '.mov',
  '.avi',
  '.mkv',
  '.flv',
  '.wmv',
  '.ogg',
  '.webm',
  '.flac',
  '.aac',
  '.m4a',

  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',

  // Databases
  '.db',
  '.sqlite',
  '.sqlite3',
  '.mdb',
  '.accdb',

  // Minified/Bundled files
  '.min.js',
  '.min.css',
  '.bundle.js',
  '.chunk.js',

  // Source maps (debug files, not source)
  '.map',

  // Lock files (handled separately, but also here)
  '.lock',

  // Certificates & Keys (security - don't index!)
  '.pem',
  '.key',
  '.crt',
  '.cer',
  '.p12',
  '.pfx',

  // Data files (often large/binary)
  '.csv',
  '.tsv',
  '.parquet',
  '.avro',
  '.feather',
  '.npy',
  '.npz',
  '.pkl',
  '.pickle',
  '.h5',
  '.hdf5',

  // Misc binary
  '.bin',
  '.dat',
  '.data',
  '.raw',
  '.iso',
  '.img',
  '.dmg',
]);

// Files to ignore by exact name
const IGNORED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.yarnrc',
  '.editorconfig',
  '.prettierrc',
  '.prettierignore',
  '.eslintignore',
  '.dockerignore',
  'Thumbs.db',
  '.DS_Store',
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'CHANGELOG.md',
  'CHANGELOG',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env.example',
]);

// The hardcoded DEFAULT_IGNORE_LIST is the "safety net" default: directories
// that are almost never source code (node_modules, .git, dist, __tests__,
// etc.). Users who legitimately need to index one of these can negate the
// hardcoded rule via a `!pattern` line in `.gitnexusignore` (#771) — same
// semantics as `.gitignore` negation. That override is applied in
// `createIgnoreFilter` below; `shouldIgnorePath` itself stays a pure
// hardcoded-list check so its callers (wiki generator, tests) get
// deterministic results independent of per-repo config.
export const shouldIgnorePath = (filePath: string): boolean => {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPathLower = normalizedPath.toLowerCase();
  const parts = normalizedPath.split('/');
  const fileName = parts[parts.length - 1];
  const fileNameLower = fileName.toLowerCase();

  if (parts.length > 0 && isRootArtifactDirectory(parts[0], parts[0])) {
    return true;
  }

  // Laravel compiles Blade templates into generated PHP cache files under
  // storage/framework/views.  Source templates live in resources/views and are
  // handled separately; compiled cache should not become source-of-truth. Keep
  // storage/framework/cache parseable unless a separate warning source is proven:
  // Laravel route/config cache files are ordinary generated PHP, not Blade.
  if (/(^|\/)storage\/framework\/views(\/|$)/.test(normalizedPathLower)) {
    return true;
  }

  // Check if any path segment is in the hardcoded ignore list.
  for (const part of parts) {
    if (DEFAULT_IGNORE_LIST.has(part)) {
      return true;
    }
  }

  // Check exact filename matches
  if (IGNORED_FILES.has(fileName) || IGNORED_FILES.has(fileNameLower)) {
    return true;
  }

  // Check extension
  const lastDotIndex = fileNameLower.lastIndexOf('.');
  if (lastDotIndex !== -1) {
    const ext = fileNameLower.substring(lastDotIndex);
    if (IGNORED_EXTENSIONS.has(ext)) return true;

    // Handle compound extensions like .min.js, .bundle.js
    const secondLastDot = fileNameLower.lastIndexOf('.', lastDotIndex - 1);
    if (secondLastDot !== -1) {
      const compoundExt = fileNameLower.substring(secondLastDot);
      if (IGNORED_EXTENSIONS.has(compoundExt)) return true;
    }
  }

  // Ignore files that look like generated/bundled code
  if (
    fileNameLower.includes('.bundle.') ||
    fileNameLower.includes('.chunk.') ||
    fileNameLower.includes('.generated.')
  ) {
    return true;
  }

  return false;
};

/** Check if a directory name is in the hardcoded ignore list */
export const isHardcodedIgnoredDirectory = (name: string): boolean => {
  return DEFAULT_IGNORE_LIST.has(name);
};

/** Apply directory ignore rules that depend on repository-relative depth. */
export const isHardcodedIgnoredDirectoryAtPath = (
  repoRoot: string,
  directoryPath: string,
): boolean => {
  const name = nodePath.basename(directoryPath);
  if (isHardcodedIgnoredDirectory(name)) return true;

  const relative = nodePath.relative(repoRoot, directoryPath).replace(/\\/g, '/');
  if (isRootArtifactDirectory(relative, name)) return true;

  return name === 'env' && existsSync(nodePath.join(directoryPath, 'pyvenv.cfg'));
};

/**
 * Load .gitignore and .gitnexusignore rules from the repo root.
 * Returns an `ignore` instance with all patterns, or null if no files found.
 */
export interface IgnoreOptions {
  /** Skip .gitignore parsing, only read .gitnexusignore. Defaults to GITNEXUS_NO_GITIGNORE env var. */
  noGitignore?: boolean;
  /** Skip core.excludesFile and $GIT_COMMON_DIR/info/exclude. Defaults to GITNEXUS_NO_GLOBAL_IGNORE env var. */
  noGlobalIgnore?: boolean;
  /** Fail repository-control reloads closed so long-lived watchers keep their prior predicate. */
  strictRepoControlFiles?: boolean;
}

const addNestedIgnoreRules = async (repoPath: string, ig: Ignore): Promise<boolean> => {
  let hasRules = false;
  const controlFiles = await glob('**/.gitignore', { cwd: repoPath, dot: true, nodir: true });
  for (const relativeFile of controlFiles) {
    if (relativeFile === '.gitignore') continue;
    const directory = nodePath.dirname(relativeFile).replace(/\\/g, '/');
    // Nested repositories are separate projects. Their control files must not
    // affect the parent scan; the boundary itself is pruned below.
    if (directory.split('/').some((segment, index, parts) =>
      existsSync(nodePath.join(repoPath, ...parts.slice(0, index + 1), '.git')),
    )) continue;
    try {
      const content = await fs.readFile(nodePath.join(repoPath, relativeFile), 'utf-8');
      const transformed = content.split(/\\r?\\n/).map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const negated = trimmed.startsWith('!');
        const pattern = negated ? trimmed.slice(1) : trimmed;
        if (pattern.startsWith('#') || !pattern) return line;
        const anchored = pattern.startsWith('/');
        const body = anchored ? pattern.slice(1) : pattern;
        const scoped = body.includes('/') ? `${directory}/${body}` : `${directory}/**/${body}`;
        return `${negated ? '!' : ''}${scoped}`;
      }).join('\n');
      ig.add(transformed);
      hasRules = true;
    } catch (err) {
      logger.warn(`  Warning: could not read nested ${relativeFile}: ${(err as Error).message}`);
    }
  }
  return hasRules;
};

export const loadIgnoreRules = async (
  repoPath: string,
  options?: IgnoreOptions,
): Promise<Ignore | null> => {
  const ig = ignore();
  let hasRules = false;

  // Mirror git's own precedence for ignore sources (gitignore(5)): patterns
  // from core.excludesFile are consulted first (lowest precedence — git's
  // real global, all-repos file), then $GIT_COMMON_DIR/info/exclude
  // (per-repo, untracked — no write access to the repo needed), then
  // .gitignore/.gitnexusignore below. Later ig.add() calls win on
  // conflicting patterns, matching git's own last-match-wins semantics (#2606).
  const skipGlobalIgnore = options?.noGlobalIgnore ?? !!process.env.GITNEXUS_NO_GLOBAL_IGNORE;
  if (!skipGlobalIgnore) {
    const globalSources = [
      getCoreExcludesFilePath(repoPath),
      getGitInfoExcludePath(repoPath),
    ].filter((candidate): candidate is string => candidate !== null);
    for (const sourcePath of globalSources) {
      try {
        const content = await fs.readFile(sourcePath, 'utf-8');
        ig.add(content);
        hasRules = true;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          logger.warn(`  Warning: could not read ${sourcePath}: ${(err as Error).message}`);
        }
      }
    }
  }

  // Allow users to bypass .gitignore parsing (e.g. when .gitignore accidentally excludes source files)
  const skipGitignore = options?.noGitignore ?? !!process.env.GITNEXUS_NO_GITIGNORE;
  const filenames = skipGitignore ? ['.gitnexusignore'] : ['.gitignore', '.gitnexusignore'];

  for (const filename of filenames) {
    try {
      const content = options?.strictRepoControlFiles
        ? await readRepoControlFile(repoPath, filename)
        : await fs.readFile(nodePath.join(repoPath, filename), 'utf-8');
      if (content === null) continue;
      ig.add(content);
      hasRules = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!options?.strictRepoControlFiles && code === 'ENOENT') continue;
      if (options?.strictRepoControlFiles) throw err;
      logger.warn(`  Warning: could not read ${filename}: ${(err as Error).message}`);
    }
  }

  if (!skipGitignore) hasRules = (await addNestedIgnoreRules(repoPath, ig)) || hasRules;

  return hasRules ? ig : null;
};

/**
 * Build a synchronous predicate for long-lived filesystem watchers.
 *
 * Unlike {@link createIgnoreFilter}, callers pass ordinary absolute or
 * repository-relative paths instead of path-scurry `Path` objects. The rule
 * precedence deliberately mirrors the scanner: explicit negations win over
 * hardcoded defaults unless a more-specific rule re-ignores the path.
 */
export const createWatchIgnorePredicate = async (
  repoPath: string,
  options?: IgnoreOptions,
): Promise<(candidatePath: string, isDirectory?: boolean) => boolean> => {
  const ig = await loadIgnoreRules(repoPath, { ...options, strictRepoControlFiles: true });
  const repoRoot = nodePath.resolve(repoPath);

  return (candidatePath: string, isDirectory = false): boolean => {
    const absolute = nodePath.isAbsolute(candidatePath)
      ? nodePath.resolve(candidatePath)
      : nodePath.resolve(repoRoot, candidatePath);
    const rel = nodePath.relative(repoRoot, absolute).replace(/\\/g, '/');
    if (!rel) return false;
    if (rel === '..' || rel.startsWith('../') || nodePath.isAbsolute(rel)) return true;

    if (ig && hasExplicitUnignore(ig, rel) && !ig.ignores(isDirectory ? `${rel}/` : rel)) {
      return false;
    }

    if (ig && ig.ignores(isDirectory ? `${rel}/` : rel)) return true;
    if (isDirectory && isHardcodedIgnoredDirectoryAtPath(repoRoot, absolute)) return true;
    return shouldIgnorePath(rel);
  };
};

/**
 * Walk ancestor segments of `rel` and check whether `.gitnexusignore`
 * (or `.gitignore`) contains an explicit `!pattern` negation that
 * applies. Returns true as soon as any segment — or the path itself —
 * is matched by a negation rule.
 *
 * Why this exists (#771): the hardcoded DEFAULT_IGNORE_LIST would
 * otherwise block indexing of directories like `__tests__/` even when
 * the user has an explicit `!__tests__/` line in `.gitnexusignore`.
 * Mirroring `.gitignore` negation semantics: a user's explicit
 * unignore of a parent directory implicitly unignores everything
 * underneath, so we walk the ancestor chain rather than only testing
 * the leaf.
 *
 * The `ignore` package's `test(path)` returns `{ignored, unignored}`;
 * `unignored: true` is the "a negation rule matched this path"
 * signal. Children of a negated directory return
 * `{ignored: false, unignored: false}` on a direct test, which is why
 * we also walk the ancestors here.
 */
const hasExplicitUnignore = (ig: Ignore, rel: string): boolean => {
  // Direct match on the path (as a file).
  if (ig.test(rel).unignored) return true;
  // Direct match on the path treated as a directory — `!dir/` matches
  // here when rel is the directory itself.
  if (ig.test(rel + '/').unignored) return true;
  // Walk ancestor segments. `!parent/` should propagate to every
  // descendant the same way `.gitignore` negation propagates.
  const parts = rel.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join('/') + '/';
    if (ig.test(ancestor).unignored) return true;
  }
  return false;
};

/**
 * Create a glob-compatible ignore filter combining:
 * - .gitignore / .gitnexusignore patterns (via `ignore` package)
 * - Hardcoded DEFAULT_IGNORE_LIST, IGNORED_EXTENSIONS, IGNORED_FILES
 *
 * Returns an IgnoreLike object for glob's `ignore` option,
 * enabling directory-level pruning during traversal.
 *
 * Precedence (#771): user's `.gitnexusignore` negation patterns take
 * priority over the hardcoded list, matching `.gitignore` semantics.
 * An explicit `!pattern` rule unignores descendants even when they
 * would otherwise be blocked by DEFAULT_IGNORE_LIST — UNLESS a more
 * specific rule in the same file re-ignores a subset (e.g.
 * `!__tests__/` paired with `__tests__/generated/` blocks the child
 * while leaving the parent negated). Last-match-wins is enforced by
 * consulting `ig.ignores(rel)` after `hasExplicitUnignore`.
 */
export const createIgnoreFilter = async (repoPath: string, options?: IgnoreOptions) => {
  const ig = await loadIgnoreRules(repoPath, options);

  return {
    ignored(p: Path): boolean {
      // The `ignore` package expects POSIX separators; path-scurry can surface
      // native separators on Windows when called through glob.
      const rel = p.relative().replace(/\\/g, '/');
      if (!rel) return false;
      // User's .gitnexusignore negation takes precedence over hardcoded
      // rules (#771). If any ancestor or the path itself was explicitly
      // unignored AND no more-specific rule re-ignores this exact path,
      // allow it through. The `!ig.ignores(rel)` guard matches
      // .gitignore's last-match-wins semantics: `!__tests__/` followed
      // by `__tests__/generated/` negates the parent but still blocks
      // the re-ignored child.
      if (ig && hasExplicitUnignore(ig, rel) && !ig.ignores(rel)) return false;
      // Check .gitignore / .gitnexusignore patterns
      if (ig && ig.ignores(rel)) return true;
      // Fall back to hardcoded rules
      return shouldIgnorePath(rel);
    },
    childrenIgnored(p: Path): boolean {
      // Note: dot-directories (.git, .vscode, etc.) are primarily excluded by
      // glob's `dot: false` option in filesystem-walker.ts. The hardcoded
      // list check below is defense-in-depth — do not remove `dot: false`
      // assuming this covers it.
      const rel = p.relative().replace(/\\/g, '/');
      // User's .gitnexusignore negation takes precedence (#771) — if the
      // user explicitly unignored this directory or any ancestor via a
      // !pattern rule, allow descent even if the directory name is in
      // DEFAULT_IGNORE_LIST. The `!ig.ignores(rel + '/')` guard keeps
      // last-match-wins: `!__tests__/` + `__tests__/generated/` still
      // blocks descent into `__tests__/generated/`.
      if (ig && rel && hasExplicitUnignore(ig, rel) && !ig.ignores(rel + '/')) return false;
      // A nested Git checkout is a separate repository. Stop at its root so
      // the parent analysis never indexes submodule/vendor working trees (#2675).
      if (rel && existsSync(nodePath.join(repoPath, rel, '.git'))) return true;
      // Hardcoded and path-aware rules prune whole trees before glob walks them.
      if (rel && isHardcodedIgnoredDirectoryAtPath(repoPath, nodePath.join(repoPath, rel))) {
        return true;
      }
      // Check against .gitignore / .gitnexusignore patterns.
      // Since childrenIgnored is only called for directories, always test with
      // a trailing slash. This ensures directory-only negation patterns (e.g.
      // `!iOS/`) are applied correctly — without the slash, `ig.ignores('iOS')`
      // treats the path as a file and misses the negation.
      // Bare-name patterns (e.g. `local`) still match `local/` per gitignore spec:
      // the `ignore` package normalizes `dir` and `dir/` to match directories.
      // See: https://github.com/kaelzhang/node-ignore#2-filenames-and-dirnames
      if (ig && rel && ig.ignores(rel + '/')) return true;
      return false;
    },
  };
};
