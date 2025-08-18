/**
 * Web Worker Pool Manager for parallel processing in browsers
 * Manages a pool of Web Workers to process tasks concurrently
 */

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
  name?: string;
}

export interface WorkerPoolStats {
  totalWorkers: number;
  availableWorkers: number;
  activeTasks: number;
  queuedTasks: number;
  maxWorkers: number;
  memoryUsage?: number;
}

export class WebWorkerPool {
  private workers: Worker[] = [];
  private availableWorkers: Worker[] = [];
  private taskQueue: WorkerTask<unknown, unknown>[] = [];
  private activeTasks: Map<string, WorkerTask<unknown, unknown>> = new Map();
  private maxWorkers: number;
  private workerScript: string;
  private timeout: number;
  private isShuttingDown: boolean = false;
  private name: string;
  private eventListeners: Map<string, Set<(data: unknown) => void>> = new Map();

  constructor(options: WorkerPoolOptions = {}) {
    this.maxWorkers = options.maxWorkers || Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4));
    this.workerScript = options.workerScript || '/workers/generic-worker.js';
    this.timeout = options.timeout || 30000; // 30 seconds
    this.name = options.name || 'WebWorkerPool';
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
   * Execute tasks with progress callback
   */
  async executeWithProgress<TInput, TOutput>(
    inputs: TInput[],
    onProgress?: (completed: number, total: number) => void
  ): Promise<TOutput[]> {
    const results: TOutput[] = [];
    const total = inputs.length;
    let completed = 0;

    const batchSize = Math.min(this.maxWorkers, 10);
    
    for (let i = 0; i < inputs.length; i += batchSize) {
      const batch = inputs.slice(i, i + batchSize);
      const batchResults = await this.executeAll<TInput, TOutput>(batch);
      
      results.push(...batchResults);
      completed += batch.length;
      
      if (onProgress) {
        onProgress(completed, total);
      }
    }

    return results;
  }

  /**
   * Get pool statistics
   */
  getStats(): WorkerPoolStats {
    return {
      totalWorkers: this.workers.length,
      availableWorkers: this.availableWorkers.length,
      activeTasks: this.activeTasks.size,
      queuedTasks: this.taskQueue.length,
      maxWorkers: this.maxWorkers,
      memoryUsage: undefined
    };
  }

  /**
   * Shut down the worker pool
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    console.log(`${this.name}: Shutting down worker pool...`);
    
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
    const terminatePromises = this.workers.map(worker => {
      try {
        worker.terminate();
        return Promise.resolve();
      } catch (error) {
        console.warn(`${this.name}: Error terminating worker:`, error);
        return Promise.resolve();
      }
    });

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
    console.log(`${this.name}: Worker pool shutdown complete`);
  }

  /**
   * Add event listener
   */
  on(event: string, listener: (data: unknown) => void): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
  }

  /**
   * Remove event listener
   */
  off(event: string, listener: (data: unknown) => void): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * Emit event
   */
  private emit(event: string, data?: unknown): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (error) {
          console.error(`${this.name}: Error in event listener for ${event}:`, error);
        }
      }
    }
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
    try {
      const worker = new Worker(this.workerScript, { type: 'module' });
      
      worker.onerror = (error) => {
        this.handleWorkerError(worker, error);
      };

      worker.onmessageerror = (error) => {
        console.error(`${this.name}: Worker message error:`, error);
        this.handleWorkerError(worker, new Error('Worker message error'));
      };

      this.workers.push(worker);
      this.emit('workerCreated', { 
        workerId: this.workers.length - 1, 
        totalWorkers: this.workers.length 
      });
      
      return worker;
    } catch (error) {
      console.error(`${this.name}: Failed to create worker:`, error);
      throw new Error(`Failed to create worker: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private assignTaskToWorker(task: WorkerTask, worker: Worker): void {
    this.activeTasks.set(task.id, task);

    const timeoutId = setTimeout(() => {
      task.reject(new Error(`Task ${task.id} timed out after ${this.timeout}ms`));
      this.activeTasks.delete(task.id);
      this.recycleWorker(worker);
    }, this.timeout);

    const messageHandler = (event: MessageEvent) => {
      const { taskId, result, error } = event.data;
      
      if (taskId !== task.id) {
        return; // Not our task
      }

      clearTimeout(timeoutId);
      worker.removeEventListener('message', messageHandler);
      worker.removeEventListener('error', errorHandler);
      
      this.activeTasks.delete(task.id);
      
      if (error) {
        task.reject(new Error(error));
      } else {
        task.resolve(result);
      }
      
      this.recycleWorker(worker);
    };

    const errorHandler = (error: ErrorEvent) => {
      clearTimeout(timeoutId);
      worker.removeEventListener('message', messageHandler);
      worker.removeEventListener('error', errorHandler);
      
      this.activeTasks.delete(task.id);
      task.reject(new Error(`Worker error: ${error.message}`));
      this.handleWorkerError(worker, error);
    };

    worker.addEventListener('message', messageHandler);
    worker.addEventListener('error', errorHandler);
    
    // Send task to worker
    worker.postMessage({ 
      taskId: task.id, 
      input: task.input 
    });
  }

  private recycleWorker(worker: Worker): void {
    if (!this.isShuttingDown && this.workers.includes(worker)) {
      this.availableWorkers.push(worker);
      this.processQueue();
    }
  }

  private handleWorkerError(worker: Worker, error: Error | ErrorEvent): void {
    const errorMessage = error instanceof ErrorEvent ? error.message : error.message;
    this.emit('workerError', { 
      workerId: this.workers.indexOf(worker), 
      error: errorMessage 
    });
    
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

  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Specialized worker pool for file processing
 */
export class FileProcessingPool extends WebWorkerPool {
  private static instance: FileProcessingPool;

  static getInstance(): FileProcessingPool {
    if (!FileProcessingPool.instance) {
      FileProcessingPool.instance = new FileProcessingPool({
        maxWorkers: Math.max(2, Math.min(6, navigator.hardwareConcurrency || 4)),
        workerScript: '/workers/file-processing-worker.js',
        timeout: 45000, // 45 seconds for file processing
        name: 'FileProcessingPool'
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
    return this.executeWithProgress(
      filePaths.map(filePath => ({ filePath, processorFunction: processor.toString() })),
      onProgress
    );
  }
}

/**
 * Worker pool utilities
 */
export const WebWorkerPoolUtils = {
  /**
   * Create a specialized worker pool for CPU-intensive tasks
   */
  createCPUPool(options: Partial<WorkerPoolOptions> = {}): WebWorkerPool {
    return new WebWorkerPool({
      maxWorkers: navigator.hardwareConcurrency || 4,
      timeout: 60000, // 1 minute
      name: 'CPUPool',
      ...options
    });
  },

  /**
   * Create a worker pool for I/O operations
   */
  createIOPool(options: Partial<WorkerPoolOptions> = {}): WebWorkerPool {
    return new WebWorkerPool({
      maxWorkers: Math.min(20, (navigator.hardwareConcurrency || 4) * 4), // More workers for I/O
      timeout: 30000, // 30 seconds
      name: 'IOPool',
      ...options
    });
  },

  /**
   * Get optimal worker count for different task types
   */
  getOptimalWorkerCount(taskType: 'cpu' | 'io' | 'mixed' = 'mixed'): number {
    const cpuCount = navigator.hardwareConcurrency || 4;
    
    switch (taskType) {
      case 'cpu':
        return cpuCount;
      case 'io':
        return Math.min(20, cpuCount * 4);
      case 'mixed':
      default:
        return Math.max(2, Math.min(8, cpuCount));
    }
  },

  /**
   * Check if Web Workers are supported
   */
  isSupported(): boolean {
    return typeof Worker !== 'undefined';
  },

  /**
   * Get hardware concurrency
   */
  getHardwareConcurrency(): number {
    return navigator.hardwareConcurrency || 4;
  }
};
