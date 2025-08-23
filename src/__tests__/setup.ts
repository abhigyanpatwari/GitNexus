/**
 * Test setup file for Jest
 */

import { jest } from '@jest/globals';

// Global test setup
beforeAll(() => {
  // Suppress console output during tests
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterAll(() => {
  // Restore console methods
  jest.restoreAllMocks();
});

// Reset singletons between tests
beforeEach(() => {
  // Reset singleton instances
  const singletons = [
    'ConfigService',
    'MemoryManager',
    'ErrorRecoveryService',
    'HealthMonitor',
    'StreamingProcessor'
  ];

  singletons.forEach(singleton => {
    const modulePath = `../${singleton.toLowerCase().replace(/([A-Z])/g, '-$1').substring(1)}`;
    try {
      const module = require(modulePath);
      if (module[singleton]) {
        module[singleton].instance = undefined;
      }
    } catch (e) {
      // Module might not exist, skip
    }
  });
});

// Mock window for Node.js environment
if (typeof window === 'undefined') {
  (global as any).window = {
    setInterval: setInterval,
    clearInterval: clearInterval
  };
}

// Mock Node.js built-ins
import { TextEncoder, TextDecoder } from 'util';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

// Mock crypto for Node.js environment
if (!global.crypto) {
  (global as any).crypto = {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).substring(2, 15)
  };
}

// Mock performance for Node.js environment
if (!global.performance) {
  (global as any).performance = {
    now: () => Date.now(),
    timeOrigin: Date.now()
  };
}

// Environment variable setup
process.env.NODE_ENV = 'test';
process.env.MEMORY_MAX_MB = '512';
process.env.PROCESSING_MAX_RETRIES = '3';
process.env.MONITORING_INTERVAL = '1000';

// Cleanup function
export const cleanup = () => {
  // Clean up any test artifacts
  jest.clearAllTimers();
  jest.clearAllMocks();
};

/**
 * Jest test setup for WASM verification
 * TEMPORARY FILE - DELETE after WASM verification
 */

// Mock fetch for WASM file loading
global.fetch = jest.fn();

// Mock URL.createObjectURL and revokeObjectURL for worker tests
global.URL.createObjectURL = jest.fn(() => 'mock-blob-url');
global.URL.revokeObjectURL = jest.fn();

// Mock Worker for worker tests
global.Worker = jest.fn().mockImplementation(() => ({
  postMessage: jest.fn(),
  terminate: jest.fn(),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  onmessage: null,
  onerror: null
}));

// Setup console for test output
const originalConsoleLog = console.log;
console.log = (...args) => {
  // Allow our test messages through
  if (args[0] && typeof args[0] === 'string' && (
    args[0].includes('✅') || 
    args[0].includes('❌') || 
    args[0].includes('🔍') ||
    args[0].includes('🧪')
  )) {
    originalConsoleLog(...args);
  }
};

// Mock WebAssembly for basic checks
if (typeof WebAssembly === 'undefined') {
  global.WebAssembly = {
    compile: jest.fn(),
    instantiate: jest.fn(),
    Module: jest.fn(),
    Instance: jest.fn()
  };
}

console.log('🔧 Jest setup completed for WASM verification tests');
