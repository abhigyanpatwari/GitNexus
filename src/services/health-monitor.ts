/**
 * Health monitoring and metrics collection service
 */

import { performance } from 'perf_hooks';
import { ConfigService } from '../config/config';
import { MemoryManager } from './memory-manager.js';
import { ErrorRecoveryService } from '../lib/error-handler.js';

export interface HealthMetrics {
  timestamp: Date;
  uptime: number;
  memory: {
    used: number;
    total: number;
    free: number;
    percentage: number;
  };
  processing: {
    totalFiles: number;
    successfulFiles: number;
    failedFiles: number;
    averageProcessingTime: number;
    errors: string[];
  };
  system: {
    loadAverage?: number[];
    cpuUsage?: number;
    activeConnections: number;
  };
}

export interface MetricPoint {
  timestamp: Date;
  value: number;
  label?: string;
  tags?: Record<string, string>;
}

export interface AlertThreshold {
  metric: string;
  threshold: number;
  comparison: 'gt' | 'lt' | 'gte' | 'lte';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
}

export class HealthMonitor {
  private static instance: HealthMonitor;
  private readonly config: ConfigService;
  private readonly memoryManager: MemoryManager;
  private readonly errorService: ErrorRecoveryService;
  private metrics: Map<string, MetricPoint[]> = new Map();
  private alerts: AlertThreshold[] = [];
  private startTime: Date;
  private processingStats = {
    totalFiles: 0,
    successfulFiles: 0,
    failedFiles: 0,
    processingTimes: [] as number[],
    errors: [] as string[]
  };
  private activeConnections = 0;
  private monitoringInterval?: NodeJS.Timeout;

  private constructor() {
    this.config = ConfigService.getInstance();
    this.memoryManager = MemoryManager.getInstance();
    this.errorService = ErrorRecoveryService.getInstance();
    this.startTime = new Date();
    this.setupDefaultAlerts();
  }

  static getInstance(): HealthMonitor {
    if (!HealthMonitor.instance) {
      HealthMonitor.instance = new HealthMonitor();
    }
    return HealthMonitor.instance;
  }

  /**
   * Start health monitoring
   */
  start(): void {
    const interval = this.config.get('monitoring.interval', 30000); // 30 seconds
    
    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
      this.checkAlerts();
    }, interval);

    console.info('Health monitoring started');
  }

  /**
   * Stop health monitoring
   */
  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    console.info('Health monitoring stopped');
  }

  /**
   * Record a metric value
   */
  recordMetric(name: string, value: number, label?: string, tags?: Record<string, string>): void {
    const metricPoint: MetricPoint = {
      timestamp: new Date(),
      value,
      label,
      tags
    };

    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }

    const metricArray = this.metrics.get(name)!;
    metricArray.push(metricPoint);

    // Keep only last 1000 points per metric
    if (metricArray.length > 1000) {
      metricArray.shift();
    }
  }

  /**
   * Record file processing statistics
   */
  recordFileProcessing(filePath: string, success: boolean, processingTime: number, error?: string): void {
    this.processingStats.totalFiles++;
    
    if (success) {
      this.processingStats.successfulFiles++;
    } else {
      this.processingStats.failedFiles++;
      if (error) {
        this.processingStats.errors.push(error);
      }
    }

    this.processingStats.processingTimes.push(processingTime);
    
    // Keep only last 1000 processing times
    if (this.processingStats.processingTimes.length > 1000) {
      this.processingStats.processingTimes.shift();
    }

    // Record metrics
    this.recordMetric('file_processing_time', processingTime, filePath);
    this.recordMetric('file_processing_success', success ? 1 : 0, filePath);
  }

  /**
   * Increment active connections counter
   */
  incrementConnections(): void {
    this.activeConnections++;
    this.recordMetric('active_connections', this.activeConnections);
  }

  /**
   * Decrement active connections counter
   */
  decrementConnections(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    this.recordMetric('active_connections', this.activeConnections);
  }

  /**
   * Get current health status
   */
  getHealthStatus(): HealthMetrics {
    const memoryUsage = process.memoryUsage();
    const uptime = Date.now() - this.startTime.getTime();

    return {
      timestamp: new Date(),
      uptime,
      memory: {
        used: memoryUsage.heapUsed,
        total: memoryUsage.heapTotal,
        free: memoryUsage.heapTotal - memoryUsage.heapUsed,
        percentage: (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100
      },
      processing: {
        totalFiles: this.processingStats.totalFiles,
        successfulFiles: this.processingStats.successfulFiles,
        failedFiles: this.processingStats.failedFiles,
        averageProcessingTime: this.calculateAverageProcessingTime(),
        errors: [...new Set(this.processingStats.errors)].slice(-10) // Last 10 unique errors
      },
      system: {
        loadAverage: this.getLoadAverage(),
        cpuUsage: this.getCpuUsage(),
        activeConnections: this.activeConnections
      }
    };
  }

  /**
   * Get metrics for a specific name
   */
  getMetrics(name: string, timeRange?: { start: Date; end: Date }): MetricPoint[] {
    const allMetrics = this.metrics.get(name) || [];
    
    if (!timeRange) {
      return allMetrics;
    }

    return allMetrics.filter(metric => 
      metric.timestamp >= timeRange.start && metric.timestamp <= timeRange.end
    );
  }

  /**
   * Get aggregated metrics
   */
  getAggregatedMetrics(name: string, aggregation: 'sum' | 'avg' | 'min' | 'max' | 'count', timeRange?: { start: Date; end: Date }): number {
    const metrics = this.getMetrics(name, timeRange);
    
    if (metrics.length === 0) return 0;

    const values = metrics.map(m => m.value);

    switch (aggregation) {
      case 'sum':
        return values.reduce((a, b) => a + b, 0);
      case 'avg':
        return values.reduce((a, b) => a + b, 0) / values.length;
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      case 'count':
        return values.length;
      default:
        return 0;
    }
  }

  /**
   * Add custom alert threshold
   */
  addAlert(alert: AlertThreshold): void {
    this.alerts.push(alert);
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): AlertThreshold[] {
    return this.alerts.filter(alert => this.isAlertTriggered(alert));
  }

  /**
   * Export health report
   */
  exportHealthReport(): string {
    const health = this.getHealthStatus();
    const alerts = this.getActiveAlerts();
    
    const report = {
      generatedAt: new Date().toISOString(),
      healthStatus: health,
      activeAlerts: alerts,
      metricsSummary: this.getMetricsSummary()
    };

    return JSON.stringify(report, null, 2);
  }

  /**
   * Collect system metrics
   */
  private collectMetrics(): void {
    const memoryUsage = process.memoryUsage();
    
    this.recordMetric('memory_heap_used', memoryUsage.heapUsed);
    this.recordMetric('memory_heap_total', memoryUsage.heapTotal);
    this.recordMetric('memory_rss', memoryUsage.rss);
    this.recordMetric('memory_external', memoryUsage.external);
    
    this.recordMetric('uptime', Date.now() - this.startTime.getTime());
    this.recordMetric('active_connections', this.activeConnections);
    
    // Memory manager metrics
    const cacheStats = this.memoryManager.getCacheStats();
    this.recordMetric('cache_size', cacheStats.size);
    this.recordMetric('cache_hits', cacheStats.hits);
    this.recordMetric('cache_misses', cacheStats.misses);
  }

  /**
   * Check alert thresholds
   */
  private checkAlerts(): void {
    for (const alert of this.alerts) {
      if (this.isAlertTriggered(alert)) {
        this.triggerAlert(alert);
      }
    }
  }

  /**
   * Check if an alert is triggered
   */
  private isAlertTriggered(alert: AlertThreshold): boolean {
    const currentValue = this.getCurrentMetricValue(alert.metric);
    if (currentValue === null) return false;

    switch (alert.comparison) {
      case 'gt':
        return currentValue > alert.threshold;
      case 'lt':
        return currentValue < alert.threshold;
      case 'gte':
        return currentValue >= alert.threshold;
      case 'lte':
        return currentValue <= alert.threshold;
      default:
        return false;
    }
  }

  /**
   * Get current value for a metric
   */
  private getCurrentMetricValue(metric: string): number | null {
    const health = this.getHealthStatus();
    
    switch (metric) {
      case 'memory_percentage':
        return health.memory.percentage;
      case 'processing_errors':
        return this.processingStats.errors.length;
      case 'active_connections':
        return health.system.activeConnections;
      case 'uptime':
        return health.uptime;
      default:
        return null;
    }
  }

  /**
   * Trigger an alert
   */
  private triggerAlert(alert: AlertThreshold): void {
    const message = {
      timestamp: new Date().toISOString(),
      severity: alert.severity,
      message: alert.message,
      metric: alert.metric,
      threshold: alert.threshold,
      currentValue: this.getCurrentMetricValue(alert.metric)
    };

    console.warn(`ALERT [${alert.severity}]: ${alert.message}`, message);
    
    // In production, this would send to external monitoring service
    this.recordMetric('alerts_triggered', 1, alert.message, { severity: alert.severity });
  }

  /**
   * Setup default alert thresholds
   */
  private setupDefaultAlerts(): void {
    this.addAlert({
      metric: 'memory_percentage',
      threshold: 85,
      comparison: 'gte',
      severity: 'high',
      message: 'Memory usage is critically high'
    });

    this.addAlert({
      metric: 'processing_errors',
      threshold: 10,
      comparison: 'gte',
      severity: 'medium',
      message: 'High number of processing errors detected'
    });

    this.addAlert({
      metric: 'active_connections',
      threshold: 100,
      comparison: 'gte',
      severity: 'medium',
      message: 'High number of active connections'
    });
  }

  /**
   * Calculate average processing time
   */
  private calculateAverageProcessingTime(): number {
    const times = this.processingStats.processingTimes;
    if (times.length === 0) return 0;
    return times.reduce((a, b) => a + b, 0) / times.length;
  }

  /**
   * Get system load average (Node.js specific)
   */
  private getLoadAverage(): number[] | undefined {
    if (process.platform !== 'win32') {
      return require('os').loadavg();
    }
    return undefined;
  }

  /**
   * Get CPU usage (simplified)
   */
  private getCpuUsage(): number | undefined {
    // This is a simplified version - in production, use proper CPU monitoring
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1000000; // Convert to milliseconds
  }

  /**
   * Get metrics summary
   */
  private getMetricsSummary(): Record<string, any> {
    const summary: Record<string, any> = {};
    
    for (const [name, metrics] of this.metrics.entries()) {
      if (metrics.length > 0) {
        const values = metrics.map(m => m.value);
        summary[name] = {
          count: values.length,
          avg: values.reduce((a, b) => a + b, 0) / values.length,
          min: Math.min(...values),
          max: Math.max(...values),
          last: values[values.length - 1]
        };
      }
    }
    
    return summary;
  }
}

// Health check endpoint for external monitoring
export class HealthCheckEndpoint {
  private healthMonitor: HealthMonitor;

  constructor() {
    this.healthMonitor = HealthMonitor.getInstance();
  }

  async handleHealthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    metrics: HealthMetrics;
    alerts: AlertThreshold[];
  }> {
    const metrics = this.healthMonitor.getHealthStatus();
    const alerts = this.healthMonitor.getActiveAlerts();
    
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    if (alerts.some(alert => alert.severity === 'critical')) {
      status = 'unhealthy';
    } else if (alerts.length > 0) {
      status = 'degraded';
    }

    return { status, metrics, alerts };
  }
}