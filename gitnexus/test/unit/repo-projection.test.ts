/**
 * The `serve` repo-route projections (#3226).
 *
 * These exist as a separate module precisely so this file can exist: inline in
 * `createServer`, the field list was only reachable by booting a server and
 * indexing a real repository, which is how `branch` sat on `RegistryEntry`
 * unexposed over HTTP while `gitnexus list` printed it and MCP `list_repos`
 * returned staleness.
 *
 * The cases below are the ones a projection regresses on silently: a dropped
 * optional field still serializes, and a "fresh" index is indistinguishable
 * from one whose staleness check could not run unless the shape says so.
 */
import { describe, expect, it } from 'vitest';
import {
  projectRepoDetail,
  projectRepoListEntry,
  resolveLastCommit,
  stalenessField,
} from '../../src/server/repo-projection.js';
import type { StalenessInfo } from '../../src/core/git-staleness.js';
import type { RegistryEntry } from '../../src/storage/repo-manager.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

const FULL_SOURCE = { contentRetention: 'full' as const, sourceAvailable: true };

const FRESH: StalenessInfo = { isStale: false, commitsBehind: 0 };
const BEHIND: StalenessInfo = {
  isStale: true,
  commitsBehind: 3,
  hint: '⚠️ Index is 3 commits behind HEAD. Run analyze tool to update.',
};

const meta = (over: Partial<RepoMeta> = {}): RepoMeta =>
  ({
    indexedAt: '2026-09-08T12:00:00.000Z',
    lastCommit: 'ffffffffffffffffffffffffffffffffffffffff',
    branch: 'develop',
    stats: { files: 11, nodes: 111, edges: 555 },
    ...over,
  }) as RepoMeta;

const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  name: 'Hello-World',
  path: '/home/u/.gitnexus/repos/Hello-World',
  storagePath: '/home/u/.gitnexus/repos/Hello-World/.gitnexus',
  indexedAt: '2026-09-08T10:00:00.000Z',
  lastCommit: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d',
  stats: { files: 10, nodes: 100, edges: 500 },
  ...over,
});

describe('stalenessField', () => {
  it('omits the key entirely for a fresh index', () => {
    // Absence IS the "fresh" signal, matching MCP list_repos. A client must not
    // have to distinguish `undefined` from `{commitsBehind: 0}`.
    expect(stalenessField(FRESH)).toEqual({});
    expect(Object.hasOwn(stalenessField(FRESH), 'staleness')).toBe(false);
  });

  it('reports commits behind and the hint when the index is behind', () => {
    expect(stalenessField(BEHIND)).toEqual({
      staleness: { status: 'behind', commitsBehind: 3, hint: BEHIND.hint },
    });
  });

  it('reads an info built without a status as current, and omits the key', () => {
    // Hand-built and legacy infos carry no `status`; `stalenessStatus` derives
    // it from `isStale`, so a fail-open `{isStale:false}` stays a normal
    // response rather than an error on a route whose job is to list repos.
    expect(stalenessField({ isStale: false, commitsBehind: 0 })).toEqual({});
  });

  it('reports diverged with its hint and no invented count (#3256)', () => {
    // HEAD has moved off the indexed commit but the history needed to count the
    // gap is gone: the state a branch-pinned url clone reaches after gc.
    expect(
      stalenessField({ isStale: false, commitsBehind: 0, status: 'diverged', hint: 'moved on' }),
    ).toEqual({ staleness: { status: 'diverged', hint: 'moved on' } });
  });

  it('reports unknown on a listing, where a monitor is looking (#3256)', () => {
    expect(stalenessField({ isStale: false, commitsBehind: 0, status: 'unknown' })).toEqual({
      staleness: { status: 'unknown' },
    });
  });
});

describe('projectRepoListEntry — GET /api/repos', () => {
  it('exposes branch and branches, which the registry has always carried', () => {
    const out = projectRepoListEntry(
      entry({
        branch: 'master',
        branches: [{ branch: 'test', indexedAt: '2026-09-08T11:00:00.000Z', lastCommit: 'abc123' }],
      }) as RegistryEntry,
      FRESH,
      FULL_SOURCE,
    );
    expect(out.branch).toBe('master');
    expect(out.branches).toHaveLength(1);
  });

  it('distinguishes the two entries #3199 creates for one repository', () => {
    // A pinned analyze registers under its clone-directory name. Without
    // `branch`, these two are only tellable apart by parsing that slug — a
    // layout detail that is trimmed for long refs and absent for path entries.
    const primary = projectRepoListEntry(entry({ branch: 'master' }), FRESH, FULL_SOURCE);
    const pinned = projectRepoListEntry(
      entry({ name: 'Hello-World__test-9f86d081', branch: 'test' }),
      FRESH,
      FULL_SOURCE,
    );
    expect([primary.branch, pinned.branch]).toEqual(['master', 'test']);
  });

  it('keeps every field the route returned before, unchanged', () => {
    // Additive only: an existing client must not notice this change.
    const e = entry();
    const out = projectRepoListEntry(e, FRESH, FULL_SOURCE);
    expect(out).toMatchObject({
      name: e.name,
      path: e.path,
      repoPath: e.path,
      storagePath: e.storagePath,
      indexedAt: e.indexedAt,
      lastCommit: e.lastCommit,
      stats: e.stats,
      contentRetention: 'full',
      sourceAvailable: true,
    });
  });

  it('leaves branch undefined for a legacy entry that never recorded one', () => {
    const out = projectRepoListEntry(entry(), FRESH, FULL_SOURCE);
    expect(out.branch).toBeUndefined();
    expect(out.branches).toBeUndefined();
  });

  it('carries staleness through for a behind index', () => {
    expect(projectRepoListEntry(entry(), BEHIND, FULL_SOURCE).staleness).toEqual({
      status: 'behind',
      commitsBehind: 3,
      hint: BEHIND.hint,
    });
  });

  it('exposes storagePath, contentRetention, and sourceAvailable', () => {
    const e = entry();
    const out = projectRepoListEntry(e, FRESH, {
      contentRetention: 'none',
      sourceAvailable: false,
    });
    expect(out.storagePath).toBe(e.storagePath);
    expect(out.contentRetention).toBe('none');
    expect(out.sourceAvailable).toBe(false);
  });
});

describe('projectRepoDetail — GET /api/repo', () => {
  it('returns lastCommit and branch, which the route used to drop', () => {
    const out = projectRepoDetail(entry({ branch: 'master' }), null, FRESH, FULL_SOURCE);
    expect(out.lastCommit).toBe(entry().lastCommit);
    expect(out.branch).toBe('master');
  });

  it('prefers on-disk metadata over the registry entry, as indexedAt already did', () => {
    const out = projectRepoDetail(entry({ branch: 'master' }), meta(), FRESH, FULL_SOURCE);
    expect(out.indexedAt).toBe('2026-09-08T12:00:00.000Z');
    expect(out.lastCommit).toBe('ffffffffffffffffffffffffffffffffffffffff');
    expect(out.branch).toBe('develop');
  });

  it('falls back to the entry when metadata cannot be read', () => {
    const out = projectRepoDetail(entry({ branch: 'master' }), undefined, FRESH, FULL_SOURCE);
    expect(out.indexedAt).toBe(entry().indexedAt);
    expect(out.lastCommit).toBe(entry().lastCommit);
    expect(out.branch).toBe('master');
  });

  it('still returns an empty stats object rather than undefined', () => {
    // Pre-existing contract: the route returned `{}` when neither side had stats.
    expect(projectRepoDetail(entry({ stats: undefined }), null, FRESH, FULL_SOURCE).stats).toEqual(
      {},
    );
  });

  it('exposes storagePath, contentRetention, and sourceAvailable', () => {
    const e = entry();
    const out = projectRepoDetail(e, meta({ contentRetention: 'symbol' }), FRESH, {
      contentRetention: 'symbol',
      sourceAvailable: false,
    });
    expect(out).toMatchObject({
      storagePath: e.storagePath,
      contentRetention: 'symbol',
      sourceAvailable: false,
    });
  });
});

describe('resolveLastCommit', () => {
  it('measures staleness against the commit the response reports', () => {
    // If these two disagreed, the route would report one commit and compute
    // commits-behind from another — a freshness number for a different index.
    const e = entry();
    const m = meta();
    expect(resolveLastCommit(e, m)).toBe(projectRepoDetail(e, m, FRESH, FULL_SOURCE).lastCommit);
  });

  it('falls back to the registry entry with no metadata', () => {
    expect(resolveLastCommit(entry(), null)).toBe(entry().lastCommit);
  });
});
