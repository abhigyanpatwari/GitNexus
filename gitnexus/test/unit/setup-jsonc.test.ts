import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';

const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    callback(null, '', '');
  }
});

const execFileSyncMock = vi.fn(() => {
  throw new Error('not found');
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

describe('setupOpenCode — JSONC preservation', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let platformDescriptor: PropertyDescriptor | undefined;

  const setPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', {
      value,
      configurable: true,
    });
  };

  const opencodeDir = () => path.join(tempHome, '.config', 'opencode');
  const opencodeJsonPath = () => path.join(opencodeDir(), 'opencode.json');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-opencode-jsonc-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    await fs.mkdir(opencodeDir(), { recursive: true });

    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    setPlatform('linux');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }

    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('preserves line comments (//)', async () => {
    const jsonc = `{
  // This comment must survive
  "model": "test"
}`;
    await fs.writeFile(opencodeJsonPath(), jsonc, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(opencodeJsonPath(), 'utf-8');
    expect(raw).toContain('This comment must survive');

    const config = parseJsonc(raw);
    expect(config.mcp.gitnexus).toBeDefined();
    expect(config.model).toBe('test');
  });

  it('preserves block comments (/* */)', async () => {
    const jsonc = `{
  /* block comment */
  "model": "test"
}`;
    await fs.writeFile(opencodeJsonPath(), jsonc, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(opencodeJsonPath(), 'utf-8');
    expect(raw).toContain('block comment');

    const config = parseJsonc(raw);
    expect(config.mcp.gitnexus).toBeDefined();
    expect(config.model).toBe('test');
  });

  it('preserves trailing comments', async () => {
    const jsonc = `{
  "model": "test", // inline comment
  "provider": "anthropic"
}`;
    await fs.writeFile(opencodeJsonPath(), jsonc, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(opencodeJsonPath(), 'utf-8');
    expect(raw).toContain('inline comment');

    const config = parseJsonc(raw);
    expect(config.model).toBe('test');
    expect(config.provider).toBe('anthropic');
    expect(config.mcp.gitnexus).toBeDefined();
  });

  it('handles plain JSON without comments (backwards compatible)', async () => {
    const plain = JSON.stringify({ model: 'test', provider: 'openai' }, null, 2);
    await fs.writeFile(opencodeJsonPath(), plain, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(opencodeJsonPath(), 'utf-8');
    const config = parseJsonc(raw);

    expect(config.model).toBe('test');
    expect(config.provider).toBe('openai');
    expect(config.mcp.gitnexus).toBeDefined();
  });

  it('handles missing opencode.json (creates fresh)', async () => {
    await fs.rm(opencodeJsonPath(), { force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(opencodeJsonPath(), 'utf-8');
    const config = parseJsonc(raw);

    expect(config.mcp.gitnexus).toBeDefined();
  });

  it('preserves all existing top-level keys', async () => {
    const jsonc = `{
  // my config
  "model": "claude-sonnet",
  "instructions": "Be helpful",
  "plugin": ["foo"],
  "provider": "anthropic",
  "mcp": { "other": { "command": "bar" } }
}`;
    await fs.writeFile(opencodeJsonPath(), jsonc, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(opencodeJsonPath(), 'utf-8');
    expect(raw).toContain('my config');

    const config = parseJsonc(raw);
    expect(config.model).toBe('claude-sonnet');
    expect(config.instructions).toBe('Be helpful');
    expect(config.plugin).toEqual(['foo']);
    expect(config.provider).toBe('anthropic');
    expect(config.mcp.other).toEqual({ command: 'bar' });
    expect(config.mcp.gitnexus).toBeDefined();
  });

  it('updates existing gitnexus MCP entry without losing other keys', async () => {
    execFileSyncMock.mockReturnValueOnce('/usr/local/bin/gitnexus\n');

    const jsonc = `{
  // config comment
  "model": "test",
  "mcp": {
    "other": { "command": "keep" },
    "gitnexus": { "command": "old-gitnexus", "args": ["old"] }
  }
}`;
    await fs.writeFile(opencodeJsonPath(), jsonc, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(opencodeJsonPath(), 'utf-8');
    expect(raw).toContain('config comment');

    const config = parseJsonc(raw);
    expect(config.model).toBe('test');
    expect(config.mcp.other).toEqual({ command: 'keep' });
    expect(config.mcp.gitnexus).toEqual({
      type: 'local',
      command: ['/usr/local/bin/gitnexus', 'mcp'],
    });
  });

  it('does not wipe corrupt file content', async () => {
    const corrupt = '{ "model": "test" this is broken {{{';
    await fs.writeFile(opencodeJsonPath(), corrupt, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(opencodeJsonPath(), 'utf-8');
    expect(raw).toBe(corrupt);
    expect(raw).not.toContain('gitnexus');
  });

  it('uses npx fallback format when gitnexus binary is not on PATH', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });

    const jsonc = `{
  "model": "test",
  "mcp": {}
}`;
    await fs.writeFile(opencodeJsonPath(), jsonc, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(opencodeJsonPath(), 'utf-8');
    const config = parseJsonc(raw);

    expect(config.mcp.gitnexus).toEqual({
      type: 'local',
      command: ['npx', '-y', 'gitnexus@latest', 'mcp'],
    });
  });

  it('preserves tab indentation in existing file', async () => {
    const tabbed = `{\n\t"model": "test"\n}`;
    await fs.writeFile(opencodeJsonPath(), tabbed, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(opencodeJsonPath(), 'utf-8');
    expect(raw).toContain('\t"model"');
    expect(raw).toContain('\t"gitnexus"');
  });

  it('preserves 4-space indentation in existing file', async () => {
    const fourSpace = `{
    "model": "test"
}`;
    await fs.writeFile(opencodeJsonPath(), fourSpace, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(opencodeJsonPath(), 'utf-8');
    const mcpLine = raw.split('\n').find((l) => l.includes('"gitnexus"'));
    expect(mcpLine).toMatch(/^    /);
  });

  it('skips when ~/.config/opencode directory does not exist', async () => {
    await fs.rm(opencodeDir(), { recursive: true, force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(fs.access(opencodeJsonPath())).rejects.toThrow();
  });
});
