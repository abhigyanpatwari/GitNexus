import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lbugMocks, childProcessMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
  childProcessMocks: {
    execFileSync: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: childProcessMocks.execFileSync };
});

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { LocalBackend, getDetectChangesIgnoreReason } from '../../src/mcp/local/local-backend.js';

const MOCK_REPO = {
  id: 'repo-1',
  name: 'repo-1',
  repoPath: '/tmp/repo-1',
  storagePath: '/tmp/.gitnexus/repo-1',
  lbugPath: '/tmp/.gitnexus/repo-1/lbug',
  indexedAt: '2026-04-16T00:00:00Z',
  lastCommit: 'abc123',
};

describe('getDetectChangesIgnoreReason', () => {
  it('recognizes GitNexus-generated agent-context files', () => {
    expect(getDetectChangesIgnoreReason('AGENTS.md')).toBe('gitnexus_agent_context');
    expect(getDetectChangesIgnoreReason('CLAUDE.md')).toBe('gitnexus_agent_context');
    expect(getDetectChangesIgnoreReason('.claude/skills/generated/foo/SKILL.md')).toBe(
      'gitnexus_agent_context',
    );
    expect(getDetectChangesIgnoreReason('.claude/skills/gitnexus/gitnexus-cli/SKILL.md')).toBe(
      'gitnexus_agent_context',
    );
    expect(getDetectChangesIgnoreReason('src/main.ts')).toBeNull();
  });
});

describe('LocalBackend.detectChanges', () => {
  let backend: LocalBackend;

  beforeEach(() => {
    backend = new LocalBackend();
    (backend as any).repos.set(MOCK_REPO.id, MOCK_REPO);
    vi.clearAllMocks();
  });

  it('ignores GitNexus-generated agent-context files while analyzing real code changes', async () => {
    childProcessMocks.execFileSync.mockReturnValue(
      [
        'diff --git a/CLAUDE.md b/CLAUDE.md',
        '--- a/CLAUDE.md',
        '+++ b/CLAUDE.md',
        '@@ -1,0 +1,2 @@',
        '+# context',
        '+updated',
        'diff --git a/src/main.ts b/src/main.ts',
        '--- a/src/main.ts',
        '+++ b/src/main.ts',
        '@@ -10,0 +10,2 @@',
        '+export const main = 1;',
        '+console.log(main);',
      ].join('\n'),
    );

    (executeParameterized as any)
      .mockResolvedValueOnce([
        {
          id: 'func:main',
          name: 'main',
          type: 'Function',
          filePath: 'src/main.ts',
          startLine: 10,
          endLine: 11,
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await (backend as any).detectChanges(MOCK_REPO, { scope: 'unstaged' });

    expect(result.summary.changed_files).toBe(1);
    expect(result.summary.ignored_file_count).toBe(1);
    expect(result.changed_symbols).toHaveLength(1);
    expect(result.ignored_files).toEqual([
      { filePath: 'CLAUDE.md', reason: 'gitnexus_agent_context' },
    ]);
  });

  it('returns a no-code-changes summary when the diff only touches ignored agent-context files', async () => {
    childProcessMocks.execFileSync.mockReturnValue(
      [
        'diff --git a/AGENTS.md b/AGENTS.md',
        '--- a/AGENTS.md',
        '+++ b/AGENTS.md',
        '@@ -1,0 +1,1 @@',
        '+updated guidance',
      ].join('\n'),
    );

    const result = await (backend as any).detectChanges(MOCK_REPO, { scope: 'unstaged' });

    expect(result.summary.changed_files).toBe(0);
    expect(result.summary.ignored_file_count).toBe(1);
    expect(result.summary.risk_level).toBe('none');
    expect(result.summary.message).toContain('No code changes detected.');
    expect(result.summary.message).toContain('Ignored 1 GitNexus-generated agent-context file');
    expect(result.changed_symbols).toEqual([]);
    expect(result.affected_processes).toEqual([]);
    expect(result.ignored_files).toEqual([
      { filePath: 'AGENTS.md', reason: 'gitnexus_agent_context' },
    ]);
  });
});
