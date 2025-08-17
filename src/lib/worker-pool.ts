/**
 * Worker Pool Manager for parallel processing
 * Manages a pool of workers to process tasks concurrently
 */

import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as os from 'os';

export interface WorkerTask<TInput = unknown, TOutput = unknown> {
  id: string;
  input: TInput;
  resolve: (result: TOutput) => void;
  reject: (error: Error) => void;
}

export interface WorkerPoolOptions {
  maxWorkers?: number;
  workerScript?: string;
  timeout?: number;
}

export class WorkerPool extends EventEmitter {
  private workers: Worker[] = [];
  private availableWorkers: Worker[] = [];
  private taskQueue: WorkerTask<unknown, unknown>[] = [];
  private activeTasks: Map<string, WorkerTask<unknown, unknown>> = new Map();
  protected maxWorkers: number;
  private workerScript: string;
  private timeout: number;
  private isShuttingDown: boolean = false;

  constructor(options: WorkerPoolOptions = {}) {
    super();
    this.maxWorkers = options.maxWorkers || Math.max(2, Math.min(8, os.cpus().length));
    this.workerScript = options.workerScript || path.join(__dirname, 'worker-scripts', 'generic-worker.js');
    this.timeout = options.timeout || 30000; // 30 seconds
  }

  /**
   * Execute a task using available worker
   */
  async execute<TInput, TOutput>(input: TInput): Promise<TOutput> {
    if (this.isShuttingDown) {
      throw new Error('Worker pool is shutting down');
    }

    return new Promise<TOutput>((resolve, reject) => {
      const task: WorkerTask<TInput, TOutput> = {
        id: this.generateTaskId(),
        input,
        resolve,
        reject
      };

      this.taskQueue.push(task as WorkerTask<unknown, unknown>);
      this.processQueue();
    });
  }

  /**
   * Execute multiple tasks in parallel
   */
  async executeAll<TInput, TOutput>(inputs: TInput[]): Promise<TOutput[]> {
    const promises = inputs.map(input => this.execute<TInput, TOutput>(input));
    return Promise.all(promises);
  }

  /**
   * Execute tasks with concurrency limit
   */
  async executeBatch<TInput, TOutput>(
    inputs: TInput[], 
    batchSize: number = this.maxWorkers
  ): Promise<TOutput[]> {
    const results: TOutput[] = [];    
    for (let i = 0; i < inputs.length; i += batchSize) {
      const batch = inputs.slice(i, i + batchSize);
      const batchResults = await this.executeAll<TInput, TOutput>(batch);
      results.push(...batchResults);
    }
    return results;
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      totalWorkers: this.workers.length,
      availableWorkers: this.availableWorkers.length,
      activeTasks: this.activeTasks.size,
      queuedTasks: this.taskQueue.length,
      maxWorkers: this.maxWorkers
    };
  }

  /**
   * Shut down the worker pool
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    // Reject all queued tasks
    for (const task of this.taskQueue) {
      task.reject(new Error('Worker pool is shutting down'));
    }
    this.taskQueue.length = 0;

    // Wait for active tasks to complete or timeout
    const activeTaskPromises = Array.from(this.activeTasks.values()).map(task => 
      new Promise<void>((resolve) => {
        const originalResolve = task.resolve;
        const originalReject = task.reject;
        
        task.resolve = (result) => {
          originalResolve(result);
          resolve();
        };

        task.reject = (error) => {
          originalReject(error);
          resolve();
        };
      })
    );

    // Terminate all workers
    const terminatePromises = this.workers.map(worker => worker.terminate());

    try {
      await Promise.race([
        Promise.all(activeTaskPromises),
        new Promise(resolve => setTimeout(resolve, 5000)) // 5 second timeout
      ]);
    } catch {
      // Ignore timeout errors during shutdown
    }

    await Promise.all(terminatePromises);
    
    this.workers.length = 0;
    this.availableWorkers.length = 0;
    this.activeTasks.clear();
    
    this.emit('shutdown');
  }

  private processQueue(): void {
    while (this.taskQueue.length > 0 && this.getAvailableWorker()) {
      const task = this.taskQueue.shift()!;
      const worker = this.getAvailableWorker()!;
      
      this.assignTaskToWorker(task, worker);
    }
  }

  private getAvailableWorker(): Worker | null {
    if (this.availableWorkers.length > 0) {
      return this.availableWorkers.pop()!;
    }

    if (this.workers.length < this.maxWorkers) {
      return this.createWorker();
    }

    return null;
  }

  private createWorker(): Worker {
    const worker = new Worker(this.workerScript);
    
    worker.on('error', (error) => {
      this.handleWorkerError(worker, error);
    });

    worker.on('exit', (code) => {
      this.handleWorkerExit(worker, code);
    });

    this.workers.push(worker);
    this.emit('workerCreated', { workerId: worker.threadId, totalWorkers: this.workers.length });
    
    return worker;
  }

  private assignTaskToWorker(task: WorkerTask, worker: Worker): void {
    this.activeTasks.set(task.id, task);

    const timeoutId = setTimeout(() => {
      task.reject(new Error(`Task ${task.id} timed out after ${this.timeout}ms`));
      this.activeTasks.delete(task.id);
      this.recycleWorker(worker);
    }, this.timeout);

    const messageHandler = (result: unknown) => {
      clearTimeout(timeoutId);
      worker.off('message', messageHandler);
      worker.off('error', errorHandler);
      
      this.activeTasks.delete(task.id);
      task.resolve(result);
      this.recycleWorker(worker);
    };

    const errorHandler = (error: Error) => {
      clearTimeout(timeoutId);
      worker.off('message', messageHandler);
      worker.off('error', errorHandler);
      
      this.activeTasks.delete(task.id);
      task.reject(error);
      this.handleWorkerError(worker, error);
    };

    worker.on('message', messageHandler);
    worker.on('error', errorHandler);
    worker.postMessage({ taskId: task.id, input: task.input });
  }

  private recycleWorker(worker: Worker): void {
    if (!this.isShuttingDown && this.workers.includes(worker)) {
      this.availableWorkers.push(worker);
      this.processQueue();
    }
  }

  private handleWorkerError(worker: Worker, error: Error): void {
    this.emit('workerError', { workerId: worker.threadId, error });
    
    // Remove worker from pools
    const workerIndex = this.workers.indexOf(worker);
    if (workerIndex !== -1) {
      this.workers.splice(workerIndex, 1);
    }

    const availableIndex = this.availableWorkers.indexOf(worker);
    if (availableIndex !== -1) {
      this.availableWorkers.splice(availableIndex, 1);
    }

    // Try to replace the worker if not shutting down
    if (!this.isShuttingDown && this.workers.length < this.maxWorkers) {
      this.processQueue();
    }
  }

  private handleWorkerExit(worker: Worker, code: number): void {
    this.emit('workerExit', { workerId: worker.threadId, exitCode: code });
    
    // Remove worker from pools
    const workerIndex = this.workers.indexOf(worker);
    if (workerIndex !== -1) {
      this.workers.splice(workerIndex, 1);
    }

    const availableIndex = this.availableWorkers.indexOf(worker);
    if (availableIndex !== -1) {
      this.availableWorkers.splice(availableIndex, 1);
    }
  }

  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Singleton worker pool for file processing
 */
export class FileProcessingPool extends WorkerPool {
  private static instance: FileProcessingPool;

  static getInstance(): FileProcessingPool {
    if (!FileProcessingPool.instance) {
      FileProcessingPool.instance = new FileProcessingPool({
        maxWorkers: Math.max(2, Math.min(6, os.cpus().length - 1)),
        workerScript: path.join(__dirname, 'worker-scripts', 'file-processing-worker.js'),
        timeout: 45000 // 45 seconds for file processing
      });
    }
    return FileProcessingPool.instance;
  }

  /**
   * Process files in parallel
   */
  async processFiles<TOutput>(
    filePaths: string[], 
    processor: (filePath: string) => Promise<TOutput>
  ): Promise<TOutput[]> {
    const processingTasks = filePaths.map(filePath => ({
      filePath,
      processorFunction: processor.toString()
    }));

    return this.executeAll(processingTasks);
  }

  /**
   * Process files with progress callback
   */
  async processFilesWithProgress<TOutput>(
    filePaths: string[], 
    processor: (filePath: string) => Promise<TOutput>,
    onProgress?: (completed: number, total: number) => void
  ): Promise<TOutput[]> {
    const results: TOutput[] = [];
    const total = filePaths.length;
    let completed = 0;

    const batchSize = Math.min(this.maxWorkers, 10);
    
    for (let i = 0; i < filePaths.length; i += batchSize) {
      const batch = filePaths.slice(i, i + batchSize);
      const batchResults = await this.processFiles(batch, processor);
      
      results.push(...batchResults);
      completed += batch.length;
      
      if (onProgress) {
        onProgress(completed, total);
      }
    }

    return results;
  }
}

/**
 * Worker pool utilities
 */
export const WorkerPoolUtils = {
  /**
   * Create a specialized worker pool for CPU-intensive tasks
   */
  createCPUPool(options: Partial<WorkerPoolOptions> = {}): WorkerPool {
    return new WorkerPool({
      maxWorkers: os.cpus().length,
      timeout: 60000, // 1 minute
      ...options
    });
  },

  /**
   * Create a worker pool for I/O operations
   */
  createIOPool(options: Partial<WorkerPoolOptions> = {}): WorkerPool {
    return new WorkerPool({
      maxWorkers: Math.min(20, os.cpus().length * 4), // More workers for I/O
      timeout: 30000, // 30 seconds
      ...options
    });
  },

  /**
   * Get optimal worker count for different task types
   */
  getOptimalWorkerCount(taskType: 'cpu' | 'io' | 'mixed' = 'mixed'): number {
    const cpuCount = os.cpus().length;
    
    switch (taskType) {
      case 'cpu':
        return cpuCount;
      case 'io':
        return Math.min(20, cpuCount * 4);
      case 'mixed':
      default:
        return Math.max(2, Math.min(8, cpuCount));
    }
  }
};