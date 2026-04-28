import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  validateGroupImpactParams,
  runGroupImpact,
  MAX_SUPPORTED_CROSS_DEPTH,
  DEFAULT_LOCAL_IMPACT_TIMEOUT_MS,
  collectImpactSymbolUids,
  fileMatchesServicePrefix,
} from '../../../src/core/group/cross-impact.js';
import type { GroupToolPort } from '../../../src/core/group/service.js';
import { writeBridgeMeta } from '../../../src/core/group/bridge-db.js';
import { BRIDGE_SCHEMA_VERSION } from '../../../src/core/group/bridge-schema.js';

function tmpGroup(): { tmpDir: string; groupDir: string; cleanup: () => void } {
  const tmpDir = path.join(os.tmpdir(), `gitnexus-ci-${Date.now()}-${Math.random()}`);
  const groupDir = path.join(tmpDir, 'groups', 'g1');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: g1
description: ""
repos:
  app/backend: reg-be
  app/frontend: reg-fe
links: []
packages: {}
detect:
  http: true
  grpc: true
  topics: true
  shared_libs: true
  embedding_fallback: true
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`,
  );
  return {
    tmpDir,
    groupDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe('cross-impact', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('test_validateGroupImpactParams_rejects_bad_direction', () => {
    const r = validateGroupImpactParams({
      name: 'g',
      repo: 'a',
      target: 't',
      direction: 'sideways',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('direction');
  });

  it('test_validateGroupImpactParams_clamps_crossDepth_and_warns', () => {
    const r = validateGroupImpactParams({
      name: 'g',
      repo: 'a',
      target: 't',
      direction: 'upstream',
      crossDepth: 99,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.crossDepth).toBe(MAX_SUPPORTED_CROSS_DEPTH);
      expect(r.crossDepthWarning).toBeDefined();
    }
  });

  it('test_validateGroupImpactParams_default_timeout', () => {
    const r = validateGroupImpactParams({
      name: 'g',
      repo: 'a',
      target: 't',
      direction: 'downstream',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.timeoutMs).toBe(DEFAULT_LOCAL_IMPACT_TIMEOUT_MS);
  });

  it('test_collectImpactSymbolUids_respects_service_prefix', () => {
    const local = {
      target: { id: 'a', filePath: 'services/auth/x.ts' },
      byDepth: {
        1: [{ id: 'b', filePath: 'other/y.ts' }],
      },
    };
    const uids = collectImpactSymbolUids(local, 'services/auth').uids;
    expect(uids).toContain('a');
    expect(uids).not.toContain('b');
  });

  it('test_fileMatchesServicePrefix', () => {
    expect(fileMatchesServicePrefix('services/auth/a.ts', 'services/auth')).toBe(true);
    expect(fileMatchesServicePrefix('services/aut', 'services/auth')).toBe(false);
  });

  it('test_runGroupImpact_local_timeout_returns_truncation', async () => {
    const { tmpDir, cleanup } = tmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      let impactCalls = 0;
      const port: GroupToolPort = {
        resolveRepo: vi.fn(async () => ({
          id: 'be',
          name: 'reg-be',
          repoPath: '/r',
          storagePath: '/r/.gitnexus',
        })),
        impact: vi.fn(async () => {
          impactCalls++;
          await new Promise((r) => setTimeout(r, 200));
          return { summary: { direct: 1 }, byDepth: { 1: [{ id: 'x' }] } };
        }),
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      const r = await runGroupImpact(
        { port, gitnexusDir: tmpDir },
        {
          name: 'g1',
          repo: 'app/backend',
          target: 'Sym',
          direction: 'upstream',
          timeoutMs: 15,
        },
      );
      expect(impactCalls).toBe(1);
      expect('error' in r).toBe(false);
      if (!('error' in r)) {
        expect(r.truncationReason).toBe('timeout');
        expect(r.truncated).toBe(true);
      }
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('test_runGroupImpact_local_phase_error_bubbles_as_top_level_error', async () => {
    // Regression for #1004: when the local-impact phase returns a structured
    // `{ error: ... }` payload, groupImpact MUST surface it as a top-level
    // `{ error }` instead of a zero-hit GroupImpactResult. Otherwise callers
    // that branch on top-level `error` silently treat a failed analysis as
    // "no impact across the group" — a false negative on the failure path
    // of a blast-radius tool.
    const { tmpDir, cleanup } = tmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const port: GroupToolPort = {
        resolveRepo: vi.fn(async () => ({
          id: 'be',
          name: 'reg-be',
          repoPath: '/r',
          storagePath: '/r/.gitnexus',
        })),
        impact: vi.fn(async () => ({ error: 'symbol not found: Sym' })),
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      const r = await runGroupImpact(
        { port, gitnexusDir: tmpDir },
        {
          name: 'g1',
          repo: 'app/backend',
          target: 'Sym',
          direction: 'upstream',
        },
      );
      expect('error' in r).toBe(true);
      if ('error' in r) {
        expect(r.error).toContain('symbol not found: Sym');
        expect(r.error).toContain('app/backend');
      }
      // And ensure we didn't silently fall back to a zero-hit success payload.
      expect((r as { summary?: unknown }).summary).toBeUndefined();
      expect((r as { cross?: unknown }).cross).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('test_runGroupImpact_local_phase_thrown_exception_bubbles_as_top_level_error', async () => {
    // Companion to the #1004 regression: safeLocalImpact wraps thrown
    // exceptions from port.impact() as `{ error }` payloads. Those must
    // bubble to the caller as top-level errors too, not be swallowed into
    // an empty success payload.
    const { tmpDir, cleanup } = tmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const port: GroupToolPort = {
        resolveRepo: vi.fn(async () => ({
          id: 'be',
          name: 'reg-be',
          repoPath: '/r',
          storagePath: '/r/.gitnexus',
        })),
        impact: vi.fn(async () => {
          throw new Error('graph-load failure: .gitnexus missing');
        }),
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      const r = await runGroupImpact(
        { port, gitnexusDir: tmpDir },
        {
          name: 'g1',
          repo: 'app/backend',
          target: 'Sym',
          direction: 'upstream',
        },
      );
      expect('error' in r).toBe(true);
      if ('error' in r) {
        expect(r.error).toContain('graph-load failure');
      }
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('test_runGroupImpact_bridge_schema_mismatch_returns_error', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    await writeBridgeMeta(groupDir, {
      version: BRIDGE_SCHEMA_VERSION + 9,
      generatedAt: new Date().toISOString(),
      missingRepos: [],
    });
    try {
      const port: GroupToolPort = {
        resolveRepo: vi.fn(async () => ({
          id: 'be',
          name: 'reg-be',
          repoPath: '/r',
          storagePath: '/r/.gitnexus',
        })),
        impact: vi.fn(async () => ({
          target: { id: 'u1', filePath: 'src/a.ts' },
          summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
          byDepth: { 1: [{ id: 'u1', filePath: 'src/a.ts' }] },
          risk: 'LOW',
        })),
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      const r = await runGroupImpact(
        { port, gitnexusDir: tmpDir },
        {
          name: 'g1',
          repo: 'app/backend',
          target: 'Sym',
          direction: 'upstream',
        },
      );
      expect('error' in r).toBe(true);
      if ('error' in r) {
        expect(r.error).toContain('schema');
      }
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });
});
