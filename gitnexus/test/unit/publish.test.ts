import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildUqDispatchPayload,
  isValidOwnerRepo,
  parseOwnerRepoFromRemote,
  UNDERSTAND_QUICKLY_TOKEN_ENV,
} from 'gitnexus-shared';

describe('understand-quickly helpers (gitnexus-shared)', () => {
  describe('isValidOwnerRepo', () => {
    it.each([
      ['looptech-ai/understand-quickly', true],
      ['abhigyanpatwari/GitNexus', true],
      ['Some_Org/Some.Repo-2', true],
      ['', false],
      ['just-a-name', false],
      ['/Users/me/code/repo', false],
      ['org/with spaces', false],
      ['org//double', false],
    ])('returns %s for %j', (id, expected) => {
      expect(isValidOwnerRepo(id as string)).toBe(expected);
    });
  });

  describe('parseOwnerRepoFromRemote', () => {
    it.each([
      ['git@github.com:looptech-ai/understand-quickly.git', 'looptech-ai/understand-quickly'],
      ['https://github.com/looptech-ai/understand-quickly', 'looptech-ai/understand-quickly'],
      ['https://github.com/looptech-ai/understand-quickly.git', 'looptech-ai/understand-quickly'],
      ['ssh://git@github.com/abhigyanpatwari/GitNexus.git', 'abhigyanpatwari/GitNexus'],
      ['https://gitlab.example.com/group/sub/project.git', 'sub/project'],
    ])('parses %s -> %s', (url, expected) => {
      expect(parseOwnerRepoFromRemote(url)).toBe(expected);
    });

    it.each([null, undefined, '', '   ', 'not-a-url', 'https://github.com/'])(
      'returns null for %j',
      (input) => {
        expect(parseOwnerRepoFromRemote(input as string | null | undefined)).toBeNull();
      },
    );
  });

  describe('buildUqDispatchPayload', () => {
    it('wraps the id in the registry-expected event shape', () => {
      expect(buildUqDispatchPayload('looptech-ai/understand-quickly')).toEqual({
        event_type: 'sync-entry',
        client_payload: { id: 'looptech-ai/understand-quickly' },
      });
    });

    it('throws on a malformed id rather than building an invalid payload', () => {
      expect(() => buildUqDispatchPayload('just-a-name')).toThrow(/owner\/repo/);
      expect(() => buildUqDispatchPayload('/Users/me/repo')).toThrow(/owner\/repo/);
    });
  });
});

describe('publishCommand (no-token no-op)', () => {
  let tempDir: string;
  let originalToken: string | undefined;
  let exitCodeBefore: number | undefined;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-publish-test-'));
    // Simulate an existing index so hasIndex() returns true.
    await fs.mkdir(path.join(tempDir, '.gitnexus'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, '.gitnexus', 'meta.json'),
      JSON.stringify({ repoPath: tempDir, lastCommit: '', indexedAt: '' }),
      'utf-8',
    );
    originalToken = process.env[UNDERSTAND_QUICKLY_TOKEN_ENV];
    delete process.env[UNDERSTAND_QUICKLY_TOKEN_ENV];
    exitCodeBefore = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(async () => {
    if (originalToken !== undefined) {
      process.env[UNDERSTAND_QUICKLY_TOKEN_ENV] = originalToken;
    } else {
      delete process.env[UNDERSTAND_QUICKLY_TOKEN_ENV];
    }
    process.exitCode = exitCodeBefore;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('exits 0 without firing a network call when the token is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('publishCommand should NOT call fetch when the token is missing');
    });

    const { publishCommand } = await import('../../src/cli/publish.js');
    await publishCommand(tempDir, { id: 'looptech-ai/understand-quickly', skipGit: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
    fetchSpy.mockRestore();
  });
});
