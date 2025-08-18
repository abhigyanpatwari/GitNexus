/**
 * Streaming processor for handling large files with memory constraints
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { MemoryManager } from '../services/memory-manager';
import { ErrorRecoveryService } from './error-handler';

export interface StreamingOptions {
  chunkSize?: number;
  maxFileSize?: number;
  encoding?: BufferEncoding;
  parallelProcessing?: boolean;
  maxConcurrency?: number;
}

export interface ProcessingResult<T> {
  data: T[];
  processedLines: number;
  skippedLines: number;
  errors: ProcessingError[];
  processingTime: number;
}

export interface ProcessingError {
  lineNumber: number;
  error: string;
  content?: string;
}

export interface ProgressCallback<T> {
  (progress: {
    processedLines: number;
    totalLines?: number;
    percentage?: number;
    currentChunk: T[];
  }): void;
}

export class StreamingProcessor {
  private static instance: StreamingProcessor;
  private readonly memoryManager: MemoryManager;
  private readonly errorRecovery: ErrorRecoveryService;

  private constructor() {
    this.memoryManager = MemoryManager.getInstance();
    this.errorRecovery = ErrorRecoveryService.getInstance();
  }

  static getInstance(): StreamingProcessor {
    if (!StreamingProcessor.instance) {
      StreamingProcessor.instance = new StreamingProcessor();
    }
    return StreamingProcessor.instance;
  }

  /**
   * Process a file line by line using streaming
   */
  async processFile<T>(
    filePath: string,
    lineProcessor: (line: string, lineNumber: number) => Promise<T | null>,
    options: StreamingOptions = {},
    progressCallback?: ProgressCallback<T>
  ): Promise<ProcessingResult<T>> {
    const startTime = Date.now();
    const defaultOptions: StreamingOptions = {
      chunkSize: 1000,
      maxFileSize: 50 * 1024 * 1024, // 50MB
      encoding: 'utf8',
      parallelProcessing: false,
      maxConcurrency: 4
    };

    const finalOptions = { ...defaultOptions, ...options };

    return this.errorRecovery.executeWithRetry(async () => {
      // Check file size
      const fileSize = await this.getFileSize(filePath);
      if (fileSize > (finalOptions.maxFileSize ?? 0)) {
        throw new Error(`File too large: ${fileSize} bytes (max: ${finalOptions.maxFileSize})`);
      }

      // Check memory
      await this.memoryManager.forceCleanup();

      const results: T[] = [];
      const errors: ProcessingError[] = [];
      let processedLines = 0;
      let skippedLines = 0;

      const readStream = createReadStream(filePath, { encoding: finalOptions.encoding });
      const rl = createInterface({
        input: readStream,
        crlfDelay: Infinity
      });

      let currentChunk: T[] = [];
      let lineNumber = 0;

      try {
        for await (const line of rl) {
          lineNumber++;

          try {
            const result = await lineProcessor(line, lineNumber);
            if (result !== null) {
              currentChunk.push(result);
              results.push(result);
            } else {
              skippedLines++;
            }

            processedLines++;

            // Process chunk if size reached
            if (currentChunk.length >= (finalOptions.chunkSize ?? 0)) {
              if (progressCallback) {
                progressCallback({
                  processedLines,
                  percentage: fileSize ? (processedLines / (fileSize / 100)) * 100 : undefined,
                  currentChunk
                });
              }

              // Clear chunk to manage memory
              currentChunk = [];
              
              // Periodic memory check
              if (processedLines % 10000 === 0) {
                await this.memoryManager.forceCleanup();
              }
            }
          } catch (error) {
            errors.push({
              lineNumber,
              error: error instanceof Error ? error.message : String(error),
              content: line.substring(0, 100) // Limit content length
            });
          }
        }

        // Final progress callback
        if (progressCallback && currentChunk.length > 0) {
          progressCallback({
            processedLines,
            percentage: 100,
            currentChunk
          });
        }

      } finally {
        rl.close();
        readStream.destroy();
      }

      return {
        data: results,
        processedLines,
        skippedLines,
        errors,
        processingTime: Date.now() - startTime
      };
    }, `processFile:${filePath}`);
  }

  /**
   * Process multiple files in parallel with memory management
   */
  async processFilesParallel<T>(
    files: string[],
    fileProcessor: (filePath: string) => Promise<T>,
    maxConcurrency = 4
  ): Promise<Array<{ filePath: string; result: T | null; error?: string }>> {
    const semaphore = new Semaphore(maxConcurrency);
    const results: Array<{ filePath: string; result: T | null; error?: string }> = [];

    const processFileWithSemaphore = async (filePath: string) => {
      await semaphore.acquire();
      try {
        const result = await this.errorRecovery.executeWithRetry(
          () => fileProcessor(filePath),
          `processFile:${filePath}`
        );
        results.push({ filePath, result });
      } catch (error) {
        results.push({
          filePath,
          result: null,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        semaphore.release();
      }
    };

    await Promise.all(files.map(processFileWithSemaphore));
    return results;
  }

  /**
   * Transform stream for processing large data streams
   */
  createTransformStream<T, R>(
    transformer: (chunk: T) => Promise<R>,
    options: { parallel?: boolean; maxConcurrency?: number } = {}
  ): Transform {
    const { parallel = false, maxConcurrency = 4 } = options;

    return new Transform({
      objectMode: true,
      async transform(chunk: T, _encoding: BufferEncoding, callback) {
        try {
          if (parallel) {
            const semaphore = new Semaphore(maxConcurrency);
            await semaphore.acquire();
            try {
              const result = await transformer(chunk);
              callback(null, result);
            } finally {
              semaphore.release();
            }
          } else {
            const result = await transformer(chunk);
            callback(null, result);
          }
        } catch (error) {
          callback(error as Error);
        }
      }
    });
  }

  /**
   * Process data in batches with memory management
   */
  async processInBatches<T, R>(
    data: T[],
    batchProcessor: (batch: T[]) => Promise<R[]>,
    batchSize = 100,
    progressCallback?: (progress: { processed: number; total: number; percentage: number }) => void
  ): Promise<R[]> {
    const results: R[] = [];
    const total = data.length;

    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      
      try {
        const batchResults = await this.errorRecovery.executeWithRetry(
          () => batchProcessor(batch),
          `processBatch:${i}`
        );
        
        results.push(...batchResults);
        
        if (progressCallback) {
          progressCallback({
            processed: Math.min(i + batchSize, total),
            total,
            percentage: ((Math.min(i + batchSize, total) / total) * 100)
          });
        }

        // Memory management every few batches
        if (i % (batchSize * 10) === 0) {
          await this.memoryManager.forceCleanup();
        }
      } catch (error) {
        console.error(`Failed to process batch ${i}-${i + batchSize}:`, error);
        // Continue processing other batches
      }
    }

    return results;
  }

  /**
   * Get file size in bytes
   */
  private async getFileSize(filePath: string): Promise<number> {
    const fs = await import('fs/promises');
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  /**
   * Create a memory-efficient pipeline
   */
  async createPipeline(
    inputStream: NodeJS.ReadableStream,
    transforms: Transform[],
    outputStream: NodeJS.WritableStream
  ): Promise<void> {
    const streamArray: (NodeJS.ReadableStream | Transform | NodeJS.WritableStream)[] = [inputStream, ...transforms, outputStream];
    await pipeline(streamArray);
  }
}

// Semaphore for controlling concurrency
class Semaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    const resolve = this.queue.shift();
    if (resolve) {
      resolve();
    }
  }
}

// Caching utilities
export class ProcessingCache<T> {
  private cache = new Map<string, { data: T; timestamp: number; size: number }>();
  private readonly maxSize: number;
  private readonly ttl: number;

  constructor(maxSize = 100, ttl = 300000) { // 100 items, 5 minutes TTL
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  get(key: string): T | null {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return item.data;
  }

  set(key: string, data: T, size = 1): void {
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      size
    });
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, item] of this.cache.entries()) {
      if (item.timestamp < oldestTime) {
        oldestTime = item.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}