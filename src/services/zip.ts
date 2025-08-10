import JSZip from 'jszip';

interface JSZipObjectWithData extends JSZip.JSZipObject {
  _data?: {
    uncompressedSize: number;
  };
}

interface ZipFileEntry {
  path: string;
  content: string;
  isDirectory: boolean;
  size: number;
  lastModified: Date;
}

interface ExtractionOptions {
  maxFileSize?: number;
  maxTotalSize?: number;
  allowedExtensions?: string[];
  excludeDirectories?: boolean;
}

export interface CompleteZipStructure {
  allPaths: string[];  // All file and directory paths
  fileContents: Map<string, string>;  // Only files with content
}

export class ZipService {
  private static readonly DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  private static readonly DEFAULT_MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB
  private static readonly TEXT_EXTENSIONS = new Set([
    '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.clj',
    '.html', '.htm', '.xml', '.css', '.scss', '.sass', '.less', '.json',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.md', '.txt',
    '.sql', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
    '.dockerfile', '.gitignore', '.gitattributes', '.env', '.properties'
  ]);

  constructor() {}

  /**
   * Extract complete ZIP structure including all paths and file contents
   * This is the new robust method that discovers structure first, then filters during parsing
   */
  public async extractCompleteStructure(
    file: File,
    options: ExtractionOptions = {}
  ): Promise<CompleteZipStructure> {
    const {
      maxFileSize = ZipService.DEFAULT_MAX_FILE_SIZE,
      maxTotalSize = ZipService.DEFAULT_MAX_TOTAL_SIZE
    } = options;

    if (!file) {
      throw new Error('No file provided');
    }

    if (!file.name.toLowerCase().endsWith('.zip')) {
      throw new Error('File must be a ZIP archive');
    }

    console.log(`Starting complete ZIP extraction of: ${file.name} (${file.size} bytes)`);

    try {
      const zip = await JSZip.loadAsync(file);
      const allPaths: string[] = [];
      const fileContents: Map<string, string> = new Map();
      const directories: Set<string> = new Set();
      let totalExtractedSize = 0;

      // First pass: collect all paths and identify directories
      zip.forEach((relativePath, zipObject) => {
        // Normalize path separators
        const normalizedPath = relativePath.replace(/\\/g, '/');
        
        // Add all parent directories
        const pathParts = normalizedPath.split('/');
        for (let i = 1; i < pathParts.length; i++) {
          const dirPath = pathParts.slice(0, i).join('/');
          if (dirPath && !directories.has(dirPath)) {
            directories.add(dirPath);
            allPaths.push(dirPath);
          }
        }

        // Add the current path
        if (!allPaths.includes(normalizedPath)) {
          allPaths.push(normalizedPath);
        }

        // If it's a directory entry, mark it
        if (zipObject.dir) {
          directories.add(normalizedPath.replace(/\/$/, ''));
        }
      });

      // Second pass: extract file contents
      const filePromises: Promise<void>[] = [];

      zip.forEach((relativePath, zipObject) => {
        const normalizedPath = relativePath.replace(/\\/g, '/');

        // Skip directories and empty paths
        if (zipObject.dir || !normalizedPath || normalizedPath.endsWith('/')) {
          return;
        }

        // REMOVED: shouldSkipDirectory check for complete structure discovery
        // All files are now discovered, filtering happens during parsing

        const zipObjectWithData = zipObject as JSZipObjectWithData;
        const uncompressedSize = zipObjectWithData._data?.uncompressedSize || 0;

        // Check individual file size
        if (uncompressedSize > maxFileSize) {
          console.warn(`Skipping large file: ${normalizedPath} (${uncompressedSize} bytes)`);
          return;
        }

        // Check total extracted size
        if (totalExtractedSize + uncompressedSize > maxTotalSize) {
          console.warn(`Stopping extraction: total size limit reached (${maxTotalSize} bytes)`);
          return;
        }

        // Extract file content
        const promise = zipObject.async('text')
          .then(content => {
            if (content.length > 0) {
              fileContents.set(normalizedPath, content);
              totalExtractedSize += content.length;
            }
          })
          .catch(error => {
            console.warn(`Failed to extract ${normalizedPath}:`, error);
          });

        filePromises.push(promise);
      });

      // Wait for all file extractions to complete
      await Promise.all(filePromises);

      console.log(`ZIP: Discovered ${allPaths.length} total paths, ${fileContents.size} files with content`);
      console.log(`ZIP: Total extracted size: ${totalExtractedSize} bytes`);

      return {
        allPaths: allPaths.sort(), // Sort for consistent ordering
        fileContents
      };

    } catch (error) {
      console.error('Error extracting ZIP file:', error);
      throw new Error(`Failed to extract ZIP file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async extractTextFiles(
    file: File,
    options: ExtractionOptions = {}
  ): Promise<Map<string, string>> {
    const {
      maxFileSize = ZipService.DEFAULT_MAX_FILE_SIZE,
      maxTotalSize = ZipService.DEFAULT_MAX_TOTAL_SIZE,
      allowedExtensions = Array.from(ZipService.TEXT_EXTENSIONS),
      excludeDirectories = true
    } = options;

    if (!file) {
      throw new Error('No file provided');
    }

    if (file.type !== 'application/zip' && !file.name.toLowerCase().endsWith('.zip')) {
      throw new Error('File must be a ZIP archive');
    }

    try {
      const arrayBuffer = await this.fileToArrayBuffer(file);
      const zip = new JSZip();
      const zipContent = await zip.loadAsync(arrayBuffer);
      
      const extractedFiles = new Map<string, string>();
      let totalExtractedSize = 0;
      
      const files = Object.keys(zipContent.files);
      
      for (const filePath of files) {
        const zipFile = zipContent.files[filePath];
        
        if (zipFile.dir && excludeDirectories) {
          continue;
        }
        
        if (zipFile.dir) {
          extractedFiles.set(filePath, '');
          continue;
        }
        
        // Skip directories and files that shouldn't be processed
        if (this.shouldSkipPath(filePath)) {
          console.log(`Skipping filtered path: ${filePath}`);
          continue;
        }
        
        if (!this.isTextFile(filePath, allowedExtensions)) {
          continue;
        }
        
        const zipFileWithData = zipFile as JSZipObjectWithData;
        if (zipFileWithData._data && zipFileWithData._data.uncompressedSize > maxFileSize) {
          console.warn(`Skipping file ${filePath}: exceeds maximum file size (${maxFileSize} bytes)`);
          continue;
        }
        
        if (totalExtractedSize + (zipFileWithData._data?.uncompressedSize || 0) > maxTotalSize) {
          console.warn(`Stopping extraction: total size would exceed maximum (${maxTotalSize} bytes)`);
          break;
        }
        
        try {
          const content = await zipFile.async('text');
          
          if (content.length > maxFileSize) {
            console.warn(`Skipping file ${filePath}: content exceeds maximum file size`);
            continue;
          }
          
          extractedFiles.set(filePath, content);
          totalExtractedSize += content.length;
          
        } catch (fileError) {
          console.warn(`Failed to extract file ${filePath}:`, fileError);
          continue;
        }
      }
      
      return extractedFiles;
      
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('corrupt') || error.message.includes('invalid')) {
          throw new Error('ZIP file appears to be corrupted or invalid');
        }
        throw new Error(`Failed to extract ZIP file: ${error.message}`);
      }
      throw new Error('Unknown error occurred while extracting ZIP file');
    }
  }

  public async getZipFileInfo(file: File): Promise<ZipFileEntry[]> {
    if (!file) {
      throw new Error('No file provided');
    }

    try {
      const arrayBuffer = await this.fileToArrayBuffer(file);
      const zip = new JSZip();
      const zipContent = await zip.loadAsync(arrayBuffer);
      
      const fileInfos: ZipFileEntry[] = [];
      
      for (const [path, zipFile] of Object.entries(zipContent.files)) {
        const file = zipFile as { dir: boolean; _data?: { uncompressedSize: number }; date?: Date };
        fileInfos.push({
          path,
          content: '', // Don't load content for info request
          isDirectory: file.dir,
          size: file._data?.uncompressedSize || 0,
          lastModified: file.date || new Date()
        });
      }
      
      return fileInfos.sort((a, b) => a.path.localeCompare(b.path));
      
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to read ZIP file info: ${error.message}`);
      }
      throw new Error('Unknown error occurred while reading ZIP file info');
    }
  }

  public async extractSpecificFiles(
    file: File,
    filePaths: string[]
  ): Promise<Map<string, string>> {
    if (!file) {
      throw new Error('No file provided');
    }

    if (!filePaths || filePaths.length === 0) {
      throw new Error('No file paths specified');
    }

    try {
      const arrayBuffer = await this.fileToArrayBuffer(file);
      const zip = new JSZip();
      const zipContent = await zip.loadAsync(arrayBuffer);
      
      const extractedFiles = new Map<string, string>();
      
      for (const filePath of filePaths) {
        const zipFile = zipContent.files[filePath];
        
        if (!zipFile) {
          console.warn(`File not found in ZIP: ${filePath}`);
          continue;
        }
        
        if (zipFile.dir) {
          extractedFiles.set(filePath, '');
          continue;
        }
        
        try {
          const content = await zipFile.async('text');
          extractedFiles.set(filePath, content);
        } catch (fileError) {
          console.warn(`Failed to extract file ${filePath}:`, fileError);
          continue;
        }
      }
      
      return extractedFiles;
      
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to extract specific files from ZIP: ${error.message}`);
      }
      throw new Error('Unknown error occurred while extracting specific files');
    }
  }

  public isValidZipFile(file: File): boolean {
    if (!file) return false;
    
    return (
      file.type === 'application/zip' || 
      file.type === 'application/x-zip-compressed' ||
      file.name.toLowerCase().endsWith('.zip')
    );
  }

  private async fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to read file as ArrayBuffer'));
        }
      };
      
      reader.onerror = () => {
        reject(new Error('Error reading file'));
      };
      
      reader.readAsArrayBuffer(file);
    });
  }

  private isTextFile(filePath: string, allowedExtensions: string[]): boolean {
    if (!filePath || filePath.endsWith('/')) {
      return false;
    }
    
    const extension = filePath.toLowerCase().split('.').pop();
    return extension ? allowedExtensions.includes(`.${extension}`) : false;
  }

  private shouldSkipPath(filePath: string): boolean {
    // Skip directories that shouldn't be processed
    if (this.shouldSkipDirectory(filePath)) {
      return true;
    }
    
    // Skip files that shouldn't be processed
    if (!this.shouldIncludeFile(filePath)) {
      return true;
    }
    
    return false;
  }

  private shouldSkipDirectory(path: string): boolean {
    if (!path) return true; // Skip if path is undefined/null
    
    const skipDirs = [
      // Git version control
      '.git',
      // JavaScript dependencies (common in full-stack projects)
      'node_modules',
      // Python bytecode cache
      '__pycache__',
      // Python virtual environments
      'venv',
      'env', 
      '.venv',
      'envs',
      'virtualenv',
      // Build, distribution, and temporary directories
      'build',
      'dist', 
      'logs',
      'tmp',
      '.tmp',
      // Additional common directories to skip
      'coverage',
      '.coverage',
      'htmlcov',
      'vendor',
      'deps',
      '_build',
      '.gradle',
      'bin',
      'obj',
      '.vs',
      '.vscode',
      '.idea',
      'temp'
    ];
    
    // Check each directory component in the path
    const pathParts = path.split('/');
    for (const part of pathParts) {
      const dirName = part.toLowerCase();
      
      // Check for exact matches
      if (skipDirs.includes(dirName) || dirName.startsWith('.')) {
        return true;
      }
      
      // Check for .egg-info directories
      if (dirName.endsWith('.egg-info')) {
        return true;
      }
    }
    
    // Check for virtual environment patterns anywhere in the path
    const fullPathLower = path.toLowerCase();
    const venvPatterns = [
      '/.venv/',
      '/venv/',
      '/env/',
      '/.env/',
      '/envs/',
      '/virtualenv/',
      '/site-packages/',
      '/lib/python',
      '/lib64/python',
      '/scripts/',
      '/bin/python'
    ];
    
    if (venvPatterns.some(pattern => fullPathLower.includes(pattern))) {
      return true;
    }
    
    return false;
  }

  private shouldIncludeFile(path: string): boolean {
    if (!path) return false; // Skip if path is undefined/null
    
    const fileName = path.split('/').pop() || '';
    
    // Skip hidden files except specific config files
    if (fileName.startsWith('.') && !fileName.endsWith('.env.example')) {
      return false;
    }
    
    // Skip common compiled/binary patterns
    const skipPatterns = [
      // Python compiled bytecode
      /\.pyc$/,
      /\.pyo$/,
      // Python extension modules (binary)
      /\.pyd$/,
      /\.so$/,
      // Python packages
      /\.egg$/,
      /\.whl$/,
      // Lock files
      /\.lock$/,
      /poetry\.lock$/,
      /Pipfile\.lock$/,
      // Editor swap files
      /\..*\.swp$/,
      /\..*\.swo$/,
      // OS metadata files
      /^Thumbs\.db$/,
      /^\.DS_Store$/,
      // General binary and archive files
      /\.zip$/,
      /\.tar$/,
      /\.rar$/,
      /\.7z$/,
      /\.gz$/,
      // Media files
      /\.(jpg|jpeg|png|gif|bmp|svg|ico)$/i,
      /\.(mp4|avi|mov|wmv|flv|webm)$/i,
      /\.(mp3|wav|flac|aac|ogg)$/i,
      // Document files
      /\.(pdf|doc|docx|xls|xlsx|ppt|pptx)$/i,
      // Other binary files
      /\.(exe|dll|dylib)$/i,
      // Minified files and source maps
      /\.min\.(js|css)$/,
      /\.map$/,
      // Log and temporary files
      /\.log$/,
      /\.tmp$/,
      /\.cache$/,
      /\.pid$/,
      /\.seed$/
    ];
    
    if (skipPatterns.some(pattern => pattern.test(fileName))) {
      return false;
    }
    
    // Include common source and important config files
    const extension = '.' + (fileName.split('.').pop() || '').toLowerCase();
    const includeSourceExts = new Set(['.py', '.js', '.jsx', '.ts', '.tsx']);
    if (includeSourceExts.has(extension)) {
      return true;
    }

    const importantConfigFiles = new Set([
      // Python
      'pyproject.toml', 'setup.py', 'requirements.txt', 'setup.cfg', 'tox.ini', 'pytest.ini', 'pipfile', 'poetry.toml',
      '__init__.py',
      // JS/TS ecosystem
      'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
      'tsconfig.json', 'tsconfig.base.json',
      'vite.config.ts', 'vite.config.js',
      '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.prettierrc', '.prettierrc.json',
      // Docs/licenses
      'readme.md', 'license', 'changelog.md', 'manifest.in'
    ]);
    if (importantConfigFiles.has(fileName.toLowerCase())) {
      return true;
    }

    return false;
  }

  public getDefaultTextExtensions(): string[] {
    return Array.from(ZipService.TEXT_EXTENSIONS);
  }

  public async validateZipFile(file: File): Promise<{ valid: boolean; error?: string }> {
    try {
      if (!this.isValidZipFile(file)) {
        return { valid: false, error: 'File is not a valid ZIP archive' };
      }

      const arrayBuffer = await this.fileToArrayBuffer(file);
      const zip = new JSZip();
      await zip.loadAsync(arrayBuffer);
      
      return { valid: true };
      
    } catch (error) {
      return { 
        valid: false, 
        error: error instanceof Error ? error.message : 'Unknown validation error' 
      };
    }
  }
} 
