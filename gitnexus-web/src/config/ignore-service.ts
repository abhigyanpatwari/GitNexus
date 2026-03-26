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
    'vendor',           // PHP/Go
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
    'target',           // Java/Rust
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
    '__tests__',        // Often just test files
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
    '.github',          // GitHub config, not code
    '.circleci',
    '.gitlab',
    'fixtures',         // Test fixtures
    'snapshots',        // Jest snapshots
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
    '.beam',            // Erlang
    '.wasm',            // WebAssembly - important!
    '.node',            // Native Node addons
    
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



export const shouldIgnorePath = (filePath: string): boolean => {
  const normalizedPath = filePath.replace(/\\/g, '/');
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
}

