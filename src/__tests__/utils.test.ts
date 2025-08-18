
import { describe, it, expect, beforeEach } from '@jest/globals';
import { ValidationService } from '../lib/validation';
import { ConfigService } from '../config/config';

describe('ValidationService', () => {
  it('should validate a valid node', () => {
    const validNode = {
      id: 'test-id',
      label: 'Function',
      properties: {
        name: 'testFunction',
        path: '/test/path.js',
        type: 'function',
        startLine: 10,
        endLine: 20
      }
    };
    const result = ValidationService.validateNode(validNode);
    expect(result.id).toBe('test-id');
  });

  it('should throw for an invalid node', () => {
    const invalidNode = { id: '', label: 'Invalid', properties: {} };
    expect(() => ValidationService.validateNode(invalidNode)).toThrow();
  });
});

describe('ConfigService', () => {
  let configService: ConfigService;

  beforeEach(() => {
    (ConfigService as any).instance = undefined;
    configService = ConfigService.getInstance();
  });

  it('should load default config', () => {
    const config = configService.getConfiguration();
    expect(config.memory.maxMemoryMB).toBe(512);
  });

  it('should update config', () => {
    configService.updateConfig({ memory: { maxMemoryMB: 1024 } } as any);
    const config = configService.getConfiguration();
    expect(config.memory.maxMemoryMB).toBe(1024);
  });
});
