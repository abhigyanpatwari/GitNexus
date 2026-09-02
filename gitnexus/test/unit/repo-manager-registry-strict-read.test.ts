import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import { readRegistry, readRegistryStrict, registerRepo } from '../../src/storage/repo-manager.js';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';
import { createTempDir } from '../helpers/test-db.js';
import { syncGroup } from '../../src/core/group/sync.js';
import type { GroupConfig } from '../../src/core/group/types.js';

// `syncGroup` is driven here through the REAL registry file and the REAL
// `defaultResolveHandle`, which is the pairing under test; only the pool is
// stubbed, so no LadybugDB index has to exist for a resolved repo to sync.
vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(async () => {}),
  executeParameterized: vi.fn(async () => []),
  pinRepo: vi.fn(() => () => {}),
  getMaxResidentRepos: vi.fn(() => 5),
}));

/**
 * `readRegistry` used to answer every failure with `[]`.
 *
 * For a listing that is harmless — an unreadable registry and an empty one look
 * the same in `gitnexus list`, and both print nothing. For a caller that *acts*
 * on emptiness it is not: `syncGroup` derives `missingRepos` from this list, and
 * an all-missing sync is allowed to write, so an EACCES after a
 * `sudo gitnexus analyze`, a truncated registry.json, or an $HOME-on-NFS blip
 * turned "I could not read the registry" into the factual claim "no repo is
 * registered" — and replaced a good contracts.json with an empty one at exit 0.
 *
 * That is an unreadable condition reported as missing: the same conflation
 * #3011 removes one stack frame further down, which is why `readRegistryStrict`
 * exists and why syncGroup is the only caller that uses it. It is a separate
 * export rather than an option on `readRegistry` so that every lenient call
 * site keeps a provably untouched signature.
 *
 * ENOENT stays lenient in both modes. No file genuinely means nothing has been
 * registered yet, and every first-run path depends on that.
 */

describe('readRegistryStrict', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;
  let registryPath: string;

  /** A row every field of which the resolution path can use. */
  const resolvableRow = () => ({
    name: 'backend-repo',
    // Deliberately inside the temp home: `syncGroup` joins `storagePath` with
    // `meta.json`, and a stray real file there would make the snapshot
    // assertion below depend on the host.
    path: path.join(tmpHome.dbPath, 'repos', 'backend'),
    storagePath: path.join(tmpHome.dbPath, 'repos', 'backend', '.gitnexus'),
    indexedAt: '2026-01-01T00:00:00.000Z',
    lastCommit: 'abc123',
  });

  const makeConfig = (repos: Record<string, string>): GroupConfig => ({
    version: 1,
    name: 'test',
    description: '',
    repos,
    links: [],
    packages: {},
    detect: {
      http: false,
      grpc: false,
      thrift: false,
      topics: false,
      includes: false,
      workspace_deps: false,
    },
    matching: {},
  });

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-registry-strict-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    registryPath = path.join(tmpHome.dbPath, 'registry.json');
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
  });

  it('returns [] for a registry that does not exist, strict or not', async () => {
    await expect(readRegistry()).resolves.toEqual([]);
    await expect(readRegistryStrict()).resolves.toEqual([]);
  });

  it('reads a valid registry identically in both modes', async () => {
    const entries = [
      {
        name: 'backend-repo',
        path: '/repos/backend',
        storagePath: '/repos/backend/.gitnexus',
        indexedAt: '2026-01-01T00:00:00.000Z',
        lastCommit: 'abc123',
      },
    ];
    await fs.writeFile(registryPath, JSON.stringify(entries));

    await expect(readRegistry()).resolves.toEqual(entries);
    await expect(readRegistryStrict()).resolves.toEqual(entries);
  });

  it('throws on a corrupt registry instead of reporting an empty one', async () => {
    await fs.writeFile(registryPath, '{"truncated": ');

    // Lenient stays lenient — existing callers keep the contract they have.
    await expect(readRegistry()).resolves.toEqual([]);
    await expect(readRegistryStrict()).rejects.toThrow();
  });

  it('registerRepo refuses to overwrite a truncated registry with a single entry', async () => {
    const prior = '{"truncated": ';
    await fs.writeFile(registryPath, prior);
    await expect(
      registerRepo('/repos/one', {
        repoPath: '/repos/one',
        lastCommit: 'abc',
        indexedAt: '2026-01-01T00:00:00.000Z',
        stats: {},
      }),
    ).rejects.toThrow('registry is corrupt');
    expect(await fs.readFile(registryPath, 'utf-8')).toBe(prior);
  });

  it('throws when a row is missing the fields the resolver needs', async () => {
    // `[{}]` is a JSON array, so an array-shape check alone waved it through.
    // Every configured repo then failed to resolve and landed in missingRepos;
    // because none produced a load ERROR the total-failure guard stayed off,
    // and a good contracts.json was replaced with an empty one at exit 0. Same
    // fail-open as an unreadable file, one level down.
    await fs.writeFile(registryPath, JSON.stringify([{}]));

    await expect(readRegistry()).resolves.toEqual([{}]);
    await expect(readRegistryStrict()).rejects.toThrow('registry is corrupt');
  });

  it('throws on a row whose required fields are the wrong type', async () => {
    await fs.writeFile(
      registryPath,
      JSON.stringify([{ name: 'backend-repo', path: 42, storagePath: '/s' }]),
    );

    await expect(readRegistryStrict()).rejects.toThrow('registry is corrupt');
  });

  it('rejects the whole registry rather than dropping the bad row', async () => {
    // Filtering would report the repos the surviving rows do not name as
    // unregistered — the unreadable-as-missing answer this mode exists to
    // refuse, reintroduced as a silent partial read.
    await fs.writeFile(
      registryPath,
      JSON.stringify([
        {
          name: 'good-repo',
          path: '/repos/good',
          storagePath: '/repos/good/.gitnexus',
          indexedAt: '2026-01-01T00:00:00.000Z',
          lastCommit: 'abc123',
        },
        {},
      ]),
    );

    await expect(readRegistryStrict()).rejects.toThrow('entry 1');
  });

  it('accepts a legacy row that omits indexedAt and lastCommit', async () => {
    // Those two are defaulted by every caller (`e?.indexedAt || ''`), so
    // demanding them would turn a fail-open into a fail-shut on real data.
    const legacy = [
      { name: 'backend-repo', path: '/repos/backend', storagePath: '/repos/backend/.gitnexus' },
    ];
    await fs.writeFile(registryPath, JSON.stringify(legacy));

    await expect(readRegistryStrict()).resolves.toEqual(legacy);
  });

  it('rejects a row whose `name` is blank, and names the offending index', async () => {
    // `typeof e.name === 'string'` is true of `''`, so a blank name walked
    // straight past the shape check and then failed to match ANY configured
    // repo in `defaultResolveHandle` — every repo landed in missingRepos, no
    // load ERROR was produced, the total-failure guard stayed off, and a good
    // contracts.json was replaced by an empty one. A field the resolution path
    // matches on cannot be blank and still identify a repo.
    const rows = [resolvableRow(), { ...resolvableRow(), name: '' }];
    await fs.writeFile(registryPath, JSON.stringify(rows));

    // Lenient keeps the contract it has: it hands the row back untouched.
    await expect(readRegistry()).resolves.toEqual(rows);
    await expect(readRegistryStrict()).rejects.toThrow('entry 1');
  });

  it('rejects a row whose `name` is whitespace only', async () => {
    await fs.writeFile(registryPath, JSON.stringify([{ ...resolvableRow(), name: '   ' }]));

    await expect(readRegistryStrict()).rejects.toThrow('registry is corrupt');
  });

  it('rejects a row whose `storagePath` is whitespace only', async () => {
    // `storagePath` is what the handle carries to `path.join(storagePath,
    // 'lbug')`. Blank, that joins to a relative `lbug` under the CWD — an
    // index that is not this repo's, opened without anyone saying so.
    await fs.writeFile(registryPath, JSON.stringify([{ ...resolvableRow(), storagePath: '  ' }]));

    await expect(readRegistry()).resolves.toHaveLength(1);
    await expect(readRegistryStrict()).rejects.toThrow('registry is corrupt');
  });

  it('accepts a row whose unused `path` is blank, and syncs the repo it names', async () => {
    // The counter-case that fixes the width of the rule. `path` is not what
    // identifies a repo, so tightening it too would trade this fail-open for a
    // fail-shut: one blank `path` anywhere in the MACHINE-WIDE registry would
    // reject the whole file and break every group sync on the machine,
    // including groups whose repos all resolve. Same principle as indexedAt /
    // lastCommit — require only what the resolution path depends on.
    const row = { ...resolvableRow(), path: '   ' };
    await fs.writeFile(registryPath, JSON.stringify([row]));

    await expect(readRegistryStrict()).resolves.toEqual([row]);

    const result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), {
      skipWrite: true,
    });

    // Resolved: not reported missing, and the snapshot carries THIS row's
    // registry metadata, which only a successful name match could supply.
    expect(result.missingRepos).toEqual([]);
    expect(result.unreadableRepos).toEqual([]);
    expect(result.repoSnapshots['app/backend']).toEqual({
      indexedAt: '2026-01-01T00:00:00.000Z',
      lastCommit: 'abc123',
    });
  });

  /**
   * A credential-shaped secret, distinctive enough that the whole failure
   * surface can be grepped for it. Synthetic — not a real token.
   */
  const REGISTRY_SECRET = 'LEAKCAN4RY';

  /**
   * A corrupt registry whose break sits directly on a credential.
   *
   * The shape is a short write landing over a longer one: the head is the new
   * content, and the tail is what was left of the old file — which resumes in
   * the middle of a remote URL's HTTPS userinfo. `registry.json` is the one
   * file every gitnexus process on the machine writes and `withRegistryLock`
   * degrades to unlocked on timeout, so two writers really can produce this.
   *
   * What matters is where the parser stops: the first byte it rejects is the
   * first byte of the credential, and V8 quotes a ten-character window either
   * side of that position into `SyntaxError.message`. Registry rows carry
   * remote URLs with userinfo verbatim (a pre-existing capture-side issue), so
   * the bytes in that window are a live secret.
   */
  const corruptRegistryOnACredential = (): string =>
    `[{"name":"backend-repo","path":"/repos/backend","storagePath":"/repos/backend/.gitnexus",` +
    `"remoteUrl":"https://gnx-bot:${REGISTRY_SECRET}@github.com/acme/backend.git"},` +
    `${REGISTRY_SECRET}@github.com/acme/backend.git"}]`;

  it('names a corrupt registry without quoting its bytes, on the throw or the log', async () => {
    // One test, every channel. A rejection an operator never sees the message
    // of is still rendered somewhere: `groupStatus` interpolates it verbatim
    // into `unresolvableReason` for an MCP client, the CLI prints it, and any
    // `logger.error({ err }, …)` on the way would serialise message, stack and
    // `cause` into the MCP client's log file on disk. So assert on all of them.
    await fs.writeFile(registryPath, corruptRegistryOnACredential());

    let cap: LoggerCapture | undefined;
    let thrown: unknown;
    try {
      cap = _captureLogger('trace');
      await readRegistryStrict();
    } catch (err) {
      thrown = err;
    } finally {
      cap?.restore();
    }
    const logged = cap?.text() ?? '';

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;

    // Channel 1: the message every renderer above reads.
    expect(error.message).not.toContain(REGISTRY_SECRET);
    // Channel 2: `cause`, which pino's error serialiser and `util.inspect`
    // both walk. Discarding the parser error means there is nothing to walk.
    expect(error.cause).toBeUndefined();
    // Channel 3: whatever a generic stringifier reaches — own properties,
    // stack, and the cause chain in one shot.
    expect(inspect(error, { depth: null })).not.toContain(REGISTRY_SECRET);
    // Channel 4: the log. Nothing is logged here at all, and the assertion
    // holds the line against "log the Error object" being added later.
    expect(logged).not.toContain(REGISTRY_SECRET);

    // And it still says what failed. Host-independent: the raw parser error
    // names neither the path nor the failure class, on any V8.
    expect(error.message).toContain(registryPath);
    expect(error.message).toContain('registry is corrupt');
  });

  it('still reports that same credential-bearing registry as empty on the lenient path', async () => {
    // The guarded parse must not change what lenient callers see: `gitnexus
    // list` and the eight other lenient sites still get `[]`, not a throw.
    await fs.writeFile(registryPath, corruptRegistryOnACredential());

    await expect(readRegistry()).resolves.toEqual([]);
  });

  it('throws when the registry parses but is not an array', async () => {
    // A JSON object here is corruption too, and it is the shape most likely to
    // survive a partial write: `[]` is what the lenient path would return, which
    // is indistinguishable from a registry that really has no entries.
    await fs.writeFile(registryPath, '{"repos": []}');

    await expect(readRegistry()).resolves.toEqual([]);
    await expect(readRegistryStrict()).rejects.toThrow('not a JSON array');
  });
});
