/**
 * Shared utilities for path handling, deduplication, and common operations
 * Consolidates duplicated code across processors
 */

// Path utilities for browser compatibility
export const pathUtils = {
  extname: (filePath: string): string => {
    const lastDot = filePath.lastIndexOf('.');
    return lastDot === -1 ? '' : filePath.substring(lastDot);
  },
  
  dirname: (filePath: string): string => {
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return lastSlash === -1 ? '.' : filePath.substring(0, lastSlash);
  },
  
  resolve: (basePath: string, relativePath: string): string => {
    // Simple relative path resolution
    if (relativePath.startsWith('./')) {
      return basePath + '/' + relativePath.substring(2);
    } else if (relativePath.startsWith('../')) {
      const parts = basePath.split('/');
      const relativeParts = relativePath.split('/');
      let upCount = 0;
      for (const part of relativeParts) {
        if (part === '..') upCount++;
        else break;
      }
      const resultParts = parts.slice(0, -upCount);
      const remainingParts = relativeParts.slice(upCount);
      return [...resultParts, ...remainingParts].join('/');
    }
    return basePath + '/' + relativePath;
  },
  
  join: (...parts: string[]): string => {
    return parts.join('/').replace(/\/+/g, '/');
  },
  
  normalize: (filePath: string): string => {
    return filePath.replace(/\\/g, '/');
  },
  
  getFileExtension: (filePath: string): string => {
    if (!filePath) return '';
    const lastDotIndex = filePath.lastIndexOf('.');
    if (lastDotIndex === -1) {
      return '';
    }
    return filePath.substring(lastDotIndex);
  },
  
  getFileName: (filePath: string): string => {
    return filePath.split('/').pop() || filePath;
  }
};

// Performance optimizations using Sets instead of Arrays
export class OptimizedSet<T> {
  private items: Set<T>;
  private _array: T[] | null = null;

  constructor(items?: Iterable<T>) {
    this.items = new Set(items);
  }

  add(item: T): this {
    this.items.add(item);
    this._array = null; // Invalidate cache
    return this;
  }

  has(item: T): boolean {
    return this.items.has(item);
  }

  delete(item: T): boolean {
    const result = this.items.delete(item);
    if (result) {
      this._array = null; // Invalidate cache
    }
    return result;
  }

  clear(): void {
    this.items.clear();
    this._array = null;
  }

  get size(): number {
    return this.items.size;
  }

  // Convert to array only when needed and cache the result
  toArray(): T[] {
    if (this._array === null) {
      this._array = Array.from(this.items);
    }
    return this._array;
  }

  forEach(callback: (value: T) => void): void {
    this.items.forEach(callback);
  }

  filter(predicate: (value: T) => boolean): T[] {
    return this.toArray().filter(predicate);
  }

  map<U>(mapper: (value: T) => U): U[] {
    return this.toArray().map(mapper);
  }

  some(predicate: (value: T) => boolean): boolean {
    for (const item of this.items) {
      if (predicate(item)) return true;
    }
    return false;
  }

  every(predicate: (value: T) => boolean): boolean {
    for (const item of this.items) {
      if (!predicate(item)) return false;
    }
    return true;
  }
}

// Duplicate detection using Sets for O(1) performance
export class DuplicateDetector<T> {
  private seen: Set<string>;
  private keyExtractor: (item: T) => string;

  constructor(keyExtractor: (item: T) => string) {
    this.seen = new Set();
    this.keyExtractor = keyExtractor;
  }

  isDuplicate(item: T): boolean {
    const key = this.keyExtractor(item);
    return this.seen.has(key);
  }

  markAsSeen(item: T): void {
    const key = this.keyExtractor(item);
    this.seen.add(key);
  }

  checkAndMark(item: T): boolean {
    const key = this.keyExtractor(item);
    if (this.seen.has(key)) {
      return true; // Is duplicate
    }
    this.seen.add(key);
    return false; // Not duplicate
  }

  clear(): void {
    this.seen.clear();
  }

  get size(): number {
    return this.seen.size;
  }
}

// Language detection utilities
export const languageUtils = {
  getLanguageFromExtension: (extension: string): string => {
    switch (extension.toLowerCase()) {
      case '.py':
      case '.pyx':
      case '.pyi':
        return 'python';
      case '.js':
      case '.mjs':
      case '.cjs':
      case '.jsx':
        return 'javascript';
      case '.ts':
        return 'typescript';
      case '.tsx':
        return 'tsx';
      case '.java':
        return 'java';
      case '.cpp':
      case '.cc':
      case '.cxx':
        return 'cpp';
      case '.c':
        return 'c';
      case '.h':
      case '.hpp':
        return 'header';
      case '.cs':
        return 'csharp';
      case '.php':
        return 'php';
      case '.rb':
        return 'ruby';
      case '.go':
        return 'go';
      case '.rs':
        return 'rust';
      case '.swift':
        return 'swift';
      case '.kt':
        return 'kotlin';
      case '.scala':
        return 'scala';
      case '.dart':
        return 'dart';
      default:
        return 'unknown';
    }
  },

  isSourceFile: (filePath: string): boolean => {
    if (!filePath) return false;
    const fileName = pathUtils.getFileName(filePath);
    
    // Include special files
    if (fileName === '__init__.py') return true;
    
    const extension = pathUtils.getFileExtension(filePath).toLowerCase();
    const sourceExtensions = new Set([
      '.py', '.js', '.jsx', '.ts', '.tsx', '.java', '.cpp', '.c', '.h', '.hpp',
      '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.dart'
    ]);
    return sourceExtensions.has(extension);
  },

  isConfigFile: (filePath: string): boolean => {
    if (!filePath) return false;
    const fileName = pathUtils.getFileName(filePath);
    
    const configFiles = new Set([
      'package.json', 'tsconfig.json', 'tsconfig.base.json',
      'vite.config.ts', 'vite.config.js', 'webpack.config.js',
      '.eslintrc', '.eslintrc.json', '.eslintrc.js',
      '.prettierrc', '.prettierrc.json',
      'docker-compose.yml', 'docker-compose.yaml',
      'dockerfile', 'Dockerfile',
      '.env', '.env.example', '.env.local', '.env.production',
      'pyproject.toml', 'setup.py', 'requirements.txt', 'poetry.lock',
      'Cargo.toml', 'Cargo.lock',
      'pom.xml', 'build.gradle', 'build.gradle.kts'
    ]);
    
    return configFiles.has(fileName.toLowerCase());
  }
};

// Memory-efficient batch processing
export class BatchProcessor<T, R> {
  private batchSize: number;
  private processor: (batch: T[]) => Promise<R[]>;

  constructor(batchSize: number, processor: (batch: T[]) => Promise<R[]>) {
    this.batchSize = batchSize;
    this.processor = processor;
  }

  async processAll(
    items: T[], 
    progressCallback?: (processed: number, total: number) => void
  ): Promise<R[]> {
    const results: R[] = [];
    const total = items.length;

    for (let i = 0; i < items.length; i += this.batchSize) {
      const batch = items.slice(i, i + this.batchSize);
      const batchResults = await this.processor(batch);
      results.push(...batchResults);

      if (progressCallback) {
        progressCallback(Math.min(i + this.batchSize, total), total);
      }

      // Small delay to prevent blocking
      if (i + this.batchSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }

    return results;
  }
}

// String utilities for sanitization and validation
export const stringUtils = {
  sanitize: (input: string, maxLength = 1000): string => {
    return input
      .trim()
      .replace(/[<>]/g, '') // Remove potential XSS vectors
      .substring(0, maxLength);
  },

  isValidIdentifier: (name: string): boolean => {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
  },

  extractIdentifiers: (text: string): string[] => {
    const identifiers = text.match(/[a-zA-Z_][a-zA-Z0-9_]*/g);
    return identifiers ? [...new Set(identifiers)] : [];
  },

  levenshteinDistance: (a: string, b: string): number => {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }
};