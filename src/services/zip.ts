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
    const extension = this.getFileExtension(filePath);
    return allowedExtensions.includes(extension);
  }

  private getFileExtension(filePath: string): string {
    const lastDotIndex = filePath.lastIndexOf('.');
    if (lastDotIndex === -1) return '';
    
    return filePath.substring(lastDotIndex).toLowerCase();
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
