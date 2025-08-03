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
      'docs',
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
    
    // Skip Python-specific file patterns
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
    
    // Only include Python files and essential config files
    const extension = '.' + fileName.split('.').pop()?.toLowerCase();
    
    // Python source files
    if (extension === '.py') {
      return true;
    }
    
    // Essential Python config files
    const importantPythonFiles = [
      'pyproject.toml',
      'setup.py',
      'requirements.txt',
      'setup.cfg',
      'tox.ini',
      'pytest.ini',
      'Pipfile',
      'poetry.toml',
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
      'MANIFEST.in'
    ];
    
    if (importantPythonFiles.includes(fileName)) {
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
