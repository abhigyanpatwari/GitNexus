import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  commandBannerTitle,
  commandDisplayName,
  formatCommandBanner,
  writeCommandBanner,
} from '../../src/cli/command-banner.js';

function commandAt(path: string[]): Command {
  let current = new Command('gitnexus');
  for (const name of path) {
    current = current.command(name);
  }
  return current;
}

describe('commandDisplayName', () => {
  it('uses Analyzer for analyze and MCP for mcp', () => {
    expect(commandDisplayName('analyze')).toBe('Analyzer');
    expect(commandDisplayName('mcp')).toBe('MCP');
  });

  it('title-cases hyphenated command names', () => {
    expect(commandDisplayName('detect-changes')).toBe('Detect Changes');
    expect(commandDisplayName('eval-server')).toBe('Eval Server');
    expect(commandDisplayName('list')).toBe('List');
  });
});

describe('commandBannerTitle', () => {
  it('joins nested group commands', () => {
    expect(commandBannerTitle(commandAt(['group', 'list']))).toBe('Group List');
    expect(commandBannerTitle(commandAt(['embeddings', 'install']))).toBe('Embeddings Install');
  });
});

describe('formatCommandBanner', () => {
  it('puts the version in the title', () => {
    expect(formatCommandBanner('Analyzer', '1.6.10')).toBe('\n  GitNexus Analyzer (1.6.10)\n');
    expect(formatCommandBanner('Query', '1.6.10')).toBe('\n  GitNexus Query (1.6.10)\n');
  });

  it('keeps the unversioned title when version is missing', () => {
    expect(formatCommandBanner('Analyzer', '')).toBe('\n  GitNexus Analyzer\n');
  });
});

describe('writeCommandBanner', () => {
  it('writes the title for a normal command', () => {
    const write = vi.fn();
    writeCommandBanner(commandAt(['status']), { write, version: '1.6.10' });
    expect(write).toHaveBeenCalledWith('\n  GitNexus Status (1.6.10)\n');
  });

  it('skips hidden refresh and help', () => {
    const write = vi.fn();
    writeCommandBanner(commandAt(['__update-check']), { write, version: '1.6.10' });
    writeCommandBanner(commandAt(['help']), { write, version: '1.6.10' });
    expect(write).not.toHaveBeenCalled();
  });
});
