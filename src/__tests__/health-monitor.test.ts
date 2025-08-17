
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { HealthMonitor } from '../services/health-monitor';

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    (HealthMonitor as any).instance = undefined;
    monitor = HealthMonitor.getInstance();
  });

  afterEach(() => {
    monitor.stop();
  });

  it('should return a singleton instance', () => {
    const instance1 = HealthMonitor.getInstance();
    const instance2 = HealthMonitor.getInstance();
    expect(instance1).toBe(instance2);
  });

  it('should record a metric', () => {
    monitor.recordMetric('test_metric', 10);
    const metrics = monitor.getMetrics('test_metric');
    expect(metrics).toHaveLength(1);
    expect(metrics[0].value).toBe(10);
  });

  it('should record file processing', () => {
    monitor.recordFileProcessing('test.js', true, 100);
    const status = monitor.getHealthStatus();
    expect(status.processing.totalFiles).toBe(1);
    expect(status.processing.successfulFiles).toBe(1);
  });

  it('should increment and decrement connections', () => {
    monitor.incrementConnections();
    let status = monitor.getHealthStatus();
    expect(status.system.activeConnections).toBe(1);

    monitor.decrementConnections();
    status = monitor.getHealthStatus();
    expect(status.system.activeConnections).toBe(0);
  });

  it('should get health status', () => {
    const status = monitor.getHealthStatus();
    expect(status).toBeDefined();
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });
});
