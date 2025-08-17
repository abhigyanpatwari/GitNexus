/**
 * Memory Management Service
 * Provides resource limits, cleanup, and monitoring for the GitNexus application
 */

export interface MemoryConfig {
  maxMemoryMB: number;
  cleanupThresholdMB: number;
  gcIntervalMs: number;
  maxFileSizeMB: number;
  maxFilesInMemory: number;
}

export interface MemoryStats {
  usedMemoryMB: number;
  totalMemoryMB: number;
  fileCount: number;
  lastCleanup: Date;
  warnings: string[];
}

export class MemoryManager {
  private static instance: MemoryManager;
  private config: MemoryConfig;
  private fileCache: Map<string, { content: string; size: number; lastAccess: Date }>;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private memoryWarnings: string[] = [];

  private constructor() {
    this.config = {
      maxMemoryMB: 512,
      cleanupThresholdMB: 400,
      gcIntervalMs: 30000,
      maxFileSizeMB: 10,
      maxFilesInMemory: 1000
    };
    this.fileCache = new Map();
    this.startCleanupTimer();
  }

  public static getInstance(): MemoryManager {
    if (!MemoryManager.instance) {
      MemoryManager.instance = new MemoryManager();
    }
    return MemoryManager.instance;
  }

  /**
   * Configure memory limits
   */
  public configure(config: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current memory statistics
   */
  public getStats(): MemoryStats {
    const totalSize = Array.from(this.fileCache.values())
      .reduce((sum, item) => sum + item.size, 0);
    
    return {
      usedMemoryMB: Math.round(totalSize / (1024 * 1024)),
      totalMemoryMB: this.config.maxMemoryMB,
      fileCount: this.fileCache.size,
      lastCleanup: new Date(),
      warnings: [...this.memoryWarnings]
    };
  }

  /**
   * Cache file content with memory limits
   */
  public cacheFile(filePath: string, content: string): boolean {
        const size = typeof Blob !== 'undefined' ? new Blob([content]).size : Buffer.byteLength(content, 'utf-8');
    
    // Check file size limit
    if (size > this.config.maxFileSizeMB * 1024 * 1024) {
      this.addWarning(`File too large: ${filePath} (${Math.round(size / (1024 * 1024))}MB)`);
      return false;
    }

    // Check memory limit
    const currentTotal = Array.from(this.fileCache.values())
      .reduce((sum, item) => sum + item.size, 0);
    
    if (currentTotal + size > this.config.maxMemoryMB * 1024 * 1024) {
      this.performCleanup();
    }

    // Check file count limit
    if (this.fileCache.size >= this.config.maxFilesInMemory) {
      this.evictOldestFiles();
    }

    this.fileCache.set(filePath, {
      content,
      size,
      lastAccess: new Date()
    });

    return true;
  }

  /**
   * Get cached file content
   */
  public getFile(filePath: string): string | null {
    const item = this.fileCache.get(filePath);
    if (item) {
      item.lastAccess = new Date();
      return item.content;
    }
    return null;
  }

  /**
   * Remove file from cache
   */
  public removeFile(filePath: string): void {
    this.fileCache.delete(filePath);
  }

  /**
   * Clear all cached files
   */
  public clearCache(): void {
    this.fileCache.clear();
    this.memoryWarnings = [];
  }

  /**
   * Force cleanup when memory is low
   */
  public forceCleanup(): void {
    this.performCleanup();
  }

  private performCleanup(): void {
    const currentTotal = Array.from(this.fileCache.values())
      .reduce((sum, item) => sum + item.size, 0);

    if (currentTotal > this.config.cleanupThresholdMB * 1024 * 1024) {
      // Remove least recently used files
      const sorted = Array.from(this.fileCache.entries())
        .sort((a, b) => a[1].lastAccess.getTime() - b[1].lastAccess.getTime());

      const toRemove = Math.ceil(sorted.length * 0.2); // Remove 20%
      for (let i = 0; i < toRemove; i++) {
        this.fileCache.delete(sorted[i][0]);
      }

      this.addWarning(`Cleanup performed: removed ${toRemove} files`);
    }

    // Trigger garbage collection if available
    if (typeof globalThis.gc === 'function') {
      globalThis.gc();
    }
  }

  private evictOldestFiles(): void {
    const sorted = Array.from(this.fileCache.entries())
      .sort((a, b) => a[1].lastAccess.getTime() - b[1].lastAccess.getTime());
    
    const toRemove = Math.max(1, Math.floor(this.config.maxFilesInMemory * 0.1));
    for (let i = 0; i < toRemove; i++) {
      this.fileCache.delete(sorted[i][0]);
    }
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.config.gcIntervalMs);
  }

  private addWarning(message: string): void {
    this.memoryWarnings.push(message);
    if (this.memoryWarnings.length > 10) {
      this.memoryWarnings.shift();
    }
    
    console.warn(`[MemoryManager] ${message}`);
  }

  /**
   * Stop the cleanup timer
   */
  public destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clearCache();
  }
}