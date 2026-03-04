import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

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
  // 'packages' removed - commonly used for monorepo source code (lerna, pnpm, yarn workspaces)
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'site-packages',
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
  '.nuxt',
  '.output',
  '.vercel',
  '.netlify',
  '.serverless',
  '_build',
  'public/build',
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
  'generated',
  'auto-generated',
  '.terraform',
  '.serverless',

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

const IGNORED_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.tiff', '.tif',
  '.psd', '.ai', '.sketch', '.fig', '.xd',

  // Archives
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz', '.tgz',

  // Binary/Compiled
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj',
  '.class', '.jar', '.war', '.ear',
  '.pyc', '.pyo', '.pyd',
  '.beam', // Erlang
  '.wasm', // WebAssembly - important!
  '.node', // Native Node addons

  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp',

  // Media
  '.mp4', '.mp3', '.wav', '.mov', '.avi', '.mkv', '.flv', '.wmv',
  '.ogg', '.webm', '.flac', '.aac', '.m4a',

  // Fonts
  '.woff', '.woff2', '.ttf', '.eot', '.otf',

  // Databases
  '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb',

  // Minified/Bundled files
  '.min.js', '.min.css', '.bundle.js', '.chunk.js',

  // Source maps (debug files, not source)
  '.map',

  // Lock files (handled separately, but also here)
  '.lock',

  // Certificates & Keys (security - don't index!)
  '.pem', '.key', '.crt', '.cer', '.p12', '.pfx',

  // Data files (often large/binary)
  '.csv', '.tsv', '.parquet', '.avro', '.feather',
  '.npy', '.npz', '.pkl', '.pickle', '.h5', '.hdf5',

  // Misc binary
  '.bin', '.dat', '.data', '.raw',
  '.iso', '.img', '.dmg',
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

const DEFAULT_REPO_IGNORE_FILE = '.gitnexusignore';

export interface RepoIgnoreOptions {
  ignoreFile?: string | null;
  ignoreProfile?: string | null;
}

interface CompiledCustomPattern {
  rawPattern: string;
  negate: boolean;
  anchored: boolean;
  hasSlash: boolean;
  directoryOnly: boolean;
  segments: string[];
}

const customPatternCache = new Map<string, CompiledCustomPattern[]>();
const segmentRegexCache = new Map<string, RegExp>();

const normalizePath = (value: string): string => (
  value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/')
);

const resolveIgnoreOverride = (
  optionValue: string | null | undefined,
  envValue: string | undefined,
): string | null => {
  if (optionValue === null) {
    return null;
  }

  if (optionValue === undefined) {
    const trimmedEnv = envValue?.trim();
    return trimmedEnv || null;
  }

  const trimmedOption = optionValue.trim();
  return trimmedOption || null;
};

const getProfileIgnoreFiles = (options: RepoIgnoreOptions = {}): string[] => {
  const files = [DEFAULT_REPO_IGNORE_FILE];

  const profile = resolveIgnoreOverride(options.ignoreProfile, process.env.GITNEXUS_IGNORE_PROFILE);
  if (profile) {
    files.push(`.gitnexusignore.${profile}`);
  }

  const explicit = resolveIgnoreOverride(options.ignoreFile, process.env.GITNEXUS_IGNORE_FILE);
  if (explicit) {
    files.push(explicit);
  }

  return Array.from(new Set(files));
};

const getIgnoreFileCacheToken = (repoPath: string, fileName: string): string => {
  const absolute = path.resolve(repoPath, fileName);
  const normalizedName = normalizePath(fileName);
  try {
    const stats = fs.statSync(absolute);
    return `${normalizedName}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return `${normalizedName}:missing`;
  }
};

const readPatternFile = (repoPath: string, fileName: string): string[] => {
  const absolute = path.resolve(repoPath, fileName);
  if (!fs.existsSync(absolute)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(absolute, 'utf-8');
    return raw
      .split(/\r?\n/g)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
};

const parseCustomPattern = (rawPattern: string): CompiledCustomPattern | null => {
  let pattern = rawPattern.trim();
  if (!pattern || pattern === '!') {
    return null;
  }

  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  }
  if (!pattern) {
    return null;
  }

  let anchored = false;
  if (pattern.startsWith('/')) {
    anchored = true;
    pattern = pattern.slice(1);
  }

  let directoryOnly = false;
  if (pattern.endsWith('/')) {
    directoryOnly = true;
    pattern = pattern.slice(0, -1);
  }

  const normalized = normalizePath(pattern);
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  if (directoryOnly) {
    // Directory-only rules should require at least one descendant segment.
    // "build/" should match "build/x" but not a file named "build".
    segments.push('*', '**');
  }

  const hasSlash = normalized.includes('/') || directoryOnly;

  return {
    rawPattern,
    negate,
    anchored,
    hasSlash,
    directoryOnly,
    segments,
  };
};

const getSegmentRegex = (patternSegment: string): RegExp => {
  const cached = segmentRegexCache.get(patternSegment);
  if (cached) {
    return cached;
  }

  const escaped = patternSegment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');

  const regex = new RegExp(`^${escaped}$`);
  segmentRegexCache.set(patternSegment, regex);
  return regex;
};

const matchSegment = (patternSegment: string, valueSegment: string): boolean => (
  getSegmentRegex(patternSegment).test(valueSegment)
);

const matchSegmentsFrom = (
  patternSegments: string[],
  pathSegments: string[],
  patternIndex: number,
  pathIndex: number,
): boolean => {
  if (patternIndex >= patternSegments.length) {
    return pathIndex >= pathSegments.length;
  }

  const current = patternSegments[patternIndex];
  if (current === '**') {
    if (patternIndex === patternSegments.length - 1) {
      return true;
    }
    for (let i = pathIndex; i <= pathSegments.length; i++) {
      if (matchSegmentsFrom(patternSegments, pathSegments, patternIndex + 1, i)) {
        return true;
      }
    }
    return false;
  }

  if (pathIndex >= pathSegments.length || !matchSegment(current, pathSegments[pathIndex])) {
    return false;
  }

  return matchSegmentsFrom(patternSegments, pathSegments, patternIndex + 1, pathIndex + 1);
};

const matchesPattern = (compiled: CompiledCustomPattern, normalizedPath: string): boolean => {
  const pathSegments = normalizedPath.split('/').filter(Boolean);

  if (!compiled.hasSlash) {
    // Slash-less patterns match any individual path segment.
    return pathSegments.some(seg => matchSegment(compiled.segments[0], seg));
  }

  if (compiled.anchored) {
    return matchSegmentsFrom(compiled.segments, pathSegments, 0, 0);
  }

  // Non-anchored slash patterns can match from any segment boundary.
  for (let start = 0; start <= pathSegments.length; start++) {
    if (matchSegmentsFrom(compiled.segments, pathSegments, 0, start)) {
      return true;
    }
  }

  return false;
};

const loadCustomPatterns = (repoPath: string, options: RepoIgnoreOptions = {}): CompiledCustomPattern[] => {
  const ignoreFiles = getProfileIgnoreFiles(options);
  const fileTokens = ignoreFiles.map((fileName) => getIgnoreFileCacheToken(repoPath, fileName));
  const key = `${path.resolve(repoPath)}::${fileTokens.join('|')}`;
  const cached = customPatternCache.get(key);
  if (cached) {
    return cached;
  }

  const compiled: CompiledCustomPattern[] = [];
  for (const fileName of ignoreFiles) {
    const rules = readPatternFile(repoPath, fileName);
    for (const rule of rules) {
      const parsed = parseCustomPattern(rule);
      if (parsed) {
        compiled.push(parsed);
      }
    }
  }

  customPatternCache.set(key, compiled);
  return compiled;
};

const isIgnoredByCustomPatterns = (
  repoPath: string,
  normalizedPath: string,
  options: RepoIgnoreOptions = {},
): boolean => {
  const patterns = loadCustomPatterns(repoPath, options);
  if (patterns.length === 0) {
    return false;
  }

  let ignored = false;
  for (const pattern of patterns) {
    if (matchesPattern(pattern, normalizedPath)) {
      ignored = !pattern.negate;
    }
  }

  return ignored;
};

const getGitIgnoredSet = (repoPath: string, relativePaths: string[]): Set<string> => {
  if (relativePaths.length === 0) {
    return new Set();
  }

  const input = `${relativePaths.join('\0')}\0`;
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
    cwd: repoPath,
    encoding: 'utf-8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error || (result.status !== 0 && result.status !== 1)) {
    return new Set();
  }

  const ignored = new Set<string>();
  const output = result.stdout || '';
  for (const row of output.split('\0')) {
    if (row) {
      ignored.add(normalizePath(row));
    }
  }

  return ignored;
};

export const shouldIgnorePath = (filePath: string): boolean => {
  const normalizedPath = normalizePath(filePath);
  const parts = normalizedPath.split('/');
  const fileName = parts[parts.length - 1];
  const fileNameLower = fileName.toLowerCase();

  // Check if any path segment is in ignore list
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

  // Ignore hidden files (starting with .)
  if (fileName.startsWith('.') && fileName !== '.') {
    // But allow some important config files
    const allowedDotFiles = ['.env', '.gitignore']; // Already in IGNORED_FILES, so this is redundant
    // Actually, let's NOT ignore all dot files - many are important configs
    // Just rely on the explicit lists above
  }

  // Ignore files that look like generated/bundled code
  if (fileNameLower.includes('.bundle.') ||
      fileNameLower.includes('.chunk.') ||
      fileNameLower.includes('.generated.') ||
      fileNameLower.endsWith('.d.ts')) { // TypeScript declaration files
    return true;
  }

  return false;
};

export const filterRepositoryPathsSync = (
  repoPath: string,
  relativePaths: string[],
  options: RepoIgnoreOptions = {},
): string[] => {
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of relativePaths) {
    const normalized = normalizePath(rawPath || '');
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    if (shouldIgnorePath(normalized)) {
      continue;
    }
    if (isIgnoredByCustomPatterns(repoPath, normalized, options)) {
      continue;
    }
    kept.push(normalized);
  }

  const gitIgnored = getGitIgnoredSet(repoPath, kept);
  return kept.filter(file => !gitIgnored.has(file));
};

export const getRelevantChangedFilesSinceCommit = (
  repoPath: string,
  lastCommit: string,
  options: RepoIgnoreOptions = {},
): { allChangedFiles: string[]; relevantChangedFiles: string[] } => {
  try {
    const diff = spawnSync('git', ['diff', '--name-only', `${lastCommit}..HEAD`], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (diff.error || diff.status !== 0) {
      return { allChangedFiles: [], relevantChangedFiles: [] };
    }

    const allChangedFiles = diff.stdout
      .split(/\r?\n/g)
      .map(normalizePath)
      .filter(Boolean);
    const relevantChangedFiles = filterRepositoryPathsSync(repoPath, allChangedFiles, options);
    return { allChangedFiles, relevantChangedFiles };
  } catch {
    return { allChangedFiles: [], relevantChangedFiles: [] };
  }
};
