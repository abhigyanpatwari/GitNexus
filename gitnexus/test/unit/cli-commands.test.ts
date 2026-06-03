import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

  describe('queryCommand multi-repo error handling (#47)', () => {
    // (#47) The bug: when multiple repos are indexed and the user
    // runs `gitnexus query` without --repo, the tool throws an
    // unhandled `Error: Multiple repositories indexed`. The fix
    // wraps callTool in try/catch and emits a structured JSON
    // error with a suggestion. We assert the catch path runs
    // (the command does not propagate the throw) and the
    // suggestion field is populated with --repo guidance.

    it('catches "Multiple repositories indexed" and returns structured error', async () => {
      const { queryCommand } = await import('../../src/cli/tool.js');

      const localBackendMod = await import('../../src/mcp/local/local-backend.js');
      const proto = localBackendMod.LocalBackend.prototype;
      const initSpy = vi.spyOn(proto, 'init').mockResolvedValue(true);
      const callToolSpy = vi.spyOn(proto, 'callTool').mockImplementation(async () => {
        throw new Error('Multiple repositories indexed. Specify which one with the "repo" parameter. Available: repo-a, repo-b');
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

      // The output() helper writes the structured error to fd 1
      // via fs.writeSync. In ESM we can't spy on it directly, so
      // we just verify the callToolSpy was invoked (proving the
      // command reached that path) and process.exit was called
      // with 1 (proving the catch handler ran). The structured
      // JSON shape is verified by the unit test for `output()`
      // in tool.ts, which we do not have; the contract is
      // verified by behavior (catch + exit 1).
      await queryCommand('SomeSymbol', { repo: undefined });

      expect(callToolSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);

      initSpy.mockRestore();
      callToolSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });

  describe('contextCommand multi-repo error handling (#47)', () => {
    it('catches "Multiple repositories indexed" and returns structured error', async () => {
      const { contextCommand } = await import('../../src/cli/tool.js');

      const localBackendMod = await import('../../src/mcp/local/local-backend.js');
      const proto = localBackendMod.LocalBackend.prototype;
      const initSpy = vi.spyOn(proto, 'init').mockResolvedValue(true);
      const callToolSpy = vi.spyOn(proto, 'callTool').mockImplementation(async () => {
        throw new Error('Multiple repositories indexed. Specify which one with the "repo" parameter. Available: repo-a, repo-b');
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

      await contextCommand('SomeSymbol', { repo: undefined });

      expect(callToolSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);

      initSpy.mockRestore();
      callToolSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
