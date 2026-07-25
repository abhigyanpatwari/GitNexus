/**
 * Skip-and-warn behavior of the moveIngest phase (#2624).
 *
 * A Move package that move-flow cannot build must not abort the whole analyze:
 * the phase skips it (files stay un-ingested, like the empty-facts path),
 * records a `package-build-failed` warning, and surfaces it via
 * `ingestWarnings` for the persistent CLI summary. GITNEXUS_MOVE_STRICT=1
 * restores the historical fatal behavior. `_` placeholder addresses in
 * Move.toml are caught pre-flight (`unresolved-named-address`) without
 * spending a compile. Packages whose build carries compiler errors but still
 * serve facts are ingested WITH a `degraded-package-facts` warning, because
 * move-flow silently drops `acquiresInferred` from erroring builds.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { MoveFlowToolCallError, type MoveFlowClient } from '../../../src/core/move/mcp-client.js';
import { runMoveIngestPhase } from '../../helpers/move-ingest-harness.js';

const REPO_ROOT = path.resolve('/repo');

function makeClient(overrides: Partial<MoveFlowClient> = {}): MoveFlowClient {
  return {
    facts: async () => ({}),
    callGraph: async () => ({}),
    packageStatus: async () => ({ ok: true, diagnostics: 'no errors or warnings' }),
    capabilities: async () => ({ hasFactsQuery: true, hasStatusTool: true }),
    shutdown: async () => {},
    ...overrides,
  };
}

/** Minimal non-empty facts map for a package rooted at `pkgDir` (absolute). */
function factsFor(pkgDir: string, moduleQn = '0xa::m') {
  return {
    [moduleQn]: {
      file: path.join(pkgDir, 'sources', 't.move'),
      span: [1, 3] as [number, number],
      friends: [],
      attributes: [],
      functions: [],
      structs: [],
      constants: [],
    },
  };
}

afterEach(() => {
  delete process.env.GITNEXUS_MOVE_STRICT;
});

describe('moveIngest skip-and-warn on build failure', () => {
  it('skips the broken package, keeps the rest, and surfaces a warning', async () => {
    const brokenRoot = path.join(REPO_ROOT, 'broken');
    const goodRoot = path.join(REPO_ROOT, 'good');
    const client = makeClient({
      callGraph: async (pkg) => {
        if (pkg === brokenRoot) {
          throw new MoveFlowToolCallError(
            'failed to build package `broken`: Unresolved addresses found: [abi]',
          );
        }
        return {};
      },
      facts: async (pkg) => (pkg === goodRoot ? factsFor(goodRoot) : {}),
    });

    const output = await runMoveIngestPhase(client, REPO_ROOT, [
      'broken/Move.toml',
      'broken/sources/b.move',
      'good/Move.toml',
      'good/sources/t.move',
    ]);

    // The good package is fully ingested; the broken one has zero footprint.
    expect(output.ingestedFiles.has('good/sources/t.move')).toBe(true);
    expect(output.ingestedFiles.has('broken/sources/b.move')).toBe(false);
    expect(output.callGraphByPackage.has(brokenRoot)).toBe(false);
    expect(output.externalNodeSnapshotComplete).toBe(false);

    const issues = output.consistencyIssues.filter((i) => i.code === 'package-build-failed');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('Unresolved addresses found');
    expect(issues[0].message).toContain('.gitnexusignore');
    expect(issues[0].details?.packageRoot).toBe(brokenRoot);

    // The warning reaches the neutral CLI-summary channel.
    expect(output.ingestWarnings?.some((w) => w.includes('move-flow could not build'))).toBe(true);
  });

  it('GITNEXUS_MOVE_STRICT=1 restores the fatal behavior', async () => {
    process.env.GITNEXUS_MOVE_STRICT = '1';
    const client = makeClient({
      callGraph: async () => {
        throw new MoveFlowToolCallError('failed to build package `pkg`: boom');
      },
    });

    await expect(
      runMoveIngestPhase(client, REPO_ROOT, ['pkg/Move.toml', 'pkg/sources/t.move']),
    ).rejects.toThrow(/move-flow could not build Move package/);
  });

  it('non-tool-call errors still abort (transport faults are not skippable)', async () => {
    const client = makeClient({
      callGraph: async () => {
        throw new Error('move-flow exited unexpectedly (code 137)');
      },
    });

    await expect(
      runMoveIngestPhase(client, REPO_ROOT, ['pkg/Move.toml', 'pkg/sources/t.move']),
    ).rejects.toThrow(/exited unexpectedly/);
  });
});

describe('moveIngest placeholder-address pre-flight', () => {
  let tmpRepo: string | undefined;

  afterEach(async () => {
    if (tmpRepo) await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  });

  async function writeManifest(addressesSection: string): Promise<string> {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-move-preflight-'));
    const pkgDir = path.join(tmpRepo, 'pkg');
    await mkdir(path.join(pkgDir, 'sources'), { recursive: true });
    await writeFile(
      path.join(pkgDir, 'Move.toml'),
      `[package]\nname = "P"\nversion = "1.0.0"\n\n${addressesSection}\n`,
      'utf8',
    );
    await writeFile(path.join(pkgDir, 'sources', 't.move'), 'module 0x1::t {}\n', 'utf8');
    return tmpRepo;
  }

  it('skips a package whose [addresses] holds "_" placeholders without building it', async () => {
    const repo = await writeManifest(
      `[addresses]\neconia = "_"\nuser = "0x1234"\n\n[dev-addresses]\neconia = "0xff"`,
    );
    let buildCalls = 0;
    const client = makeClient({
      callGraph: async () => {
        buildCalls += 1;
        return {};
      },
    });

    const output = await runMoveIngestPhase(client, repo, ['pkg/Move.toml', 'pkg/sources/t.move']);

    expect(buildCalls).toBe(0);
    const issues = output.consistencyIssues.filter((i) => i.code === 'unresolved-named-address');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('econia');
    expect(issues[0].message).toContain('.gitnexusignore');
    expect(issues[0].details?.placeholders).toEqual(['econia']);
    expect(output.ingestedFiles.size).toBe(0);
    expect(output.ingestWarnings?.some((w) => w.includes('"_"'))).toBe(true);
  });

  it('builds normally when every named address is concrete', async () => {
    const repo = await writeManifest(`[addresses]\neconia = "0xc0deb00c"\nuser = "0x1234"`);
    let buildCalls = 0;
    const pkgDir = path.join(repo, 'pkg');
    const client = makeClient({
      callGraph: async () => {
        buildCalls += 1;
        return {};
      },
      facts: async () => factsFor(pkgDir, '0xc0deb00c::t'),
    });

    const output = await runMoveIngestPhase(client, repo, ['pkg/Move.toml', 'pkg/sources/t.move']);

    expect(buildCalls).toBe(1);
    expect(
      output.consistencyIssues.filter((i) => i.code === 'unresolved-named-address'),
    ).toHaveLength(0);
    expect(output.ingestedFiles.has('pkg/sources/t.move')).toBe(true);
    expect(output.externalNodeSnapshotComplete).toBe(true);
  });
});

describe('moveIngest degraded-build detection', () => {
  it('ingests but warns when the build has compiler errors (acquires may be missing)', async () => {
    const pkgRoot = path.join(REPO_ROOT, 'pkg');
    const diagnostics =
      'error: property `map_add_all` is not valid in this context\n  spec pragma ...';
    const client = makeClient({
      facts: async () => factsFor(pkgRoot),
      packageStatus: async () => ({ ok: false, diagnostics }),
    });

    const output = await runMoveIngestPhase(client, REPO_ROOT, [
      'pkg/Move.toml',
      'pkg/sources/t.move',
    ]);

    // Still ingested — degraded fidelity is a warning, not a skip.
    expect(output.ingestedFiles.has('pkg/sources/t.move')).toBe(true);

    const issues = output.consistencyIssues.filter((i) => i.code === 'degraded-package-facts');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('acquires');
    expect(issues[0].message).toContain('map_add_all');
    expect(output.ingestWarnings?.some((w) => w.includes('compiled with errors'))).toBe(true);
  });

  it('emits no degraded warning when the build is clean', async () => {
    const pkgRoot = path.join(REPO_ROOT, 'pkg');
    const client = makeClient({ facts: async () => factsFor(pkgRoot) });

    const output = await runMoveIngestPhase(client, REPO_ROOT, [
      'pkg/Move.toml',
      'pkg/sources/t.move',
    ]);

    expect(
      output.consistencyIssues.filter((i) => i.code === 'degraded-package-facts'),
    ).toHaveLength(0);
    expect(output.ingestWarnings).toEqual([]);
  });

  it('tolerates a missing status tool (no probe, no warning, no throw)', async () => {
    const pkgRoot = path.join(REPO_ROOT, 'pkg');
    let statusCalls = 0;
    const client = makeClient({
      facts: async () => factsFor(pkgRoot),
      capabilities: async () => ({ hasFactsQuery: true, hasStatusTool: false }),
      packageStatus: async () => {
        statusCalls += 1;
        return { ok: false, diagnostics: 'should not be called' };
      },
    });

    const output = await runMoveIngestPhase(client, REPO_ROOT, [
      'pkg/Move.toml',
      'pkg/sources/t.move',
    ]);

    expect(statusCalls).toBe(0);
    expect(
      output.consistencyIssues.filter((i) => i.code === 'degraded-package-facts'),
    ).toHaveLength(0);
  });
});
