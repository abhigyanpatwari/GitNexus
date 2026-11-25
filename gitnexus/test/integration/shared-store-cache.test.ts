import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withStoreLock } from '../../src/storage/shared-store-lifecycle.js';
import { sharedStoreLayout } from '../../src/storage/shared-store.js';
import { createTempDir } from '../helpers/test-db.js';

// These suites exercise sharing; an inherited opt-out would silently disable it.
const savedSharedStoreSwitch = process.env.GITNEXUS_SHARED_STORE;
beforeAll(() => {
  delete process.env.GITNEXUS_SHARED_STORE;
});
afterAll(() => {
  if (savedSharedStoreSwitch === undefined) delete process.env.GITNEXUS_SHARED_STORE;
  else process.env.GITNEXUS_SHARED_STORE = savedSharedStoreSwitch;
});

describe('withStoreLock', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-test-store-lock-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  it('runs same-named sections one at a time', async () => {
    const layout = sharedStoreLayout('repo-0123456789ab', '/tmp/checkout');
    const events: string[] = [];
    const section = (name: string) => async () => {
      events.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 50));
      events.push(`${name}:end`);
    };
    await Promise.all([
      withStoreLock(layout, 'cache', section('one')),
      withStoreLock(layout, 'cache', section('two')),
    ]);
    expect(events[1]).toBe(`${events[0].split(':')[0]}:end`);
    expect(events[3]).toBe(`${events[2].split(':')[0]}:end`);
  });
});
