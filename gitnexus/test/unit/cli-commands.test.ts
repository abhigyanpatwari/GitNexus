import { describe, it, expect, vi } from 'vitest';

// Mock all the heavy imports before importing index
vi.mock('../../src/cli/analyze.js', () => ({
  analyzeCommand: vi.fn(),
}));
vi.mock('../../src/cli/mcp.js', () => ({
  mcpCommand: vi.fn(),
}));
vi.mock('../../src/cli/setup.js', () => ({
  setupCommand: vi.fn(),
}));

describe('CLI commands', () => {
  describe('version', () => {
    it('package.json has a valid version string', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      expect(pkg.default.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('package.json scripts', () => {
    it('has test scripts configured', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      expect(pkg.default.scripts.test).toBeDefined();
      expect(pkg.default.scripts['test:integration']).toBeDefined();
      expect(pkg.default.scripts['test:unit']).toBeDefined();
    });

    it('has build script', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      expect(pkg.default.scripts.build).toBeDefined();
    });
  });

  describe('package.json bin entry', () => {
    it('exposes gitnexus binary', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      expect(pkg.default.bin).toBeDefined();
      expect(pkg.default.bin.gitnexus || pkg.default.bin).toBeDefined();
    });
  });

  describe('optional parser dependencies', () => {
    it('uses vendored source for tree-sitter-dart instead of a remote dependency', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      expect(pkg.default.optionalDependencies['tree-sitter-dart']).toBe(
        'file:./vendor/tree-sitter-dart',
      );
    });

    it('uses the vendored official Swift runtime package instead of source-building on install', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      const swiftPkg = await import('../../vendor/tree-sitter-swift/package.json', {
        with: { type: 'json' },
      });
      expect(pkg.default.dependencies['tree-sitter']).toBe('^0.21.1');
      expect(pkg.default.optionalDependencies['tree-sitter-swift']).toBe(
        'file:./vendor/tree-sitter-swift',
      );
      expect(pkg.default.scripts.postinstall).not.toContain('tree-sitter-swift');
      expect(swiftPkg.default.version).toBe('0.7.1');
      expect(swiftPkg.default.peerDependencies['tree-sitter']).toContain('^0.21.1');
    });
  });

  describe('analyzeCommand', () => {
    it('is a function', async () => {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');
      expect(typeof analyzeCommand).toBe('function');
    });
  });

  describe('mcpCommand', () => {
    it('is a function', async () => {
      const { mcpCommand } = await import('../../src/cli/mcp.js');
      expect(typeof mcpCommand).toBe('function');
    });
  });

  describe('setupCommand', () => {
    it('is a function', async () => {
      const { setupCommand } = await import('../../src/cli/setup.js');
      expect(typeof setupCommand).toBe('function');
    });
  });
});
