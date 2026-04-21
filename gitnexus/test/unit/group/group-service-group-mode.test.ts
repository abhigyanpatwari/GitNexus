/**
 * Documents MCP → GroupService mapping: callers use `name` + concrete params;
 * the "@group" string is interpreted only in LocalBackend.callTool (Issue #794).
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  GroupService,
  type GroupToolPort,
  type GroupRepoHandle,
} from '../../../src/core/group/service.js';

function makeTmpGroup(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = path.join(os.tmpdir(), `gitnexus-gmode-${Date.now()}`);
  const groupDir = path.join(tmpDir, 'groups', 'test-group');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: test-group
repos:
  app/backend: test-backend
  app/frontend: test-frontend
`,
  );
  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

function makePort(overrides: Partial<GroupToolPort> = {}): GroupToolPort {
  return {
    resolveRepo: vi.fn(
      async (name?: string): Promise<GroupRepoHandle> => ({
        id: name || 'test',
        name: name || 'test',
        repoPath: '/tmp/repo',
        storagePath: '/tmp/repo/.gitnexus',
      }),
    ),
    impact: vi.fn(async () => ({ target: {}, byDepth: {} })),
    query: vi.fn(async () => ({
      processes: [{ id: 'p1', heuristicLabel: 'Proc' }],
      process_symbols: [
        { id: 's1', process_id: 'p1', filePath: 'services/auth/a.ts' },
        { id: 's2', process_id: 'p1', filePath: 'other/b.ts' },
      ],
    })),
    impactByUid: vi.fn(async () => null),
    context: vi.fn(async () => ({
      status: 'found',
      symbol: { filePath: 'services/auth/x.ts', uid: 'u1', name: 'X' },
    })),
    ...overrides,
  };
}

describe('GroupService group-mode API surface', () => {
  it('groupQuery uses name (never @-repo) and optional service filters processes', async () => {
    const { tmpDir, cleanup } = makeTmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const query = vi.fn(async () => ({
        processes: [{ id: 'p1' }],
        process_symbols: [
          { id: 's1', process_id: 'p1', filePath: 'services/auth/a.ts' },
          { id: 's2', process_id: 'p1', filePath: 'other/b.ts' },
        ],
      }));
      const svc = new GroupService(makePort({ query }));
      const r = (await svc.groupQuery({
        name: 'test-group',
        query: 'oauth',
        service: 'services/auth',
      })) as { results: Array<{ id?: string }> };
      expect(query).toHaveBeenCalled();
      expect(r.results.every((row) => row.id === 'p1')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('groupQuery rejects empty service string', async () => {
    const { tmpDir, cleanup } = makeTmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const svc = new GroupService(makePort());
      const r = await svc.groupQuery({ name: 'test-group', query: 'x', service: '  ' });
      expect(r).toEqual({ error: 'service must not be an empty string' });
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('groupContext uses name + target (MCP maps @group to name)', async () => {
    const { tmpDir, cleanup } = makeTmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const svc = new GroupService(makePort());
      const r = await svc.groupContext({ name: 'test-group', target: 'MySym' });
      expect(r.group).toBe('test-group');
      expect(r.results).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('groupImpact with mock port returns structured result without @ in params', async () => {
    const { tmpDir, cleanup } = makeTmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const svc = new GroupService(makePort());
      const r = (await svc.groupImpact({
        name: 'test-group',
        repo: 'app/backend',
        target: 't',
        direction: 'upstream',
      })) as { group?: string; error?: string };
      expect(r.error).toBeUndefined();
      expect(r.group).toBe('test-group');
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });
});
