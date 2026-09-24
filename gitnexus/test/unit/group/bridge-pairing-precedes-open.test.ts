import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The pairing verdict must be measured BEFORE anything opens `bridge.lbug`.
 *
 * An unstamped metadata file is paired to its database by write order, so the
 * answer depends on `bridge.lbug`'s mtime. Cross-repo impact and trace both open
 * that database and only afterwards ask about provenance — so on any platform
 * or LadybugDB build where a read-only open advances the file's mtime, every
 * pre-stamp bridge would report provenance-unknown from its first query onward.
 * That is the repo-wide regression the write-order rule was chosen to avoid, and
 * it would arrive as a silent downgrade rather than an error.
 *
 * Whether a given OS does that is not observable everywhere: pinning it by
 * really opening the database needs an in-process write→read reopen of the same
 * `bridge.lbug`, which is a documented Windows limitation. A test skipped on
 * Windows would leave the property unverified on exactly the platform whose
 * file semantics are most likely to differ.
 *
 * So this asserts the ordering instead of the platform's behavior. The open is
 * stubbed to advance the database's mtime — the hostile case, forced, on every
 * platform. If the verdict is taken before the open it is unaffected; if anyone
 * moves it after, this goes red on Linux, macOS and Windows alike.
 */
const openSpy = vi.fn();

vi.mock('../../../src/core/group/bridge-db.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/group/bridge-db.js')>(
    '../../../src/core/group/bridge-db.js',
  );
  return {
    ...actual,
    getCachedBridgeReadOnly: async (groupDir: string) => {
      openSpy();
      // Simulate an open that touches the database. Ten seconds ahead of the
      // metadata beside it, which under the write-order rule reads as "this
      // database is newer than the metadata describing it" — unpaired.
      const dbPath = path.join(groupDir, 'bridge.lbug');
      const future = new Date(Date.now() + 10_000);
      await fsp.utimes(dbPath, future, future);
      return { conn: {}, db: {} } as unknown as Awaited<
        ReturnType<typeof actual.getCachedBridgeReadOnly>
      >;
    },
  };
});

const { ensureBridgeReady } = await import('../../../src/core/group/cross-impact.js');
const { BRIDGE_SCHEMA_VERSION } = await import('../../../src/core/group/bridge-schema.js');

describe('the bridge pairing verdict is taken before the database is opened', () => {
  let groupDir: string;

  beforeEach(async () => {
    openSpy.mockClear();
    groupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-pair-order-'));
  });

  afterEach(async () => {
    await fsp.rm(groupDir, { recursive: true, force: true });
  });

  /** A legacy pair: unstamped metadata written after its database, as a real sync leaves it. */
  const seedUnstampedPair = async (): Promise<void> => {
    const base = new Date(1_700_000_000_000);
    await fsp.writeFile(path.join(groupDir, 'bridge.lbug'), 'db');
    await fsp.writeFile(
      path.join(groupDir, 'meta.json'),
      JSON.stringify({
        version: BRIDGE_SCHEMA_VERSION,
        generatedAt: '',
        missingRepos: [],
      }),
    );
    await fsp.utimes(path.join(groupDir, 'bridge.lbug'), base, base);
    await fsp.utimes(path.join(groupDir, 'meta.json'), base, base);
  };

  it('reports an unstamped pair as paired even when the open advances the database mtime', async () => {
    await seedUnstampedPair();

    const prep = await ensureBridgeReady(groupDir);

    expect('error' in prep).toBe(false);
    expect(openSpy).toHaveBeenCalledTimes(1);
    if ('error' in prep) throw new Error(prep.error);
    // Measured before the open, so the open's mtime bump cannot reach it.
    expect(prep.meta.pairedWithDatabase).toBe(true);
  });

  it('still reports a genuinely unpaired legacy bridge as unpaired', async () => {
    // The control. If the verdict were hardcoded or dropped, this would pass
    // vacuously alongside the case above.
    await seedUnstampedPair();
    const newer = new Date(1_700_000_060_000);
    await fsp.utimes(path.join(groupDir, 'bridge.lbug'), newer, newer);

    const prep = await ensureBridgeReady(groupDir);

    expect('error' in prep).toBe(false);
    if ('error' in prep) throw new Error(prep.error);
    expect(prep.meta.pairedWithDatabase).toBe(false);
  });
});
