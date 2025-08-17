import { isPerformanceMonitoringEnabled } from '../config/feature-flags.js';

export interface PerformanceMetric {
  operation: string;
  duration: number;
  timestamp: number;
  success: boolean;
  error?: string;
  metadata?: Record<string, any>;
}

export interface PerformanceReport {
  totalOperations: number;
  successfulOperations: number;
  failedOperations: number;
  averageDuration: number;
  minDuration: number;
  maxDuration: number;
  totalDuration: number;
  operationsByType: Record<string, {
    count: number;
    averageDuration: number;
    totalDuration: number;
  }>;
  recentOperations: PerformanceMetric[];
  timestamp: number;
}

export class KuzuPerformanceMonitor {
  private metrics: PerformanceMetric[] = [];
  private maxMetrics: number = 1000;
  private enabled: boolean = false;

  constructor() {
    this.enabled = isPerformanceMonitoringEnabled();
  }

  /**
   * Start monitoring a performance metric
   */
  startOperation(operation: string, metadata?: Record<string, any>): string {
    if (!this.enabled) return '';

    const id = `${operation}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = performance.now();

    // Store start time in a weak map or similar for cleanup
    (this as any)[`_start_${id}`] = { startTime, operation, metadata };

    return id;
  }

  /**
   * End monitoring a performance metric
   */
  endOperation(id: string, success: boolean = true, error?: string): void {
    if (!this.enabled || !id) return;

    const startData = (this as any)[`_start_${id}`];
    if (!startData) return;

    const endTime = performance.now();
    const duration = endTime - startData.startTime;

    const metric: PerformanceMetric = {
      operation: startData.operation,
      duration,
      timestamp: Date.now(),
      success,
      error,
      metadata: startData.metadata
    };

    this.addMetric(metric);

    // Clean up start data
    delete (this as any)[`_start_${id}`];
  }

  /**
   * Add a performance metric directly
   */
  addMetric(metric: PerformanceMetric): void {
    if (!this.enabled) return;

    this.metrics.push(metric);

    // Keep only the most recent metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }
  }

  /**
   * Get performance report for the last N operations
   */
  getReport(operationCount: number = 100): PerformanceReport {
    const recentMetrics = this.metrics.slice(-operationCount);
    
    if (recentMetrics.length === 0) {
      return {
        totalOperations: 0,
        successfulOperations: 0,
        failedOperations: 0,
        averageDuration: 0,
        minDuration: 0,
        maxDuration: 0,
        totalDuration: 0,
        operationsByType: {},
        recentOperations: [],
        timestamp: Date.now()
      };
    }

    const successfulOperations = recentMetrics.filter(m => m.success);
    const failedOperations = recentMetrics.filter(m => !m.success);
    
    const durations = recentMetrics.map(m => m.duration);
    const totalDuration = durations.reduce((sum, d) => sum + d, 0);
    const averageDuration = totalDuration / recentMetrics.length;
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);

    // Group by operation type
    const operationsByType: Record<string, { count: number; averageDuration: number; totalDuration: number }> = {};
    
    recentMetrics.forEach(metric => {
      if (!operationsByType[metric.operation]) {
        operationsByType[metric.operation] = { count: 0, averageDuration: 0, totalDuration: 0 };
      }
      
      operationsByType[metric.operation].count++;
      operationsByType[metric.operation].totalDuration += metric.duration;
    });

    // Calculate averages for each operation type
    Object.keys(operationsByType).forEach(operation => {
      const data = operationsByType[operation];
      data.averageDuration = data.totalDuration / data.count;
    });

    return {
      totalOperations: recentMetrics.length,
      successfulOperations: successfulOperations.length,
      failedOperations: failedOperations.length,
      averageDuration,
      minDuration,
      maxDuration,
      totalDuration,
      operationsByType,
      recentOperations: recentMetrics.slice(-20), // Last 20 operations
      timestamp: Date.now()
    };
  }

  /**
   * Get performance report for a specific operation type
   */
  getOperationReport(operation: string, operationCount: number = 100): PerformanceReport | null {
    const operationMetrics = this.metrics
      .filter(m => m.operation === operation)
      .slice(-operationCount);

    if (operationMetrics.length === 0) return null;

    const successfulOperations = operationMetrics.filter(m => m.success);
    const failedOperations = operationMetrics.filter(m => !m.success);
    
    const durations = operationMetrics.map(m => m.duration);
    const totalDuration = durations.reduce((sum, d) => sum + d, 0);
    const averageDuration = totalDuration / operationMetrics.length;
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);

    return {
      totalOperations: operationMetrics.length,
      successfulOperations: successfulOperations.length,
      failedOperations: failedOperations.length,
      averageDuration,
      minDuration,
      maxDuration,
      totalDuration,
      operationsByType: {
        [operation]: {
          count: operationMetrics.length,
          averageDuration,
          totalDuration
        }
      },
      recentOperations: operationMetrics.slice(-10),
      timestamp: Date.now()
    };
  }

  /**
   * Clear all metrics
   */
  clearMetrics(): void {
    this.metrics = [];
  }

  /**
   * Enable or disable monitoring
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if monitoring is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get metrics count
   */
  getMetricsCount(): number {
    return this.metrics.length;
  }

  /**
   * Export metrics for analysis
   */
  exportMetrics(): PerformanceMetric[] {
    return [...this.metrics];
  }

  /**
   * Import metrics from external source
   */
  importMetrics(metrics: PerformanceMetric[]): void {
    this.metrics = [...this.metrics, ...metrics].slice(-this.maxMetrics);
  }

  /**
   * Get performance summary for console logging
   */
  getSummary(): string {
    const report = this.getReport();
    
    if (report.totalOperations === 0) {
      return 'No performance data available';
    }

    const successRate = ((report.successfulOperations / report.totalOperations) * 100).toFixed(1);
    
    return `
📊 KuzuDB Performance Summary:
   Total Operations: ${report.totalOperations}
   Success Rate: ${successRate}%
   Average Duration: ${report.averageDuration.toFixed(2)}ms
   Min Duration: ${report.minDuration.toFixed(2)}ms
   Max Duration: ${report.maxDuration.toFixed(2)}ms
   Total Duration: ${report.totalDuration.toFixed(2)}ms

Operations by Type:
${Object.entries(report.operationsByType)
  .map(([operation, data]) => 
    `   ${operation}: ${data.count} ops, ${data.averageDuration.toFixed(2)}ms avg`
  ).join('\n')}
    `.trim();
  }
}

// Export singleton instance
export const kuzuPerformanceMonitor = new KuzuPerformanceMonitor();

// Export convenience functions
export const startKuzuOperation = (operation: string, metadata?: Record<string, any>) => 
  kuzuPerformanceMonitor.startOperation(operation, metadata);

export const endKuzuOperation = (id: string, success?: boolean, error?: string) => 
  kuzuPerformanceMonitor.endOperation(id, success, error);

export const getKuzuPerformanceReport = (operationCount?: number) => 
  kuzuPerformanceMonitor.getReport(operationCount);

export const logKuzuPerformanceSummary = () => 
  console.log(kuzuPerformanceMonitor.getSummary());
