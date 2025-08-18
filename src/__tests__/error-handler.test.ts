import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { 
  GitNexusError, 
  NetworkError, 
  ErrorRecoveryService,
  createSafeAsync,
  createSafe
} from '../lib/error-handler';

describe('Error Classes', () => {
  it('should create a GitNexusError with correct properties', () => {
    const error = new GitNexusError('Test', 'TEST_CODE', false, { a: 1 });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Test');
    expect(error.code).toBe('TEST_CODE');
    expect(error.isRecoverable).toBe(false);
    expect(error.context).toEqual({ a: 1 });
  });
});

describe('ErrorRecoveryService', () => {
  let service: ErrorRecoveryService;

  beforeEach(() => {
    (ErrorRecoveryService as any).instance = undefined;
    service = ErrorRecoveryService.getInstance();
  });

  it('should get a singleton instance', () => {
    const instance2 = ErrorRecoveryService.getInstance();
    expect(service).toBe(instance2);
  });

  describe('executeWithRetry', () => {
    it('should return value on success', async () => {
      const op = jest.fn<() => Promise<string>>().mockResolvedValue('ok');
      const result = await service.executeWithRetry(op, 'test');
      expect(result).toBe('ok');
    });

    it('should retry on failure', async () => {
      const op = jest.fn<() => Promise<string>>()
        .mockRejectedValueOnce(new NetworkError('failed'))
        .mockResolvedValue('ok');
      await service.executeWithRetry(op, 'test', { initialDelay: 1 });
      expect(op).toHaveBeenCalledTimes(2);
    });
  });

  describe('executeWithFallback', () => {
    it('should return primary result', async () => {
      const primary = jest.fn<() => Promise<string>>().mockResolvedValue('primary');
      const fallback = jest.fn<() => Promise<string>>().mockResolvedValue('fallback');
      const result = await service.executeWithFallback(primary, fallback, 'test');
      expect(result).toBe('primary');
    });

    it('should use fallback on failure', async () => {
      const primary = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('failed'));
      const fallback = jest.fn<() => Promise<string>>().mockResolvedValue('fallback');
      const result = await service.executeWithFallback(primary, fallback, 'test');
      expect(result).toBe('fallback');
    });
  });
});

describe('createSafeAsync', () => {
  it('should wrap an async function', async () => {
    const fn = createSafeAsync(async (a: number) => a * 2);
    const result = await fn(2);
    expect(result).toBe(4);
  });
});

describe('createSafe', () => {
  it('should wrap a sync function', () => {
    const fn = createSafe((a: number) => a * 2);
    const result = fn(2);
    expect(result).toBe(4);
  });
});