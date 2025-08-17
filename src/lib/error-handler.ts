/**
 * Comprehensive error handling and recovery mechanisms
 */

import { ConfigService } from '../config/config';
import { MemoryManager } from '../services/memory-manager';

// Base error class for all application errors
export class GitNexusError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly context?: Record<string, unknown>;
  public readonly isRecoverable: boolean;

  constructor(
    message: string,
    code: string,
    isRecoverable = true,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GitNexusError';
    this.code = code;
    this.timestamp = new Date();
    this.context = context;
    this.isRecoverable = isRecoverable;
    
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GitNexusError);
    }
  }
}

// Specific error types
export class ValidationError extends GitNexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', true, context);
    this.name = 'ValidationError';
  }
}

export class NetworkError extends GitNexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'NETWORK_ERROR', true, context);
    this.name = 'NetworkError';
  }
}

export class MemoryError extends GitNexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'MEMORY_ERROR', true, context);
    this.name = 'MemoryError';
  }
}

export class ParsingError extends GitNexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PARSING_ERROR', true, context);
    this.name = 'ParsingError';
  }
}

export class ConfigurationError extends GitNexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', false, context);
    this.name = 'ConfigurationError';
  }
}

// Retry configuration
interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

// Circuit breaker states
enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

class CircuitBreaker {
  private state = CircuitBreakerState.CLOSED;
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private readonly failureThreshold: number;
  private readonly resetTimeout: number;

  constructor(failureThreshold = 5, resetTimeout = 60000) {
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
  }

  canExecute(): boolean {
    if (this.state === CircuitBreakerState.OPEN) {
      if (this.lastFailureTime && Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = CircuitBreakerState.HALF_OPEN;
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitBreakerState.CLOSED;
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitBreakerState.OPEN;
    }
  }

  getState(): string {
    return this.state;
  }
}

// Error recovery service
export class ErrorRecoveryService {
  private static instance: ErrorRecoveryService;
  private readonly config: ConfigService;
  private readonly memoryManager: MemoryManager;
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();
  private readonly retryConfig: RetryConfig;

  private constructor() {
    this.config = ConfigService.getInstance();
    this.memoryManager = MemoryManager.getInstance();
    this.retryConfig = this.getRetryConfig();
  }

  static getInstance(): ErrorRecoveryService {
    if (!ErrorRecoveryService.instance) {
      ErrorRecoveryService.instance = new ErrorRecoveryService();
    }
    return ErrorRecoveryService.instance;
  }

  private getRetryConfig(): RetryConfig {
    const processingConfig = this.config.processing;
    return {
      maxAttempts: processingConfig.retry.maxRetries,
      initialDelay: 1000,
      maxDelay: 10000,
      backoffMultiplier: 2,
      retryableErrors: ['NETWORK_ERROR', 'MEMORY_ERROR', 'VALIDATION_ERROR']
    };
  }

  /**
   * Execute an operation with retry logic and circuit breaker
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    customRetryConfig?: Partial<RetryConfig>
  ): Promise<T> {
    const circuitBreaker = this.getCircuitBreaker(operationName);
    
    if (!circuitBreaker.canExecute()) {
      throw new GitNexusError(
        `Circuit breaker is open for ${operationName}`,
        'CIRCUIT_BREAKER_OPEN',
        false,
        { operationName, state: circuitBreaker.getState() }
      );
    }

    const retryConfig = { ...this.retryConfig, ...customRetryConfig };
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
      try {
        // Check memory before operation
        await this.memoryManager.forceCleanup();
        
        const result = await operation();
        circuitBreaker.recordSuccess();
        return result;
      } catch (error) {
        lastError = error as Error;
        
        if (!this.shouldRetry(error, retryConfig)) {
          circuitBreaker.recordFailure();
          throw error;
        }

        if (attempt < retryConfig.maxAttempts) {
          const delay = this.calculateDelay(attempt, retryConfig);
          await this.wait(delay);
          
          console.warn(`Retrying ${operationName} (attempt ${attempt}/${retryConfig.maxAttempts})`);
        }
      }
    }

    circuitBreaker.recordFailure();
    throw lastError;
  }

  /**
   * Execute an operation with graceful degradation
   */
  async executeWithFallback<T>(
    primaryOperation: () => Promise<T>,
    fallbackOperation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    try {
      return await this.executeWithRetry(primaryOperation, operationName);
    } catch (error) {
      console.warn(`Primary operation failed for ${operationName}, using fallback`, error);
      
      try {
        return await fallbackOperation();
      } catch (fallbackError) {
        throw new GitNexusError(
          `Both primary and fallback operations failed for ${operationName}`,
          'FALLBACK_FAILED',
          false,
          { 
            operationName, 
            primaryError: error instanceof Error ? error.message : String(error),
            fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          }
        );
      }
    }
  }

  /**
   * Handle memory-related errors with recovery
   */
  async handleMemoryError(error: Error, context?: Record<string, unknown>): Promise<void> {
    console.error('Memory error detected, attempting recovery', error, context);
    
    try {
      // Force cleanup
      await this.memoryManager.clearCache();
      
      // Trigger garbage collection if available
      if (global.gc) {
        global.gc();
      }
      
      console.info('Memory recovery completed');
    } catch (recoveryError) {
      throw new MemoryError(
        'Failed to recover from memory error',
        { 
          originalError: error.message,
          recoveryError: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          ...context 
        }
      );
    }
  }

  /**
   * Log error with context for debugging
   */
  logError(error: GitNexusError, context?: Record<string, unknown>): void {
    const errorLog = {
      timestamp: error.timestamp.toISOString(),
      code: error.code,
      message: error.message,
      stack: error.stack,
      context: { ...error.context, ...context },
      isRecoverable: error.isRecoverable
    };

    // In production, this would send to external logging service
    console.error('Application error:', JSON.stringify(errorLog, null, 2));
  }

  private getCircuitBreaker(operationName: string): CircuitBreaker {
    if (!this.circuitBreakers.has(operationName)) {
      this.circuitBreakers.set(operationName, new CircuitBreaker());
    }
    return this.circuitBreakers.get(operationName)!;
  }

  private shouldRetry(error: unknown, retryConfig: RetryConfig): boolean {
    if (error instanceof GitNexusError) {
      return retryConfig.retryableErrors.includes(error.code) && error.isRecoverable;
    }
    return true; // Retry unknown errors by default
  }

  private calculateDelay(attempt: number, retryConfig: RetryConfig): number {
    const delay = retryConfig.initialDelay * Math.pow(retryConfig.backoffMultiplier, attempt - 1);
    return Math.min(delay, retryConfig.maxDelay);
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Global error handler
export function setupGlobalErrorHandlers(): void {
  process.on('uncaughtException', (error: Error) => {
    const recoveryService = ErrorRecoveryService.getInstance();
    const gitNexusError = error instanceof GitNexusError 
      ? error 
      : new GitNexusError(
          'Uncaught exception',
          'UNCAUGHT_EXCEPTION',
          false,
          { originalError: error.message, stack: error.stack }
        );
    
    recoveryService.logError(gitNexusError);
    
    // Attempt graceful shutdown
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const recoveryService = ErrorRecoveryService.getInstance();
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const gitNexusError = new GitNexusError(
      'Unhandled promise rejection',
      'UNHANDLED_REJECTION',
      false,
      { reason: error.message, stack: error.stack }
    );
    
    recoveryService.logError(gitNexusError);
  });
}

// Utility functions for common error scenarios
export function createSafeAsync<T extends (...args: any[]) => Promise<unknown>>(
  fn: T,
  errorHandler?: (error: Error, ...args: Parameters<T>) => Promise<unknown>
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (errorHandler) {
        return await errorHandler(error as Error, ...args);
      }
      throw error;
    }
  }) as T;
}

export function createSafe<T extends (...args: any[]) => unknown>(
  fn: T,
  errorHandler?: (error: Error, ...args: Parameters<T>) => unknown
): T {
  return ((...args: Parameters<T>) => {
    try {
      return fn(...args);
    } catch (error) {
      if (errorHandler) {
        return errorHandler(error as Error, ...args);
      }
      throw error;
    }
  }) as T;
}
