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
      expect(r).toMatchObject({
        truncated: true,
        truncationReason: 'timeout',
        // The marker travels with `truncated` on EVERY return path, not just
        // the terminal one — see the invariant table below (#2787).
        riskEpistemic: 'lower-bound',
      });
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

  /**
   * `truncated: true` ⇒ `riskEpistemic: 'lower-bound'`, on every return path.
   *
   * `riskEpistemic` is the only field that tells a consumer the `risk` value is
   * a floor rather than a verdict, and the MCP tool description now instructs
   * callers to key on it. Two of `runGroupImpact`'s four returns used to set
   * `truncated` without it — and the `uids.length === 0` path returns a REAL
   * risk (not `UNKNOWN`), so a truncated analysis read as a complete `HIGH`.
   *
   * Every case below returns before the bridge is opened, so no bridge mock is
   * involved; the local port shape alone decides which return is taken.
   */
  const runLocalOnlyImpact = async (
    impact: GroupToolPort['impact'],
    params: Record<string, unknown> = {},
  ): Promise<unknown> => {
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
        impact,
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      return await runGroupImpact(
        { port, gitnexusDir: tmpDir },
        {
          name: 'g1',
          repo: 'app/backend',
          target: 'Sym',
          direction: 'upstream',
          ...params,
        },
      );
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  };

  type LocalReturnCase = {
    name: string;
    impact: GroupToolPort['impact'];
    params: Record<string, unknown>;
    expected: Record<string, unknown>;
  };

  const truncatedReturns: LocalReturnCase[] = [
    {
      name: 'the local walk times out',
      // Resolves later than the (clamped) budget, so the timeout arm of the
      // race wins on any host — the assertion is on the returned shape, never
      // on how long it took.
      impact: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { summary: { direct: 1 }, byDepth: { 1: [{ id: 'x' }] } };
      },
      params: { timeoutMs: 15 },
      expected: {
        truncated: true,
        truncationReason: 'timeout',
        riskEpistemic: 'lower-bound',
        risk: 'UNKNOWN',
      },
    },
    {
      name: 'a partial local walk yields no symbol uids',
      impact: async () => ({
        partial: true,
        byDepth: {},
        summary: { direct: 4, processes_affected: 2, modules_affected: 1 },
        risk: 'HIGH',
      }),
      params: {},
      expected: {
        truncated: true,
        truncationReason: 'partial',
        riskEpistemic: 'lower-bound',
        // A real risk, not UNKNOWN: without the marker this reads as a
        // complete HIGH verdict on a walk that never finished.
        risk: 'HIGH',
        summary: { direct: 4, processes_affected: 2, modules_affected: 1 },
      },
    },
  ];

  const completeReturns: LocalReturnCase[] = [
    {
      name: 'a complete local walk yields no symbol uids',
      impact: async () => ({
        byDepth: {},
        summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
        risk: 'HIGH',
      }),
      params: {},
      expected: { truncated: false, risk: 'HIGH' },
    },
    {
      name: 'the target sits outside the requested service prefix',
      impact: async () => ({
        target: { id: 'u1', filePath: 'src/other.ts' },
        byDepth: {},
        summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
        risk: 'HIGH',
      }),
      params: { service: 'services/auth' },
      expected: { truncated: false, risk: 'LOW' },
    },
  ];

  it.each(truncatedReturns)(
    'marks risk as a lower bound when $name',
    async ({ impact, params, expected }) => {
      const r = await runLocalOnlyImpact(impact, params);

      expect(r).toMatchObject(expected);
    },
  );

  it.each(completeReturns)('claims no floor when $name', async ({ impact, params, expected }) => {
    const r = await runLocalOnlyImpact(impact, params);

    expect(r).toMatchObject(expected);
    expect(r).not.toHaveProperty('riskEpistemic');
    expect(r).not.toHaveProperty('truncationReason');
  });

  it('lifts local riskSharedAxes and riskScale when there are no symbol uids to fan out', async () => {
    const riskScale = {
      comparableAcrossKinds: false,
      unusedAxes: [
        {
          axis: 'processes' as const,
          reason: 'file-nodes-have-no-process-or-community-membership',
        },
        {
          axis: 'modules',
          reason: 'file-nodes-have-no-process-or-community-membership',
        },
      ],
    };
    const r = await runLocalOnlyImpact(async () => ({
      byDepth: {},
      summary: { direct: 13, processes_affected: 0, modules_affected: 0 },
      risk: 'MEDIUM',
      riskSharedAxes: 'MEDIUM',
      riskScale,
    }));
    expect(r).toMatchObject({
      truncated: false,
      risk: 'MEDIUM',
      riskSharedAxes: 'MEDIUM',
      riskScale,
    });
  it('test_runGroupImpact_threads_target_selectors_to_member_impact', async () => {
    // The target_uid disambiguation loop is a three-segment chain: the MCP
    // boundary forwards target_uid/file_path/kind, the GroupToolPort.impact
    // contract declares them, and THIS module must thread them into the
    // member-repo call. The first wiring attempt only touched the boundary
    // and the port type — validateGroupImpactParams dropped the params, so
    // port.impact never saw them and the loop silently did not work. The
    // spy pins the full chain end to end.
    const impact = vi.fn(async () => ({
      byDepth: {},
      summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
      risk: 'LOW',
    }));
    const r = await runLocalOnlyImpact(impact, {
      target_uid: 'sym::uid::1',
      file_path: 'src/service/UserApi.ts',
      kind: 'Class',
    });

    expect(r).toMatchObject({ truncated: false });
    expect(impact).toHaveBeenCalledTimes(1);
    expect(impact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: 'Sym',
        target_uid: 'sym::uid::1',
        file_path: 'src/service/UserApi.ts',
        kind: 'Class',
      }),
    );
  });

  it('test_runGroupImpact_omits_target_selectors_when_absent', async () => {
    // Companion negative: a plain name-only call must not smuggle empty
    // selector strings through (the port treats '' as a real lookup key).
    const impact = vi.fn(async () => ({
      byDepth: {},
      summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
      risk: 'LOW',
    }));
    await runLocalOnlyImpact(impact, { target_uid: '' });

    expect(impact).toHaveBeenCalledTimes(1);
    const passed = (impact as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as Record<string, unknown>;
    expect(passed.target_uid).toBeUndefined();
    expect(passed.file_path).toBeUndefined();
    expect(passed.kind).toBeUndefined();
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

  it('hints the yaml member path when --repo is the registry alias', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-ci-alias-'));
    const groupDir = path.join(tmpDir, 'groups', 'g1');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'group.yaml'),
      `version: 1
name: g1
repos:
  demo/api: demo-api
  demo/web: demo-web
`,
    );
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const port: GroupToolPort = {
        resolveRepo: vi.fn(),
        impact: vi.fn(),
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      const r = await runGroupImpact(
        { port, gitnexusDir: tmpDir },
        {
          name: 'g1',
          repo: 'demo-api',
          target: 'Sym',
          direction: 'upstream',
        },
      );
      expect('error' in r).toBe(true);
      if ('error' in r) {
        expect(r.error).toContain('demo/api');
        expect(r.error).toMatch(/registry alias/i);
        expect(r.error).not.toContain('demo/web');
      }
      const mixedCase = await runGroupImpact(
        { port, gitnexusDir: tmpDir },
        {
          name: 'g1',
          repo: 'Demo-API',
          target: 'Sym',
          direction: 'upstream',
        },
      );
      expect('error' in mixedCase).toBe(true);
      if ('error' in mixedCase) {
        expect(mixedCase.error).toContain('demo/api');
      }
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('lists every member path that shares the same registry alias', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-ci-alias-dup-'));
    const groupDir = path.join(tmpDir, 'groups', 'g1');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'group.yaml'),
      `version: 1
name: g1
repos:
  demo/api: shared
  demo/other: shared
`,
    );
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const port: GroupToolPort = {
        resolveRepo: vi.fn(),
        impact: vi.fn(),
        query: vi.fn(),
        impactByUid: vi.fn(),
        context: vi.fn(),
      };
      const r = await runGroupImpact(
        { port, gitnexusDir: tmpDir },
        {
          name: 'g1',
          repo: 'shared',
          target: 'Sym',
          direction: 'upstream',
        },
      );
      expect('error' in r).toBe(true);
      if ('error' in r) {
        expect(r.error).toContain('demo/api');
        expect(r.error).toContain('demo/other');
      }
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
