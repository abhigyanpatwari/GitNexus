
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { MemoryManager } from '../services/memory-manager';

describe('MemoryManager', () => {
  let memoryManager: MemoryManager;

  beforeEach(() => {
    (MemoryManager as any).instance = undefined;
    memoryManager = MemoryManager.getInstance();
  });

  afterEach(() => {
    memoryManager.destroy();
  });

  it('should return a singleton instance', () => {
    const instance1 = MemoryManager.getInstance();
    const instance2 = MemoryManager.getInstance();
    expect(instance1).toBe(instance2);
  });

  it('should cache a file', () => {
    const result = memoryManager.cacheFile('test.js', 'console.log("hello")');
    expect(result).toBe(true);
    expect(memoryManager.getStats().fileCount).toBe(1);
  });

  it('should not cache a file that is too large', () => {
    memoryManager.configure({ maxFileSizeMB: 1 });
    const largeContent = 'a'.repeat(2 * 1024 * 1024);
    const result = memoryManager.cacheFile('large.js', largeContent);
    expect(result).toBe(false);
    expect(memoryManager.getStats().fileCount).toBe(0);
  });

  it('should retrieve a cached file', () => {
    memoryManager.cacheFile('test.js', 'console.log("hello")');
    const content = memoryManager.getFile('test.js');
    expect(content).toBe('console.log("hello")');
  });

  it('should return null for a non-cached file', () => {
    const content = memoryManager.getFile('non-existent.js');
    expect(content).toBeNull();
  });

  it('should remove a file from the cache', () => {
    memoryManager.cacheFile('test.js', 'console.log("hello")');
    memoryManager.removeFile('test.js');
    const content = memoryManager.getFile('test.js');
    expect(content).toBeNull();
  });

  it('should clear the cache', () => {
    memoryManager.cacheFile('test1.js', 'content1');
    memoryManager.cacheFile('test2.js', 'content2');
    memoryManager.clearCache();
    expect(memoryManager.getStats().fileCount).toBe(0);
  });

  it('should perform cleanup when memory is high', () => {
    memoryManager.configure({ cleanupThresholdMB: 1, maxMemoryMB: 2 });
    memoryManager.cacheFile('test1.js', 'a'.repeat(1.5 * 1024 * 1024));
    memoryManager.forceCleanup();
    expect(memoryManager.getStats().fileCount).toBe(0);
  });
});
