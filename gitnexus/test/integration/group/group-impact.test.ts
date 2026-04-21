/**
 * Group impact: exercise GroupService.groupImpact with fixture-backed group config
 * and a stubbed port (no LadybugDB / bridge required when local impact yields no UIDs).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { GroupService, type GroupToolPort } from '../../../src/core/group/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '../../fixtures/group');

let tmpHome: string;

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-grp-impact-int-'));
  const groupDir = path.join(tmpHome, 'groups', 'test-group');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.copyFileSync(path.join(fixturesDir, 'group.yaml'), path.join(groupDir, 'group.yaml'));
});

afterAll(() => {
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
});

function stubPort(): GroupToolPort {
  return {
    resolveRepo: vi.fn(async () => ({
      id: 'stub',
      name: 'stub',
      repoPath: '/tmp/repo',
      storagePath: '/tmp/.gitnexus',
    })),
    impact: vi.fn(async () => ({
      target: {},
      byDepth: {},
      summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
      risk: 'LOW',
    })),
    query: vi.fn(),
    impactByUid: vi.fn(),
    context: vi.fn(),
  };
}

describe('group impact integration', () => {
  it('returns validation error when parameters are incomplete', async () => {
    const svc = new GroupService(stubPort());
    const r = (await svc.groupImpact({ name: 'x', direction: 'upstream' })) as { error: string };
    expect(r.error).toMatch(/repo is required|target is required/);
  });

  it('runs happy-path stub against fixture group (stops before bridge when no symbol UIDs)', async () => {
    const prev = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome;
    try {
      const svc = new GroupService(stubPort());
      const r = (await svc.groupImpact({
        name: 'test-group',
        repo: 'app/backend',
        target: 'health',
        direction: 'upstream',
      })) as { group?: string; error?: string; cross?: unknown[] };
      expect(r.error).toBeUndefined();
      expect(r.group).toBe('test-group');
      expect(Array.isArray(r.cross)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = prev;
    }
  });
});
